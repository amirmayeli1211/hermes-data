# `ghstore` — GitHub-backed durable Hermes state

A self-contained tool (`tool/ghstore.py`, ~1560 lines, ships itself into the
repo so a fresh container can bootstrap from it) that treats a GitHub repo as
the primary home of durable Hermes state. The container filesystem is a
rebuildable cache.

```
<repo>/
  state/          config.yaml, memories/, skills/, cron/ (+ scripts), plans, hooks, projects/
  state/manifest.json   per-file sha256 + size index (the integrity record)
  tool/           ghstore.py + bootstrap/reconcile/offload/archive scripts
  projects/       product source code kept off the container disk
```

`state/manifest.json` is gitignored on the local side (regenerated each push).

## Verbs

| Verb | What it does |
|---|---|
| `doctor` | credential source, auth identity, repo/private/branch, push permission, syncable file count, excluded entries, secret scan (blocking + warnings), API calls made |
| `plan` | path mapping and scope, **no network writes** |
| `status` | local vs repo drift (files the repo has that the container doesn't) |
| `audit` | classifies **every** local file as in-repo / excluded / unclassified and **fails on unclassified** — that bucket is the silent data-loss gap |
| `push` | collect → secret gate → commit whole tree atomically → verify |
| `verify` | read every remote blob back and compare sha256 against the manifest |
| `pull` | restore state into `$HERMES_HOME` (safe by default) |

## Credential resolution (order matters)

1. `--token`, `GHSTORE_TOKEN`/`GITHUB_TOKEN`/`GH_TOKEN` in the environment
2. `$HERMES_HOME/.ghfirst/token` — local sidecar, never synced, **raw token
   only** (the file's whole content is the token; `KEY=VALUE` written here is
   used verbatim and fails auth)
3. `$HERMES_HOME/.env` — canonical when the platform injects `GITHUB_TOKEN`,
   but the container entrypoint regenerates `.env` on boot, so a hand-appended
   line vanishes after a restart. That is exactly why layer 2 exists.

```bash
mkdir -p "$HERMES_HOME/.ghfirst"
printf '%s\n' "$TOKEN" > "$HERMES_HOME/.ghfirst/token"   # raw, no KEY=
chmod 600 "$HERMES_HOME/.ghfirst/token"
```

Git side: `git config --global credential.helper "store --file=/root/.git-credentials"`
with `https://x-access-token:<token>@github.com` in that file (0600). Anything
that reads the token from a file keeps the PAT out of command lines, shell
history, and tool-output redaction noise.

## Push semantics you must know before replacing content

- The push is computed **from the local tree**, so a half-populated or wrong
  `HERMES_HOME` looks identical to "the user deleted 330 files". Deletions are
  therefore gated: refused when `> DELETION_ABS_LIMIT` or above
  `DELETION_RATIO_LIMIT` unless `--allow-deletions`. Intentional wholesale
  replacement (e.g. "wipe the old instance's data, publish ours") is the one
  legitimate use — confirm the local scope first, then pass the flag.
- Only blobs whose content differs from the remote are uploaded, and the
  manifest is written last so it never indexes content the commit lacks.
- A conflict gate aborts when a path changed both locally and remotely since
  the last sync (`--force` overrides after inspection).
- No-changes runs print `no changes since the last sync — nothing to commit.`
  and exit 0 — useful as the silent-path marker for a cron wrapper.

## The secret gate, and how to store a config that contains keys

`SECRET_BLOCK_PATTERNS` covers GitHub PATs, `sk-…`, `xai-…`, Google keys, AWS
keys, Slack/npm/PyPI tokens, Telegram bot tokens, JWTs, bearer tokens, DB URIs
with passwords, PEM blocks, and a generic `credential-assignment`
(`api_key:`/`token=`/`password:` followed by 16+ chars). Placeholder-shaped
matches (`xxx…`, `<YOUR_KEY>`, `${VAR}`, `redacted`) are ignored so skill
documentation stays pushable. Any **blocking** finding aborts the whole push.

A live `config.yaml` with `custom_providers` almost always carries inline
`api_key:` values, so it can never be stored verbatim. The patch pattern that
works — and stays fail-closed:

1. `collect_local()` returns the file set unchanged.
2. Run the gate. For each file the gate **flags**, blank the *values* of
   credential-shaped assignment lines (regex anchored to `^\s*[- ]*key…[:=]`
   with an 8+ char, non-space value), leaving the key names and every other
   file byte-exact.
3. Re-run the gate on the rewritten set and keep *that* result: a finding the
   redactor cannot clear (a bare token with no assignment form) must still
   abort.
4. Record each rewritten file in the manifest (`redactions[]`,
   `redaction_count`) and say so in the generated README, so a restore knows
   which credentials must be re-entered.

Blanking only gate-flagged files matters: a blanket "credential line" pass
touched 26 files (skill scripts, docs examples) on the first attempt versus the
1 file that actually needed it.

Verify a patch like this with the repo's own tests (`python3 -m pytest
tool/tests/ -q`, 7 tests) plus `doctor` showing `redacted before push: N` and
`secret scan: blocking=0`.

## Concurrent writers

Two Hermes instances pushing to the same repo collide. Symptoms, in order:

- `HTTP 403` with 60 s backoff retries while creating blobs (secondary rate
  limit, made worse by the other writer),
- then `HTTP 422 … "Update is not a fast forward"` on
  `PATCH /repos/<r>/git/refs/heads/main`, because the branch advanced during
  the multi-minute upload.

The remote's commit log is the evidence — `GET /repos/<r>/commits?per_page=8`
with committer dates exposed a second host committing `sync: N files from
<other-host>` every ~31 minutes. Options: give each instance its own branch
(`ghstore push --branch <host>`), or retire the other instance. Do not ping-pong
`main`.

## Auto-sync (silent on success)

`~/.hermes/scripts/ghstore_sync.sh`, registered as a `no_agent` cron job every
30 minutes. Contract: success prints **nothing**; only failures speak (empty
stdout means the scheduler sends no message at all).

```bash
out=$(HERMES_HOME="$HOME_DIR" python3 "$STORE/tool/ghstore.py" push --repo "$REPO" 2>&1)
rc=$?
printf '[%s] rc=%s\n%s\n' "$(date -u +%FT%TZ)" "$rc" "$out" >> "$LOG"
[ "$rc" -eq 0 ] && exit 0                      # includes "no changes since the last sync"
echo "hermes-data sync FAILED (exit $rc)"; echo "$out" | tail -12; exit "$rc"
```

Keep the log bounded (`tail -2000` when it exceeds ~4000 lines) — the repo
itself is the durable record. `cronjob(action="create", no_agent=True,
script="ghstore_sync.sh")` — the script argument must be a bare filename.

## Offload ("second disk") scripting

The same repo ships `tool/offload.sh` / `archive.sh` for moving files that are
not needed on the primary disk into the repo (with `.offloaded/` markers so they
can be fetched on demand). Worth reaching for when disk pressure is the problem,
rather than deleting state that the container cannot rebuild.
