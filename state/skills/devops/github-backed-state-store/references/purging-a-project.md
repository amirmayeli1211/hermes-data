# Purging a project from the store — complete removal

Runbook for "delete that app/project, leave no data". A mirror-backed store keeps
one logical project in **five independent places**, each with its own removal
path; missing one leaves the *apparently deleted* project still downloadable.

| Where | Removed by | Easy to miss because |
|---|---|---|
| Local host dir (`$HERMES_HOME/projects/<app>`) | `rm -rf` | — |
| Repo tree on the **default branch** | `ghstore.py push --allow-deletions` | the deletion gate refuses without the flag |
| Repo tree on **every other ref** (safety branch) | advance the ref, not force-push | `main` looks clean, so this is invisible |
| **GitHub Actions artifacts** (APKs, test reports) | `DELETE /repos/{o}/{r}/actions/artifacts/{id}` | deleting the workflow file does **not** delete them |
| Host scratch (downloaded APK, build output) | scratch reaper / `rm -rf` | may already be gone, leaving no trace to reason about |

Plus build-support files that are not under `projects/` and get forgotten:
the CI helper script (`~/.hermes/scripts/ci_*.py`), the workflow dir
(`~/.hermes/github/workflows/`), and the cached source document
(`~/.hermes/cache/documents/`).

---

## 0. Scope first — "delete the app's data" is four different requests

An Android/web app's "data" can mean its **build artifacts**, the **project
source**, the **installed app's on-device database**, or the **host build
output**. Guessing wrong here is irreversible, so enumerate what actually exists
and let the user pick instead of inferring:

```
- Actions artifacts: N × <name> (size)     ← from the artifacts API
- project paths in the repo: N             ← git trees API, per ref
- local project dir: size
- on-device app data: needs `adb devices` — say so if no device is attached
- host build output / APK: already gone? say that too
```

This took one round-trip and replaced an ambiguous order with an explicit scope.
Ask once, with a concrete inventory; do not ask twice.

## 1. Inventory every ref, not just the default branch

```python
# one HEAD per branch, then a recursive tree each
branches = api('/repos/{o}/{r}/branches')
for b in branches:
    t = api(f"/repos/{o}/{r}/git/trees/{b['name']}?recursive=1")
    paths = [x['path'] for x in t['tree']]
    print(b['name'], len(paths),
          'project=', sum('netcheck' in p.lower() for p in paths),
          '.github=', sum(p.startswith('.github') for p in paths))
```

Real evidence from this host: after the local delete + `push --allow-deletions`,
`main` reported `netcheck=0 .github=0` and the purge looked finished. The safety
ref `sandbox-b1e0eab0` was still at an older commit and reported
**`netcheck=46 .github=3`** — the entire project, still fetchable. **A green
default branch is not a purge.**

## 2. Delete the artifacts (they are not git objects)

```python
arts = api('/repos/{o}/{r}/actions/artifacts?per_page=100')['artifacts']
for a in arts:
    st, _ = api(f"/repos/{o}/{r}/actions/artifacts/{a['id']}", 'DELETE')   # expect 204
```

Verify with a second listing (`total_count == 0`). These can be tens of MB each
(three 8.83 MB APKs plus test reports here) and survive the workflow file's
deletion, so removing the workflow first silently orphans them.

## 3. Remove from the default branch

```bash
rm -rf "$HERMES_HOME/projects/<app>" "$HERMES_HOME/github/workflows/<wf>.yml" \
       "$HERMES_HOME/scripts/ci_<app>.py"
HERMES_HOME=/home/user/.hermes python3 tool/ghstore.py push \
    --repo <owner>/<repo> --allow-deletions
```

`--allow-deletions` is required once the removal trips the ratio gate (31 files
of 634 here ≈ 5 %, under the 10 % limit, but pass it anyway so the intent is
explicit). Expect the tool to print `deleted=N` and `VERIFY OK`.

**Coupling to know:** running `ghstore.py push` *directly* bypasses the wrapper
`ghstore_sync.sh`, which is what invokes `ghstore_safety_branch.py`. That is
exactly why the safety ref lagged a commit behind and still carried the project.

## 4. Clear the other refs without a force-push

The safety ref is *defined* as "the newest commit this instance produced", so
advance it forward — the old tree disappears because the ref no longer points at
it. No rewrite, no force, one API call:

```bash
HERMES_HOME=/home/user/.hermes python3 ~/.hermes/scripts/ghstore_safety_branch.py \
    --repo <owner>/<repo> --verbose
# safety-branch: sandbox-xxxx -> <new sha> (HTTP 200)
```

The next scheduled sync would do this anyway; running it by hand just removes the
window in which the old content is still reachable. Never force-push a shared
mirror to achieve this — see §6.

## 5. Verify, then re-verify from the remote's perspective

```bash
find / -xdev -iname '*<app>*' -not -path '*/node_modules/*' 2>/dev/null   # host: expect nothing
python3 tool/ghstore.py verify --repo <owner>/<repo>
```

Re-read every branch's tree (§1) and the artifacts count. Report per-branch
numbers — "0 on both `main` and `<safety ref>`" is a claim the user can trust;
"deleted" is not.

## 6. Residue you must disclose instead of pretending it is gone

A purge removes *content*; three classes of record survive and none of them are
fixable with the same command:

- **Git history.** Old commits still hold the blobs (`git log --oneline -- '*<app>*'`
  lists them) and they stay fetchable by SHA. Real removal means `git filter-repo`
  / `filter-branch` **and a force-push** — which on a repo another instance pushes
  to every ~30 min risks divergence and can break the user's only backup. Surface
  it as a separate decision; do not bundle it into "deleted".
- **Workflow run records.** There is no delete API for runs. They keep the
  workflow name, timestamps and SHAs, and no artifacts.
- **The agent's own logs.** `state.db`, `sessions/*.jsonl`, `~/.hermes/logs/*`
  contain the conversation and any generated source. Deleting them destroys the
  session history and memory — not "the app's data". Name them and leave them.

State each category plainly with what it holds and what removing it would cost.
"Nothing remains" is a false claim while any of these exists.

## 7. Don't collateral-delete the reusables

Generic assets created *during* the project outlive it: an
`android-app-builds` skill with a CI workflow template, the toolchain in `/opt`,
`disk-guard` tiers. Check for the app's name in them (`grep -ril <app>`) — if the
only hits are the name in a session log, the asset is generic and stays. Deleting
a hard-won generic skill because it was born in the same session is the expensive
mistake here.

Also: an unrelated **stale local clone** may still hold *other* retired projects
(`projects/ticket-bot`, `state/archive/*`) that the repo no longer has. Those are
outside the requested scope — do not sweep them into the purge; mention them.