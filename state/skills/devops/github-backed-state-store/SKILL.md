---
name: github-backed-state-store
description: "Keep an agent host's durable state in a private GitHub repo (the \"second disk\"): mirror pushes, integrity manifests, credential-safe commits, restore into a fresh container, and safe operation when another instance shares the repo."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [github, backup, durable-state, ghstore, restore, cron, git, second-disk]
    related_skills: [hermes-gateway-no-systemd, native-mcp]
---

# GitHub-backed durable state (the "second disk")

## When to use this

The user says the container disk is small/can be lost and wants state, skills,
scripts, cron jobs and project code kept in a **private GitHub repo** instead;
asks to "restore into a fresh container"; or asks for something to be "always
updated" off-host. The pattern: **the container filesystem is a rebuildable
cache, the repo is the source of truth.**

On the host this was built for, the working copy lives at `~/hermes-data` with
`tool/ghstore.py` (plus `tool/*.sh`) and the automation in
`~/.hermes/scripts/ghstore_sync.sh` + `ghstore_safety_branch.py`. Read the tool's
`--help` on the host before assuming the flags below — but the model is stable.

## The model

- `state/` mirrors a **selected subset** of `$HERMES_HOME` (config, memories,
  skills, plans, hooks, plugins, skins, scripts, cron jobs + output, lsp
  manifests). `tool/` ships the restore path itself, so a fresh container can
  bootstrap from the repo alone. `projects/` holds real product source code.
- `state/manifest.json` is the integrity record: per-file sha256 + size. `verify`
  reads every remote blob back against it. Treat the manifest as the authority,
  not the working tree.
- **Never stored, by design:** the env/credential file, `auth.json`, every `*.db`
  (session transcripts, kanban, cron executions), logs, caches, locks.
- Credential resolution order: `--token` → `GITHUB_TOKEN`/`GHSTORE_TOKEN`/`GH_TOKEN`
  → `$HERMES_HOME/.ghfirst/token` (**raw token**, local-only sidecar) →
  `$HERMES_HOME/.env` as `KEY=VALUE`. The sidecar exists because a container
  entrypoint can **regenerate `.env` on boot**, silently losing a token appended
  by hand.

## Commands

```bash
HERMES_HOME=<hermes home> python3 tool/ghstore.py doctor     # credential, repo, perms, scope, scan
… plan        # path mapping + what would sync, no network writes
… status      # local vs repo drift
… audit       # classifies EVERY home file: in-repo / excluded / unclassified (fails on the third)
… push        # atomic whole-tree commit, then verify
… verify      # remote blobs vs manifest
… pull        # restore into HERMES_HOME (safe by default)
```

`bootstrap.sh` is the fresh-container entry point (clone or fetch the tool, then
delegate to `pull`). Run a **read-only plan first** and show the user what changes
before writing.

## push is a mirror — two gates worth knowing

