# Retiring a project without losing it

Recipe for taking finished work out of an agent's active working set while keeping
every byte recoverable. Read this when a user asks you to "forget", "clear",
"remove from the active set", "clean up" or "retire" a project.

## The distinction to resolve first

| the user means | the action |
| --- | --- |
| "stop attending to this" / "forget it" / scope | **PARK** — move out of every scan path |
| "delete this" / "it should not exist" / irreversibility | delete — and confirm first |

When the phrasing is ambiguous, ask. A park is reversible in one command; a delete
is not, and the user's data normally outlives the task that produced it. Say where
you parked it, so "forget" does not become "I can no longer find it".

## Scan paths a skill loader uses

Park outside ALL of these. Missing one leaves the project fully active and the
move looks successful:

```
$HERMES_HOME/skills/            recursive — dot-dirs inside it INCLUDED
skills.external_dirs[]          each root
```

Two concrete traps:

1. **A dot-directory inside the skills root is still scanned.** A staging copy at
   `skills/.offloaded/` is inside the recursive walk, so all 60 retired skills
   stayed active. Only a destination outside the root works.
2. **A category layout means one project spans several sibling directories.**
   A skill pack installed as `gamedev-disciplines/`, `gamedev-genres/`, … is six
   paths, not one; parking the pack has to move all six.

Park destination: `<offload-root>/archive/<project>/<original-name>/`.

## Command surface

```sh
archive.sh list                 # active vs parked, with sizes
archive.sh park <project>       # move out of every scan path
archive.sh restore <project>    # move back into the active set
archive.sh verify               # prove the loader no longer lists it
archive.sh doctor               # every scan path the loader uses
```

## `verify` must ask the LOADER, not the filesystem

Walking the tree proves nothing about whether the application can see the content.
Query the application's own search roots and assert the parked names are absent:

```python
import sys, os
os.environ['HERMES_HOME'] = home
sys.path.insert(0, '/opt/hermes')
import agent.skill_utils as su
names = []
for tier, d in su.get_skill_search_roots():
    if d.is_dir():
        names += [p.parent.name for p in d.rglob('SKILL.md')]
parked = {'level-design', 'dialogue-systems', ...}
print('still visible:', sorted(parked & set(names)) or 'NONE')
```

Use the application's venv interpreter for this — the plain system interpreter
cannot import the app's dependencies.

## Prove the round trip, both directions

A one-way move that cannot be reversed is a delete with extra steps:

```sh
archive.sh restore <project>   # confirm the files and count come back
archive.sh park <project>      # confirm they leave again
```

## Do not let the next sync re-delete or re-add

- A `push` computed from local state sees a locally-parked, remotely-present
  project as "the user deleted it" and removes it from the backup. Add the small
  new files via the Contents API instead of running a full push.
- The scheduled reconcile will re-materialise anything the offload job copies
  back. If a parked project normally gets rehydrated from the repo on boot, either
  keep its staging copy parked too, or exclude it from rehydration.

## Recovering from a mistaken deletion

Commit the PRE-deletion tree on top of the current head — a revert, not a
rewrite:

```python
old   = gh.get_commit(pre_deletion_sha)     # find it in /repos/{r}/commits
head  = gh.get_ref('main')['object']['sha']
new   = gh.create_commit('revert: restore <project>', old['tree']['sha'], [head])
gh.update_ref('main', new['sha'])
```

History stays linear, the mistake stays visible, nothing is force-pushed. Then
restore the local copies from the recovered tree, and re-verify the file counts
per project.
