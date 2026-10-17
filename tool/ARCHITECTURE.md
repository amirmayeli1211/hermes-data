# GitHub-First Storage — architecture and operations

The GitHub repository is the **primary, permanent home** of every durable
artifact of this Hermes instance. The container filesystem is a rebuildable
cache: wipe the container, and the state comes back from
`amirmayeli1211/hermes-data`.

Implemented by `ghstore.py` (standard library only — this environment has no
pip, no `requests`, no `jq`, so anything else would not run at all).

## Current state

| item | value |
| --- | --- |
| repo | `amirmayeli1211/hermes-data` (private) |
| branch | `main` |
| files stored | 335 |
| integrity | every blob read back and sha256-compared (`verify --full` → OK) |
| recovery test | empty `HERMES_HOME` fully restored, 0 byte differences (verified) |
| scheduled | Hermes cron job `ghstore-reconcile`, every 30 min |

## What is stored in GitHub

| repo path | local source | why durable |
| --- | --- | --- |
| `state/config.yaml` | `$HERMES_HOME/config.yaml` | behaviour of the whole agent; losing it means re-configuring every provider and tool by hand |
| `state/SOUL.md` | `$HERMES_HOME/SOUL.md` | identity/persona text |
| `state/memories/` | `memories/` | cross-session facts |
| `state/skills/` | `skills/` | learned procedures — the highest-value asset here |
| `state/plans/` | `plans/` | multi-session plans |
| `state/hooks/`, `state/plugins/`, `state/skins/` | same | automation, extensions, theming |
| `state/scripts/` | `scripts/` | cron job scripts |
| `state/cron/jobs.json`, `state/cron/output/` (newest 40) | `cron/` | job definitions + recent run output |
| `state/workspace/` | `workspace/` | working files |
| `state/manifest.json` | generated | sha256 + size per file; the integrity record |
| `tool/` | `ghfirst/` | the restore path itself — a fresh container bootstraps from here |

## What is deliberately NOT stored

**Credentials — never, enforced by three independent layers:**

1. `.env`, `auth.json`, `credentials.json`, `.op.env` are outside the sync map
   and are named in the exclusion report, so their absence is visible, not implicit.
2. Name patterns reject `*.key`, `*.pem`, `*.db`, `*.lock`, `*.pid`, `*.sock`.
3. Every outgoing text file is scanned; a credential-shaped match **aborts the
   push** (exit 4). Verified: a `ghp_`-shaped string in `config.yaml` blocked the
   push and left the branch head untouched.

**Live SQLite state — not Git-suitable.** `state.db` (session transcripts,
messages, gateway routing), `kanban.db`, `cron/executions.db` change on every
turn. Committing them per push would create unbounded history churn and
meaningless diffs, and reads would be inconsistent. They stay local and are
lost on container deletion — see "Known limitations".

**Runtime noise:** `logs/`, `sessions/`, `runtime/`, `cache/`, `backups/`,
`models_dev_cache.json`, `provider_models_cache.json`, gateway pid/lock/socket
files, Telegram update receipts, `__pycache__`.

## Commands

```sh
P=/data/.hermes/ghfirst/ghstore.py
python3 $P doctor          # credential, repo, permissions, scope, secret scan
python3 $P plan            # exact path mapping; no network writes
python3 $P audit           # classify EVERY local file; fails on any it cannot
                           # place in one of: in-repo / excluded-by-rule
python3 $P status          # three-way drift vs the repo manifest
python3 $P push            # atomic commit of the whole tree, then read-back verify
python3 $P verify --full   # re-download and hash every blob
python3 $P pull            # restore (safe: never overwrites local modifications)
python3 $P pull --overwrite
python3 $P pull --dry-run
```

Exit codes: `0` ok · `1` no credential · `4` secret gate · `5` conflict ·
`6` integrity/deletion refusal · `7` nothing to restore · `8` partial restore ·
`9` audit found unclassified files · `10` network/API failure.

## `audit` — the command that keeps this honest

`push` and `status` answer "is what I track in sync?". They cannot answer the
question that actually matters on a disposable disk: **is anything sitting on
this container that I am not tracking at all?** `audit` walks every file under
`HERMES_HOME` and forces each into `in-repo`, `excluded-by-rule`, or
`UNCLASSIFIED`, exiting `9` on the third. Adding a new state file to Hermes
therefore trips the audit until the tool is taught about it.

It earned its place immediately: the first run found 12 unplaced files,
including `shared/nous_auth.json` (live portal OAuth JWTs),
`memories/MEMORY.md` and `memories/USER.md` (real durable state that was
silently *not* on the sync map) and `skills/.curator_ledger.jsonl`. That
finding also forced the JWT pattern into the secret gate — an OAuth access
token matches no token-prefix regex, so it had been passing with only a soft
warning.

Run it after any Hermes update. `0 unclassified` is the claim this design
rests on.

## How a push stays safe

- **Atomic commit.** Tree + commit + ref via the Git Data API. A failure mid-way
  leaves the previous commit as head — partial states are never published.
- **Conflict gate.** Three-way comparison (local / repo / last-known-synced).
  If both sides changed the same path, the push aborts (`5`) instead of
  overwriting. `--force` is the explicit override.
- **Deletion guard.** A push that would remove more than 10% (or >25) of tracked
  files aborts with exit `6`. Without this, a wrong or unmounted `HERMES_HOME`
  silently wipes the repo — demonstrated during testing, which is exactly why
  the guard exists.
- **Secret gate.** Above.
- **Bounded retries.** Network errors and 403/429/5xx retry up to 5 times with
  exponential backoff, honouring `Retry-After`.
- **No-op detection.** An unchanged tree produces "nothing to commit", not an
  empty commit.

## Recovery on a fresh container

```sh
export GITHUB_TOKEN=<token with access to the repo>
sh /data/.hermes/ghfirst/bootstrap.sh
```

`bootstrap.sh` clones the repo (git, falling back to the API), installs
`ghstore.py` to `$HERMES_HOME/ghfirst/`, then pulls and hash-verifies every file
against `state/manifest.json`.

Tested for real: into a completely empty `HERMES_HOME`, 335 files restored,
then compared file-by-file against the live tree — **331 identical, 0
differences**, the remaining 40 being exactly the excluded credential/runtime set.

## Known limitations (not solved)

- **Session history, kanban, and cron execution logs live only on the container
  disk.** They are the one class of data this design does not protect; they need
  a real database service (Postgres/Supabase/Neon), not Git. Do not read the
  green status above as covering them.
- **`.env` is not backed up anywhere.** It holds the provider keys and the
  Telegram token. Keep a copy in a password manager; on a rebuilt container it
  must be recreated before the gateway can start.
- **Single-writer assumption.** The conflict gate assumes one machine pushes
  between pulls. Concurrent pushes from two hosts can still race between the
  read and the ref update; the API rejects the losing update, and the run must
  be retried.
- **Scheduled reconcile needs the gateway running.** The Hermes cron job fires
  only while the container lives. It is not an external watchdog.

## Rotating the credential

This deploy used a classic token with broad scopes. A fine-grained token scoped
to **only** `amirmayeli1211/hermes-data` with `Contents: Read and write` is
strictly better, and the current one should be revoked once replaced. The tool
reads `GITHUB_TOKEN` from the environment or `$HERMES_HOME/.env`; nothing else
changes.