1. **Deletion gate.** Deletions are computed from the local tree, so a wrong or
   half-populated `HERMES_HOME` looks exactly like "the user deleted 600 files".
   A large count or majority ratio is refused unless `--allow-deletions` is
   passed — pass it only when the wipe is the intent (e.g. "replace the old
   instance's data with ours").
2. **Secret gate.** Credential-shaped content (tokens, `sk-` keys, JWTs, PEM
   blocks, `api_key:`-style assignments, high-entropy strings) aborts the push
   before anything is committed. The durable fix is to keep credentials in the
   never-synced env file; for values that must stay inline (e.g. provider keys in
   `config.yaml`) **redact at commit time**:
   - blank the credential *value* only in files the gate actually flagged
     (`api_key: xxxx` → `api_key: ''`), then **re-scan**;
   - if anything still blocks, abort as before — the gate must stay fail-closed;
   - record the redacted paths + counts in the manifest so the difference between
     disk and repo is visible, and document that a restore needs those credentials
     re-entered.
   Blanking every file that merely *mentions* a key is wrong: it mangles skill
   docs and examples. Scope the redaction to gate-flagged files.

## Extending the store — a new top-level path needs TWO edits

Adding a directory (`.github/` for Actions workflows, a new `projects/<app>`, …)
takes **two** edits in the tool, not one:

1. the sync map (local dir → repo path), so the files are collected and `audit`
   can classify them;
2. the **repo-roots allowlist** that filters the remote tree. If the prefix is
   missing there, the push *succeeds* and then the read-back dies with
   `KeyError: '<new path>'` because verification only ever sees paths under a
   known root. That happened for real with `.github/workflows/*.yml`.

Rule of thumb: **any list that asks "is this path ours?" must be updated
together** — the allowlist, the sync map, the audit mapping. They are one
decision in three places. The read-back should also *skip* a sampled path that is
absent from the fetched tree (report it as the mismatch it already recorded)
rather than raising — a crash inside verify hides the very report it exists to
produce. Recipe and evidence: `references/extending-the-store.md`.

## Syncing real product code (projects/)

Once `projects/` holds software rather than notes, add exclusions for what the
build machine generates, or the store grows on every sync and CI breaks:

- `build/`, `.gradle/`, `.kotlin/`, `.idea/`, `.cxx/`, `captures/` — rebuildable
  megabytes, and a committed `build/` tree is re-committed as new blobs each time;
- `local.properties` (Android `sdk.dir=<host path>`) — machine-specific, and it
  **overrides** a CI runner's `ANDROID_HOME`, so the cloud build fails on a path
  that only exists on the host.

A store that also drives CI interacts with it: **advancing the safety ref counts
as a push**, so a workflow with `on.push.paths` filters builds the same change
twice (once on the default branch, once when the safety branch is moved). List
only the default branch in `on.push.branches` and dispatch the safety branch by
hand when it is actually needed.

## When another instance shares the repository

Two hosts pushing the same branch collide: the second push dies with
`422 Update is not a fast forward` because the tip moved mid-run. Diagnose it by
listing recent commits — repeated `sync: N files from <host>` entries at a regular
interval mean a **live** second instance, not history.

Two safe responses:

- **Give each instance its own branch** (clean separation, no fighting).
- **Keep a dedicated ref pointed at your own commit.** Cheap: the commit already
  exists, so only the pointer moves — no blob re-upload, one API call
  (`POST /git/refs` to create, `PATCH /git/refs/heads/<ref>` to advance). Advance
  it **only when the branch tip's commit message names your host**, so the other
  instance's pushes can never drag your ref elsewhere. Best-effort: a failure here
  must not turn a good sync into a reported failure. Working implementation:
  `~/.hermes/scripts/ghstore_safety_branch.py`, called at the end of the sync
  script.

Also verify what a push actually did rather than trusting its exit code: re-read
the branch tip and the tree (paths under the old project/paths should be gone),
and check the regenerated `README.md` header (files/bytes/host/generated_at).

## Scheduling the sync so it stays quiet

- One no-agent cron job running a script; **the script prints nothing on success**
  (empty stdout is the scheduler's "nothing to report" signal) and prints the
  error and exit code on failure so the failure is visible instead of silent.
- Log to a file and rotate it in-script (the repo is the durable record, not the
  log).
- Budget the run: blob uploads are sequential and a few hundred files take
  minutes; GitHub can answer `403` under secondary rate limits and the client
  should back off and retry rather than abort.
- Schedule it every 30 minutes or so; the tool already short-circuits with
  "no changes since the last sync".

## Restore into a fresh container

```sh
export GITHUB_TOKEN=<token with access to the repo>
git clone https://github.com/<owner>/<repo>.git /tmp/hermes-data
HERMES_HOME=/data/.hermes python3 /tmp/hermes-data/tool/ghstore.py pull --repo <owner>/<repo>
```

Then re-enter credentials (they were never stored) and re-run the guarded
`doctor`/`audit` to prove nothing is unclassified.

## Pitfalls

- **Don't hand-edit the repo.** The tool writes the tree, `.gitignore`,
  `.gitattributes` (byte-exact, because line-ending translation would break every
  sha256) and the README. Edit the synced source on the host instead.
- A `push` from a *copy* is fine, but never point `HERMES_HOME` at the working
  copy of the repo itself.
- Excluding a file from sync is a decision to lose it on container loss. When a
  file must not be stored verbatim (secrets) say so explicitly in the report
  instead of dropping it silently.
- The repo has a per-file size ceiling (100 MB) and practical repo-size limits:
  multi-GB toolchains belong in a re-install script, not in the store.
- After adding new scripts under `$HERMES_HOME/scripts`, they only appear in the
  repo on the next successful sync — run the sync once and confirm the commit.
- **A red verify after a green push is usually a false alarm** — GitHub's git-data
  reads are briefly eventually consistent, so re-read the tree a couple of times
  before calling it a failure. A *traceback* out of verify is different: that is a
  tool bug (an unhandled path), not a flaky read.
- **Token hygiene.** These repos are private but the credential is the whole
  security boundary. If the user pastes a PAT into a chat, tell them plainly to
  revoke and reissue it (it lives in the transcript forever), keep the working copy
  only in the never-synced sidecar / env file, and never echo it into a log, a
  commit message or a command line (`--token` lands in the process list).
- Restore order matters: pull the state first, then re-enter credentials last, so a
  half-restored home is never used to serve traffic.
