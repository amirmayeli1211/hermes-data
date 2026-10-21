---
name: github-first-storage
description: "Persist app state in a GitHub repo across container loss."
version: 1.0.0
author: Reza + Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [github, persistence, backup, restore, containers, docker]
---

# GitHub-First Durable Storage

Make a GitHub repository the primary, permanent home of durable application
state so an ephemeral container can rebuild itself. Built and verified against
Hermes Agent state; the same pattern applies to any app whose filesystem is
throwaway.

## When to use

- State lives on a container filesystem that gets deleted on redeploy.
- No database service is available, only a filesystem and a Git remote.
- The user says "GitHub should be the source of truth" / "survive a restart".

## The decision that shapes everything

Git is right for **files**: config, skills, notes, job definitions, small
JSON. Git is wrong for **live databases**: SQLite session stores, kanban,
execution logs, queues. They change every turn and produce unbounded diff
churn and meaningless history. Do not commit them, and do not claim you have
protected them — say plainly they need a real DB service. A user reading a
green "in sync" status will assume everything is covered.

## Rotating a leaked credential

GitHub exposes **no API** for creating or rotating a personal access token —
classic or fine-grained. It is a browser-only flow, so do not promise to do it
end to end. What can be automated, and should be:

1. **Audit exposure.** Search every file under the state root for the token
   value and report each hit by category — the credential store (correct), the
   session database (the transcript containing the message), staged
   attachments, logs. A token pasted into chat lands in all of these; the chat
   transcript is the one people forget. Its scope list is the real damage
   report: a state-storage token should need only `Contents: Read and write` on
   one repo, so `delete_repo`/`admin:org`/`workflow` mean it is over-privileged.
2. **Validate before adopting.** Call the API with the *candidate* token to
   confirm it authenticates, can see the target repo, and has push permission.
   Write nothing until it passes, and roll back the swap if post-swap
   verification fails. A bad candidate must never leave the deployment without
   working credentials — verify that by testing with fake and empty tokens and
   confirming the credential store is byte-identical afterwards.
3. **Say that scrubbing is not a fix.** A credential that left the machine was
   transmitted and stored in plaintext elsewhere; only revocation makes that
   exposure inert. Order: rotate, then revoke, then scrub the local copies.

Scrubbing a live SQLite store: checkpoint the WAL first, back up, then walk
**every TEXT column of every table** with `UPDATE ... REPLACE(...)`, and re-scan
afterwards to prove the value is gone. Prove it on a COPY of the database before
touching the live one, and confirm `integrity_check` plus row counts afterwards.

## Keep the small disk from filling (if the state volume is tiny)

Check `df -h` on the state volume before declaring victory. A container often
has a large ephemeral overlay (`/`, gigabytes) and a small persistent volume
(`/data`, hundreds of MB). When the persistent one fills, the app cannot write,
crashes, and there is no graceful degradation — so a monitoring warning is not
enough. Build a script that RECLAIMS, escalating only as far as needed:

- **tier 1, always:** SQLite `PRAGMA wal_checkpoint(TRUNCATE)` (lossless and
  often the biggest single win — the WAL grows with every turn), orphaned temp
  files, `__pycache__`, oversized logs truncated.
- **tier 2, at ~75%:** vendored caches re-downloaded on demand (model catalogs
  are easily 5 MB+).
- **tier 3, at ~88%:** old backup archives (keep the newest two), rotated logs,
  aged run output.
- **Never touch, at any threshold:** credentials, config, memories, skills, the
  session database, and the tooling itself.

Wire it to the top of the scheduled reconcile so it runs unattended, and verify
with real pressure — fill the disk, run it, confirm the reclamation AND confirm
every protected file still hashes the same afterwards.

Two traps:

1. **Do not delete `*.lock` files.** They are 0 bytes, so removal frees nothing,
   while deleting one a live process still holds invites a race between two
   writers. A first version of this script deleted them and reclaimed 0 KiB.
2. **`df -P` reports 1024-byte blocks**, so `delta/1024` is MiB, not KiB. The same
   first version printed "reclaimed 290 KiB" for a 290 MiB win.

