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

### `disk-guard.sh` — automatic reclamation (the important one)

**When `/data` fills, the gateway cannot write, crashes, and the agent stops
responding entirely.** There is no graceful degradation, so a warning is not
enough — this reclaims, escalating only as far as needed.

Wired into the top of every `reconcile.sh` tick (every 30 minutes), so it runs
without anyone remembering to.

```sh
sh ghfirst/disk-guard.sh check          # report + what it WOULD do; changes nothing
sh ghfirst/disk-guard.sh clean          # reclaim what the current level needs
sh ghfirst/disk-guard.sh clean --force  # all tiers regardless of usage
```

Thresholds: `<75%` tier 1 only · `>=75%` tiers 1-2 · `>=88%` all three tiers.
Override with `HERMES_DISK_WARN_PCT` / `HERMES_DISK_CRIT_PCT`.

| tier | what | cost of losing it |
| --- | --- | --- |
| 1 (<75%) | SQLite WAL checkpoint, orphaned temp >2h, `__pycache__`, oversized logs truncated to 2 MB | none — garbage |
| 2 (>=75%) | `models_dev_cache.json` (5.6 MB), `provider_models_cache.json`, tool-discovery cache | a few seconds to re-download |
| 3 (>=88%) | backup zips (newest 2 kept), cron output >7d, logs >3d, sessions mirror >3d, generated media >7d | history, not state |

**Never touched at any threshold:** `.env`, `auth.json`, `config.yaml`,
`SOUL.md`, `memories/`, `skills/`, `state.db`, `ghfirst/`, `kanban.db`,
`shared/`, `plans/`, `cron/jobs.json`.

Verified end-to-end with real disk pressure:

- filled `/data` to 72%, aged the junk, `clean` → **290 MiB reclaimed, back to 3%**
- forced CRITICAL: escalation ran all three tiers, reclaimed 100 MiB, **kept the
  newest backup**, and all 7 protected files hashed identical afterwards
- `state.db` after WAL checkpoint: `integrity_check = ok`, 17 sessions and 388
  messages still readable. The checkpoint is lossless — it is the only operation
  this script ever performs on that database, and it never deletes it.

Two mistakes found by testing, both fixed in the script:

1. **Lock files are no longer deleted.** They are 0 bytes, so removal frees
   nothing while deleting a held lock invites a race between two writers.
2. **The reclaim label said KiB for a MiB-scale delta.** `df -P` reports 1024-byte
   blocks, so `delta/1024` is MiB; a 290 MiB reclaim was reported as "290 KiB".

## Disk layout — two very different filesystems

| mount | size | lifetime | role |
| --- | --- | --- | --- |
| `/data` (ext4, `/dev/zd3792`) | **434 MB** | **persistent** | Tier 1 — durable data only. Small and precious. |
| `/` (overlay) | 2.9 TB | **ephemeral** (lost on container replace) | Tier 2 — anything big or rebuildable. |

The real risk to this deployment is not skills (3.9 MB). It is that Hermes sets
`TMPDIR=$HERMES_HOME/cache/scratch`, which is on the **434 MB** volume.
**Measured: a single 500 MB temp job filled `/data` to 100%.** `models_dev_cache.json`
alone is 5.5 MB, and `state.db-wal` grows with every turn.

### `offload.sh` — the fix

Redirects `TMPDIR`/`TMP`/`TEMP` into `/var/tmp/hermes-offload/tmp` on the big
disk. Verified `PASS: 200 MiB written, /data grew by 0 KiB`.

```sh
sh ghfirst/offload.sh setup     # create area, patch .env, report
sh ghfirst/offload.sh verify    # prove writes bypass /data
sh ghfirst/offload.sh status    # both tiers + where temp actually goes
sh ghfirst/offload.sh clean     # drop rebuildable cargo
```

`offload-boot.sh` recreates the area and is called at the top of every
`reconcile.sh` tick. **This matters:** `/var/tmp` is ephemeral, so after a
container rebuild the directories are gone while `.env` still points `TMPDIR` at
them — and Python's `tempfile` then falls back to the next candidate, which is
`$HERMES_HOME/cache/scratch`, the very disk being protected. **A `TMPDIR`
pointing at a missing directory is worse than no `TMPDIR` at all.** Measured:
with `TMPDIR=/var/tmp/missing`, `tempfile.gettempdir()` returned
`/data/.hermes/cache/scratch`.

**Do not symlink `cache/scratch` to the big disk.** Tested and rejected:
`os.replace` across filesystems fails with `EXDEV` ("Invalid cross-device
link"), and Hermes writes state with tmp-file + `os.replace`. `TMPDIR`
redirection is the safe lever because it is read at boot, and
`apply_scratch_tmp_env` leaves a user-set value alone (verified).

### `skill-fetch.sh` — install skills without touching `/data`

Installs skills into `/var/tmp/hermes-offload/skills`, registered through
`skills.external_dirs` (resolved at tier=3, below local skills so local wins on
a name collision). Verified: a skill installed there loads through `skill_view`.

```sh
sh ghfirst/skill-fetch.sh add anthropics/skills   # fetch from GitHub
sh ghfirst/skill-fetch.sh list
sh ghfirst/skill-fetch.sh push                    # snapshot into the repo
sh ghfirst/skill-fetch.sh doctor
```

Snapshots go to `state/skills/.offloaded/` in the repo so an offloaded skill
survives a container rebuild; the live copy stays on the big disk. External
dirs are scanned **one level deep**, so a skill must sit at
`<root>/<name>/SKILL.md`, not nested under a category.

## Two filesystems, three tiers of data

1. **Durable and small** → `/data`, and mirrored to GitHub.
   Config, memories, credentials, the tooling.
2. **Big or rebuildable** → the offload area. Temp files, downloads, clones,
   builds, offloaded skills. Everything here must be restorable from the repo.
3. **Never written anywhere durable** → nothing. If it is worth keeping, it goes
   to the repo.

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
