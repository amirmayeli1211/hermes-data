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
handled.

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
live — it wiped 330 files — before the guard existed.

4. **Secret scanners need placeholder awareness in both directions.**
   Naive token regexes reject documentation: a hyphenated filename
`delegate-task-concurrency-diagnosis.md` matches `sk-...`, and a docstring
`client_secret:` followed by an identifier on the next line matches an
assignment pattern. Fix with a negative lookbehind `(?<![A-Za-z0-9_])` before
the token prefix, and `[ \t]` instead of `\s` in assignment patterns so they
cannot span lines. Conversely, a test suite full of token-shaped fixtures
*will* trip the gate — assemble fixtures from string fragments at runtime so
the file itself stays clean.

8. **OAuth tokens are JWTs and match no prefix regex.**
   `eyJhbGciOi....eyJzdWIi....signature` has no `sk-`/`ghp_` marker, so a live
``access_token` in a synced file passes a prefix-only scanner with at most a
soft entropy warning. Add an explicit `jwt-token` pattern (three base64url
segments, first two starting `eyJ`). This gap was found only by auditing the
live filesystem, not by review.

5. **Verify by reading back, not by trusting the write.**
   After committing, fetch the tree and re-hash blobs against the manifest.
A push that "succeeded" is not evidence the content is in the repo.

6. **Prove recovery, don't assume it.**
   Restore into an empty directory and compare file-by-file byte hashes
against the live tree. Report the count (`331 identical, 0 differing`) and
name which files were excluded, so the gap is visible.

7. **Store credentials in the app's credential store, never the repo.**
   Read `GITHUB_TOKEN` from the environment or the `.env` store; when absent,
print an explicit error. Never invent, prompt for, or hardcode a token.

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