Also redirect the temp dir to the large volume, and make the directory that
receives it get recreated on boot. **A temp variable pointing at a missing
directory is worse than leaving it unset:** Python's `tempfile` then falls back
to the next candidate — which is the small disk. Measured: with
`TMPDIR=/var/tmp/missing`, `tempfile.gettempdir()` returned the small-volume
scratch path. Recreate the directory in the scheduled job rather than relying on
it surviving.

## Retiring a project: park it, never delete it

When a user says a project is finished, or asks you to "forget" it, "clear it from
your mind", or "remove it from the active set", they are describing a change in
SCOPE — what you should be attending to — not requesting that bytes be unlinked.
Deleting is irreversible and the user's own data usually outlives the task.
**Park the content: move it somewhere no scan reaches, and say where it went.**

If a "remove / clean / forget" instruction could plausibly mean either, ASK.
One line of confirmation costs seconds; a mistaken deletion costs an apology, a
restore, and the user's trust in every later instruction.

### Park outside EVERY scan path, not just the obvious one

A skill loader does not have one directory, it has several. Hermes scans:

- `$HERMES_HOME/skills/` **recursively**
- every entry in `skills.external_dirs`
- dot-directories inside the skills root as well — a staged copy under
  `skills/.offloaded/` is still INSIDE the recursive scan

Measured consequence: a staging directory holding 60 retired skills kept all 60
active because it sat inside the skills root. "Parked" is only true when the
destination is outside every path above — use `<offload-root>/archive/<project>/`.

### Build a command surface, and make `verify` ask the LOADER

```
archive.sh list | park <project> | restore <project> | verify | doctor
```

`verify` is load-bearing: it asserts nothing parked sits inside a scan path AND
queries the loader's own root list to show the parked names are absent. A move
that leaves a scanned copy behind looks successful and changes nothing, so the
check must interrogate the loader rather than walk the filesystem.

### A push after parking will DELETE the parked project from the repo

A push computes its tree from LOCAL state, so a project parked locally but still
present in the repo reads as "the user deleted it" and the push removes all of it
from the backup — precisely inverting the intent. Add the new small files through
the Contents API (`PUT /repos/{r}/contents/{path}`) instead, and re-check the
project's file count in the repo afterwards.

### Park ON the state volume, and put the archive in the sync map

The archive must not live on the ephemeral overlay. Parking moved bytes to
`<offload-root>/archive` on `/var/tmp`, which is erased when the container is
recreated — so "park it, never delete it" deletes it on the next deploy, silently
and exactly once, long after the command that looked successful. Keep parked bytes
under `$HERMES_HOME/archive/` AND add that path to the sync map, so a parked
project survives container loss twice over (volume + repo). Add a `migrate`
command that moves a legacy off-volume archive across and refuses when the file
count drops. Keep the archive in the disk-guard's protected set at every tier: it
is the user's finished work, held by instruction, so no watermark may evict it.

### `cp -R src dst` with `dst` already existing nests a level

Fold live mirrors into the canonical parked tree by copying to a NEW path and then
swapping: `cp -R "$src" "$dst.tmp" && rm -rf "$dst" && mv "$dst.tmp" "$dst"`.
Measured: `cp -R live/gamedev-godot archived/gamedev-godot` with the destination
already present produced `archived/gamedev-godot/gamedev-godot/` and silently
doubled 32 files, while the command exited 0 and the top-level file count looked
plausible. The swap also means a failed copy cannot destroy the copy already in
the archive, and the source is removed only after the new one lands.

### A restore must rehydrate, and a round trip must be byte-checked

Restoring into a staging directory that the loader does not scan leaves the project
"restored" on disk and invisible to the agent — run the rehydrate step in the same
command, not only in the boot job. Two measured traps in that path:

- Enumerate the archive with `find`, never `"$dir"/*`: the only payload may be a
  DOT-directory (`.offloaded`), which a plain glob misses entirely (the shell tool
  `search_files` with `target='files'` and a glob is the portable alternative), so
  restore reported "nothing to restore" while 60 skills sat in the archive.
- Mirror by top-level entry, not by `$STAGE/*/SKILL.md`: the staged tree is
  category/nested-skill/SKILL.md, so a one-level glob matches no SKILL.md and
  reports "rehydrated 0" while the catalogue stays empty.

