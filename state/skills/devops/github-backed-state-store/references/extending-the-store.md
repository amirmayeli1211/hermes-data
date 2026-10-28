# Extending a ghstore-style state store

Concrete record of adding a new top-level repo path (`.github/`) to
`tool/ghstore.py`, including the failure it caused and the exact edits. Read the
"Extending the store" section of SKILL.md first; this file is the evidence.

## The layout knowledge lives in three lists

`ghstore.py` keeps one decision — "which paths belong to this repository?" — in
three places. They must agree:

| place | what it does | symptom when stale |
| --- | --- | --- |
| `SYNC_MAP` (`("local dir", "repo path")`) | collects local files into the tree; derives `repo_path_for()` used by `audit` | files never leave the host, or `audit` reports them UNCLASSIFIED |
| `REPO_ROOTS` (`("state/", "tool/", "projects/", …)`) | filters the **remote** tree that `fetch_remote_state()` returns | push succeeds, then verify raises `KeyError` |
| `EXCLUDE_DIRS` / `EXCLUDE_NAME_PATTERNS` | build output, credentials, machine-specific files | the store grows on every sync, or CI picks up a host-only path |

## What actually happened

Added `("github", ".github")` to `SYNC_MAP` only. The push committed the file and
then verification crashed:

```
  up tool/ghstore.py
Traceback (most recent call last):
  ...
  File "tool/ghstore.py", line 1453, in _verify_remote_once
    blob = gh.get_blob(blobs[path])
                       ~~~~~^^^^^^
KeyError: '.github/workflows/android.yml'
```

Two independent defects, both worth fixing in a store like this:

1. `REPO_ROOTS` did not list `.github/`, so `fetch_remote_state()` filtered the
   new path out of `blobs`; every consumer that assumes "manifest path ⇒ blob
   exists" was then wrong.
2. The read-back loop indexed `blobs[path]` for a sampled path *before* the guard
   that turns a missing path into a reported mismatch. A missing blob must produce
   the mismatch line, never an exception — otherwise the verification that exists
   to produce a report crashes instead, and the scheduled job reports a false
   failure.

Result on the host: the cron wrapper correctly surfaced "sync FAILED (exit 1)"
while the commit itself was fine. Diagnose by re-reading the branch tip and the
tree before believing the failure.

## Recipe: add a new top-level path

1. Add the pair to `SYNC_MAP`, e.g. `("github", ".github")`.
2. Add the repo prefix to `REPO_ROOTS`, e.g. `".github/"` (trailing slash).
3. Add exclusions for anything generated or machine-specific under that path.
4. `python3 -m pytest tool/tests -q` (the store ships its own tests).
5. Read-only check first: `doctor` (counts + `redacted` + `blocking=0`) and
   `plan` (grep the new path to confirm it is listed with the right repo path).
6. Push, then confirm with `verify` — a green `VERIFY OK` line plus the recovery
   anchor commit, not just exit code 0.

## Framework-independent lessons

- A path allowlist is a **second source of truth** next to the mapping. Any
  function that answers "is this ours?" must derive from one place; this store
  already learned that once for `audit` (which hard-coded `state/` and reported
  every `projects/…` file as unclassified) and again here.
- Verification must fail *closed* and *legibly*: report, never raise.
- When the repository also drives CI, `.github/workflows` is the first path that
  has to exist at the repo root — map it at the top level rather than nesting it
  under a project directory, because GitHub only reads workflows from
  `.github/workflows/`.