Give park TWO PASSES: move the canonical sources first, fold the live mirrors in
second. Folding first compares against staging still on the small disk, and the
canonical move then clobbers whatever was just folded in. Prove the whole thing by
hashing the archive before and after a park → restore → park round trip and
comparing: 183 files stayed byte-identical, which is the only evidence that
neither direction duplicated or lost data.

To recover a repo after a mistaken deletion, commit the PRE-deletion tree on top
of the current head (`POST /git/commits` with `parents=[current_head]`). That is a
revert: history stays linear, the mistake stays visible, and nothing is forced.

## Build an `audit` command, not just `push`

`push`/`status` only answer "is what I *track* in sync?". On a disposable disk
the question that matters is "is anything here I am *not* tracking at all?"
Add a command that walks every file under the state root and forces each into
`in-repo` / `excluded-by-rule` / `UNCLASSIFIED`, exiting non-zero on the third
bucket. A new state file added by an upstream release then trips the audit
until the tool is taught about it.

This is not theoretical. The first audit run on a live Hermes home found 12
unplaced files, including:

- `shared/nous_auth.json` — live OAuth JWTs (a credential, unguarded)
- `memories/MEMORY.md`, `memories/USER.md` — genuinely durable state that was
  *not* in the sync map, silently unprotected
- `skills/.curator_ledger.jsonl` — skill-provenance ledger

The audit must share ONE exclusion predicate with the collector. Two
implementations drift, and a path can then sit on disk while both report it
handled. That drift is not hypothetical: the collector keeps only the newest N
files under `cron/output/`, and the audit — sharing `is_excluded` but not the
rotation rule — reported every rotated-out file as UNCLASSIFIED (10 false
failures until the spot-fix). Any rule the collector applies AFTER the exclusion
check needs a matching branch in the audit, or the audit cries wolf and the real
gap stops being visible.

## Reference implementation

The deployment built from this skill has a working ~1200-line engine at
`$HERMES_HOME/ghfirst/ghstore.py`. Read it before writing a new one; adjust
`SYNC_MAP`, `EXCLUDE_NAME_PATTERNS`, and `SENSITIVE_LOCAL_FILES` to the app.
Standard library only, so it runs where pip/requests/jq are absent.

## Hard-won implementation facts

Each of these cost a real failure. Do not skip them.

1. **An empty GitHub repo cannot use the Git Data API.**
   `POST /git/blobs` returns `409 "Git Repository is empty"` until a ref
exists, so a push cannot bootstrap itself. Create the first commit through the
**Contents API** (`PUT /repos/{r}/contents/README.md`), then use the normal
tree/commit/ref flow. A new repo also answers `409` on
`GET /git/ref/heads/{b}`, not `404` — treat `409` as "no commits yet".

2. **`argparse` rejects global flags placed after the subcommand.**
   A script calling `tool.py pull --repo R` fails with "unrecognized
arguments". Give the parent parser the flags *and* pass a `parents=[common]`
parser with `default=argparse.SUPPRESS` to each subparser, so both
`--repo R push` and `push --repo R` work.

3. **A push computed from local state silently deletes the remote.**
   A wrong or unmounted state directory looks identical to "the user deleted
everything". Gate deletions: refuse when a push would remove more than ~10%
or >25 tracked files, unless explicitly overridden. This failure was observed
live — it wiped 330 files — before the guard existed. The same trap fires when
content is deliberately parked out of the local view but is still in the repo: the
guard will stop the wipe, and the correct follow-up is a targeted Contents-API add
rather than an override.

4. **Secret scanners need placeholder awareness in both directions.**
   Naive token regexes reject documentation: a hyphenated filename
`delegate-task-concurrency-diagnosis.md` matches `sk-...`, and a docstring
`client_secret:` followed by an identifier on the next line matches an
assignment pattern. Fix with a negative lookbehind `(?<![A-Za-z0-9_])` before
the token prefix, and `[ \t]` instead of `\s` in assignment patterns so they
cannot span lines. Conversely, a test suite full of token-shaped fixtures
*will* trip the gate — assemble fixtures from string fragments at runtime so
the file itself stays clean.

5. **Verify by reading back, not by trusting the write.**
   After committing, fetch the tree and re-hash blobs against the manifest.
A push that "succeeded" is not evidence the content is in the repo.

6. **Prove recovery, don't assume it.**
   Restore into an empty directory and compare file-by-file byte hashes
against the live tree. Report how many matched and name which files were
excluded, so the gap is visible rather than implied.

7. **Store credentials in the app's credential store, never the repo.**
   Read `GITHUB_TOKEN` from the environment or the `.env` store; when absent,
print an explicit error. Never invent, prompt for, or hardcode a token.

8. **OAuth tokens are JWTs and match no prefix regex.**
   `eyJhbGciOi....eyJzdWIi....signature` carries no `sk-`/`ghp_` marker, so a
live OAuth `access_token` in a synced file passes a prefix-only scanner with
at most a soft entropy warning. Add an explicit `jwt-token` pattern (three
base64url segments, the first two starting `eyJ`). A prefix-only scanner
under-reports credential-shaped content; the gap surfaces only by auditing the
live filesystem, not by review.

9. **Deny-list the SIDECARS of credential files, not just the files.**
   `cp auth.json auth.json.bak` produces a file holding live tokens whose name is
   not on any deny list, so it is collected and pushed. Add the whole backup
   family — `.bak`, `.bak.<n>`, `.old`, `.orig`, `.save`, `.swp`, trailing `~` —
   to both the exclusion predicate AND the `.gitignore`, so a manual `git add -A`
   in a clone cannot commit one either. A credential-rotation tool must also deny
   its own artifacts (`*.pre-rotate.*`): the backup it makes before swapping a
   token is itself a credential file. Pin this with a regression test, and prove
   it end to end by creating the sidecar and confirming it is absent from the
   push set — the collector and the auditor are separate code paths and only the
   test proves they agree.

10. **Verify shell scripts with BOTH `bash -n` and `sh -n`.**
    A shebang saying `bash` does not protect a script that gets invoked as
    `sh tool.sh` — under dash a process substitution (`done < <(cmd)`) dies with
    "Syntax error: redirection unexpected" at runtime, not at write time. Avoid
    bashisms (process substitution, arrays, `[[ ]]`) in any script a workflow,
    a cron wrapper, or another script may call, and syntax-check with both shells.

12. **A GitHub tree POST that carries every path is what triggers HTTP 422.**
    `POST /git/trees` with `base_tree` set does NOT need the unchanged paths —
    the base already carries them. Sending all 593 entries anyway is what made
    the scheduled push die with `422 "your input was too large to process"`.
    Send ONLY the changed entries, then chunk the rest: build the tree in
    groups of ~100 entries, each chunk's `base_tree` being the previous
    chunk's tree sha. A chunk that is still refused is bisected, not fatal.

13. **HTTP 422 is overloaded: "too large" AND "your request timed out" share
    the status.** The timeout wording arrives with the same 422 code and a body
    saying `Sorry, your request timed out` — it is a transient server-side
    timeout, NOT a size problem, and it hit a tree with only 11 entries.
    Splitting a tree because of it doubles the API calls and changes nothing.
    Branch on the BODY: "timed out" → retry the same payload; anything else →
    treat it as a size limit and bisect.

14. **Verify right after a push can read the PREVIOUS tree.** GitHub's
    git-data reads are briefly eventually consistent, so an immediate
    read-back can report a file as "absent from committed tree" even though
    the just-created commit's tree contains it (re-fetching the commit later
    proved it). Retry the whole read-back twice before declaring a failure, or
    the cron job goes red on a false alarm.

15. **`audit` must derive the repo path from `SYNC_MAP`, not from a hard-coded
    prefix.** The map is the only place that knows the layout. A hard-coded
    `"state/" + rel` made every `projects/...` file report UNCLASSIFIED (6
    false failures) while the push was placing them correctly under
    `projects/`. One `repo_path_for()` helper, used by both the collector and
    the auditor, keeps them in agreement.

16. **Move a big rebuildable tree off the small disk with a SYMLINK, and
    recreate the target every boot.** `<HERMES_HOME>/lsp` was 38 MB of npm
    node_modules — 11% of a 434 MB volume. Symlink it to the ephemeral disk
    and Hermes' own `<HERMES_HOME>/lsp` lookups keep working unchanged.
    Trap: the symlink survives a container rebuild, its TARGET does not, and a
    DANGLING symlink is worse than none — `os.makedirs("<home>/lsp/bin")`
    then fails with FileNotFoundError (measured), so the installer breaks
    instead of reinstalling. Recreate the target directory on every boot tick.
    Verify the tool still sees the server (`hermes lsp status` → `✓ installed`).

17. **A symlinked directory is safe for npm and unsafe for `os.replace`.**
    npm only ever writes inside the directory it was pointed at, so a symlink
    keeps its bytes on the big disk. But an atomic write staged in one
    directory and renamed into another raises `EXDEV` across devices, and
    `os.replace` onto a symlink path REPLACES the symlink with a real file
    (silently putting the bytes back on the small disk). Only symlink trees
    that no atomic-write code path targets.

18. **Extending `SYNC_MAP` to a NEW repo top-level root breaks `verify` late.**
    The sync map is not the only place that knows the repo layout: the remote
    read-back filter (which tree entries count as "ours") and the restore-path
    resolver must learn the new root too. A map entry alone commits successfully
    and then crashes inside `verify` with `KeyError: '<newroot>/...'` — the
    failure surfaces after the commit exists and looks like a verify bug, when
    the map edit was simply incomplete. Change all three in one edit, and prove
    it with a real `push`, not `plan`: `plan` walks only the local side and
    cannot see a missing remote filter.

19. **A restored `memories/` does NOT reach the running agent this session.**
    MEMORY.md/USER.md enter the system prompt as a FROZEN snapshot captured at
    session start, so a `pull` executed mid-session writes the files and the live
    agent keeps the empty view until the next session begins. Verify a restore by
    loading the store directly (`load_on_disk_store()` or the `memories/` bytes),
    not by asking the current agent what it remembers, and tell the user plainly
    that the memory shows up on their next session rather than claiming it is
    already active.

20. **A restored `cron/jobs.json` says `ok`-looking things while its script is
    missing.** The job definition and the script are two separate files; on a
    rebuilt home the definition can be restored while `scripts/` (and the
    `ghfirst/` tool it delegates to) is absent, so every fire fails with
    "Script not found" and — with `deliver=local` — nobody sees it for hours.
    After any restore, run `hermes cron list` and confirm `last_status`, then
    fire the job once (`cronjob run`) and read the real output before reporting
    the schedule as fixed. Keep `failure_deliver=origin` so the next breakage is
    visible in chat.

21. **The credential has two homes and only one survives a redeploy.** The
    container entrypoint truncates `.env` on every boot and re-emits only
    platform-managed keys, so a token appended by hand disappears while the repo
    still needs it to push. Keep `$HERMES_HOME/.ghfirst/token` (mode 600, outside
    the sync map) as the durable copy and re-inject it from a registered
    `on_session_start` hook, not from an unregistered script — an unregistered
    hook is listed as `✗ not allowlisted` and never runs in a non-interactive
    gateway, silently leaving the deployment credential-less.

## Disk tiers: not every writable path is equal

A disposable container usually has TWO filesystems with opposite properties,
and nothing about a path tells you which is which:

| path | typical size | lifetime | use for |
| --- | --- | --- | --- |
| the state root (`$HERMES_HOME`, often a mounted volume) | small — hundreds of MB | survives redeploy | durable, irreplaceable, small |
| the container overlay (`/`, `/var/tmp`) | huge — TBs | gone on recreate | temp, downloads, clones, builds, working copies |

Measure both before writing anything large: `df -h <path>` plus
`findmnt -T <path> -o SOURCE,FSTYPE`. Sibling-looking paths often land on
different volumes, and the tool-level details are in
`references/disk-tiers.md`.

**Assume the small persistent disk is what actually breaks.** On a live
deployment, all skills together were under 4 MB while a single 500 MB temp job
written into `TMPDIR` took the persistent volume to 100%. Run
`du -sh <dir>/* | sort -rh` before optimising anything: the directory the user
suspects is frequently not the one that fills the disk, and saying so plainly
is more useful than acting on the guess.

Rules that follow from this:

- Point `TMPDIR`/`TMP`/`TEMP` at the big ephemeral disk, and **recreate that
directory on boot**. A `TMPDIR` naming a MISSING directory is worse than an
unset one: `tempfile` silently falls through to the next candidate, which is
normally the small disk. It looks configured while writing to the volume you
were guarding.
- Never symlink a temp or scratch directory across filesystems. `os.replace`
between devices raises `EXDEV` ("Invalid cross-device link"), which breaks
every atomic write that stages a temp file and renames it into place.
- Put a disk-watermark check in the periodic job and report the fill level, so
the small volume is visible before it takes the service down.
- Recreate offload directories at the START of anything that writes temp files.
A periodic reconcile job is a good host: it already runs on a timer, needs no
hook allowlist, and fails visibly.
- Skills can live outside the state root when the loader supports
`external_dirs` — read-only, lower precedence than the local dir, and newly
created skills still land in the state root.
- Report three buckets explicitly: protected, excluded-by-rule, and NOT covered.
  A user shown a green status believes everything is in it, and the uncovered
  bucket is the entire point.

### Syncing content that lives off-volume

- **Mirror the offloaded tree verbatim; never assume its depth.** A sync that
  expects `<offload>/<name>/SKILL.md` stages ZERO items from a category layout
  (`<offload>/<cat>/<name>/SKILL.md`) and can print "staged 0" without failing,
  producing a silently empty snapshot. Delete-then-copy the whole tree, and
  **refuse to stage when the count is 0** so an empty mirror is an error, not a
  no-op.
- **Restore direction is a separate path from install direction.** Install writes
  the off-volume copy; the repo gets a staging snapshot; a rebuild restores to
  staging — which the application does NOT scan. Rehydrate staging → live in the
  same periodic job that recreates the offload directories, and `cmp`-guard the
  copy so a live edit is not reverted every tick.
- **Do not hand-patch vendored third-party content.** An installer that
  `rm -rf`s then re-copies a directory destroys local edits, and a live→staging
  mirror overwrites them from the other side. Keep your own lessons in skills you
  own; if a vendored file must be corrected, correct it in the upstream install
  step so a re-install reproduces it.

### Sizing an install before downloading it

Measure a remote repo without cloning it: `GET /repos/{r}/git/trees/{branch}?recursive=1`
returns every blob with a `size`, so summing them gives the checkout size and
per-directory sums show where the weight is. Then **filter to what this machine
can actually run.** Of a 2.84 MB skill pack, 1.87 MB was a docs banner PNG and
another 122 KB targeted engines with no runtime present (no engine binary, no
SDK, no display) — installing those would make the skill index claim capability
the machine does not have. State the skipped parts and the reason in the install
output, and record a size budget with an explicit stop-and-ask threshold before
downloading anything large.

Support files: `references/disk-tiers.md` — measurement recipes, the EXDEV
probe, temp-dir precedence, and the `external_dirs` details.
`references/project-retirement.md` — parking a finished project out of every scan
path, the loader query that proves it, and recovering from a mistaken deletion.
`scripts/disk-tier-check.sh` — re-runnable tier, fallback, and watermark check.

## Reporting a huge backlog of advisory warnings

A secret scanner that reports entropy warnings per file produces a wall of output
on a busy home (measured: 46 lines from one push). Delivered verbatim by a cron
job, that wall buries the one line that matters. Summarise by count and kind and
list the first few, keeping the full list behind a `--verbose` flag. Keep the
BLOCKING list unconditional: warnings are advisory, secret hits are not.

## Verification checklist

Run these before reporting success:

- `doctor` — credential source, repo, push permission, scan result.
- `plan` — exact path map; confirm nothing sensitive is listed.
- `audit` — must report **0 unclassified**; investigate every file it names.
- `push` then `verify --full` — hash every blob in the repo.
- `pull` into an empty home; byte-compare against the source tree.
- Confirm a real secret **is** blocked and the branch head does not move.
- Confirm a missing token **is** an error, not a silent local fallback.
- Confirm an unchanged tree makes **no** commit.
- Audit the final tree: search every blob for the live token and for
  exclusion-rule violations.
- Create a credential sidecar (`cp auth.json auth.json.bak`) and confirm the push
  set does not contain it.
- `disk-guard.sh check` (or equivalent) — confirm the reclaim plan, then run it
  under real disk pressure and re-hash the protected files afterwards.
- Parking: run `archive.sh verify` and confirm the loader reports **0** parked
  skills in its live catalogue, then `restore` and `park` again to prove the round
  trip in both directions.
- After parking, confirm the repo still contains the parked project's files — a
  normal push would have removed them.
