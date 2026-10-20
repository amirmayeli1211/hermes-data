# Disk tiers in a disposable container

Depth for the "Disk tiers" section of SKILL.md. All commands and thresholds
here were executed and observed on a live deployment; treat the numbers as
illustrative and re-measure, but the failure modes are real.

## 1. Identify the tiers before writing anything large

```sh
# size + fill for each candidate path
df -h /data / /var/tmp

# which filesystem backs each path — the decisive check
findmnt -T /data          -o TARGET,SOURCE,FSTYPE
findmnt -T /var/tmp       -o TARGET,SOURCE,FSTYPE

# per-directory and per-file consumers, biggest first
du -sh <state-root>/* | sort -rh | head -12
find <state-root> -type f -size +1M -exec du -h {} + | sort -rh | head
```

A representative result — note the persistent volume is ~3 orders of magnitude
smaller than the overlay, and `/var/tmp` sits on the overlay:

```
/data      434M total   17M used   408M free   ext4     <- persistent, TINY
/          2.9T total  820G used   2.1T free   overlay  <- ephemeral, HUGE
/var/tmp   -> overlay
```

`findmnt -T` is the important one. Path shape predicts nothing: a mounted
volume can be tiny while an unrelated-looking directory tree is enormous.

## 2. Prove the risk instead of asserting it

Write a file larger than the small volume and watch the fill level:

```sh
df -h <small-volume-path> | tail -1
dd if=/dev/zero of="$TMPDIR/probe.bin" bs=1M count=500 status=none
df -h <small-volume-path> | tail -1     # observed: 4% -> 100%
rm -f "$TMPDIR/probe.bin"
```

When `TMPDIR` points at the small volume this takes the whole service with it.
This is how the real hazard was established rather than assumed — and how it
was confirmed the fix works (see §5).

## 3. Temp-dir resolution and the missing-directory trap

Precedence for `tempfile.gettempdir()`, verified empirically:

1. `TMPDIR`, then `TEMP`, then `TMP` — **if the directory exists**
2. a series of well-known fallbacks, which on this deployment resolved to
   `<state-root>/cache/scratch` — i.e. the small persistent volume

```sh
# with TMPDIR naming a MISSING dir, Python does NOT error:
TMPDIR=/nonexistent python3 -c "import tempfile; print(tempfile.gettempdir())"
# -> <state-root>/cache/scratch      (silent fallback to the small disk)
```

So a `TMPDIR` pointing at a not-yet-created directory is actively dangerous: it
reads as configured while temp files land on the volume you meant to protect.
Disappearance is normal after a container recreate, because `/var/tmp` is on
the ephemeral overlay.

**Fix:** recreate the directories at the start of every periodic run and treat
failure to do so as a reported warning, never a silent one.

```sh
mkdir -p "$OFFLOAD"/{tmp,work,downloads,clones}
```

## 4. Cross-filesystem rename fails — do not symlink temp dirs

The tempting fix (symlink `<state-root>/cache/scratch` at the big disk) is
wrong, because atomic writes end in `os.replace`, which is a rename:

```python
import os, tempfile
t = tempfile.NamedTemporaryFile(dir='/var/tmp/offload/tmp', delete=False)
os.replace(t.name, '<state-root>/cache/scratch/x.bin')
# OSError: [Errno 18] Invalid cross-device link (EXDEV)
```

`shutil.move` would copy instead, but code that calls `os.replace` directly
does not, so it breaks wherever such code paths run. Before relocating any
directory that a running system writes through, grep the application for
`os.replace(` and check whether each call stages its temp file in the SAME
directory as its destination:

```sh
grep -rn "os\.replace(" --include=*.py <app-root> | head -30
# then inspect neighbours: `with_name(...)`, `mkstemp(..., dir=<destdir>)`
# are same-dir (safe); a shared $TMPDIR stage is cross-device (unsafe).
```

`TMPDIR` redirection is safe because it only changes where temp files are born
— it never changes where the application's own destinations live.

## 5. Verify the offload actually offloads

Compare the small volume's used-blocks before and after a large write, rather
than trusting the configuration:

```sh
before=$(df -k <small-volume> | tail -1 | awk '{print $3}')
dd if=/dev/zero of="<offload>/tmp/probe" bs=1M count=200 status=none
where=$(findmnt -T "<offload>/tmp/probe" -o SOURCE -n)
after=$(df -k <small-volume> | tail -1 | awk '{print $3}')
echo "$where  small-volume delta: $((after-before)) KiB"
rm -f "<offload>/tmp/probe"
```

Pass condition: the probe reports the overlay as its source AND the delta is a
few KiB (filesystem metadata only). A delta near the probe size means the write
landed on the small volume.

## 6. Installing skills without filling the disk

Skill files are small (single-digit KB each; a few hundred files is only a few
MB), so skills are rarely the thing that fills a volume — measure before
optimising them. When they do matter, the loader's external search path is the
clean lever:

```yaml
skills:
  external_dirs:
    - /var/tmp/offload/skills     # big, ephemeral
```

Verified behaviour:

- The dir is searched as a lower tier than the local skills dir, so local
  skills win on a name collision.
- It is read-only: newly created skills still land in the local skills dir.
- A directory that does not exist is skipped silently (debug-level log only),
  so a missing external dir degrades to "skill just isn't there" — acceptable
  for an ephemeral cache, unacceptable for required content.
- Because the external dir is ephemeral, its contents must be restorable from
  the repo; re-pull them at boot, or they are simply absent after a recreate.

### Off-volume content has THREE locations, and the middle one is the trap

"The big disk" and "the repository" are not the same thing. Conflating them
hides the failure that actually happens:

| place | lifetime | role |
| --- | --- | --- |
| the large mount (e.g. `<offload>/skills`) | ephemeral | live copy the application reads |
| a staging dir inside the small state root (e.g. `<state-root>/skills/.offloaded`) | persistent | snapshot the repo sync picks up |
| the repo (e.g. `state/skills/.offloaded/`) | permanent | the durable copy |

Install writes the live copy off-volume. Push copies it into staging. **On a
rebuild the repo copy restores to staging — which is not a path the application
scans.** The content is then restored and simultaneously invisible: the files are
present on disk and the loader cannot find them.

Close it in the same periodic job that recreates the offload directories:

```sh
STAGE="<state-root>/skills/.offloaded"
if [ -d "$STAGE" ]; then
    for d in "$STAGE"/*/; do
        [ -f "${d}SKILL.md" ] || continue
        name="$(basename "$d")"
        # cmp-guard so a live edit is not silently reverted on every tick.
        if [ ! -f "$OFFLOAD/skills/$name/SKILL.md" ] || \
           ! cmp -s "${d}SKILL.md" "$OFFLOAD/skills/$name/SKILL.md"; then
            rm -rf "$OFFLOAD/skills/$name"
            cp -R "$d" "$OFFLOAD/skills/$name"
        fi
    done
fi
```

The guard matters: without it every tick overwrites a live edit, and the
application's own writes to the offloaded item are lost on a schedule.

Verify the whole loop, not just the install. Found only by testing: wipe the live
dir, restore from the repo, run the job, and confirm the loader's own API can
read the item again (`skill_view <name>` returning success, not just the file
existing). Checking the file path alone would have passed while the loader still
reported it missing.

## 7. Watermark the small volume

A fill check in the periodic job surfaces the problem while it is still
recoverable. Report the level, and name the remediation command in the report
rather than only the number:

```sh
pct=$(df -P <small-volume> | tail -1 | awk '{print $5}' | tr -d '%')
[ "$pct" -ge 85 ] && echo "WARNING: small volume ${pct}% full"
```

## 8. What to tell the user

Separate the three buckets explicitly, because they call for different words:

- **protected** — in the durable store, and recovery was proven by test.
- **excluded by rule** — deliberately local (temp, caches, live databases);
  name the big ones so the choice is visible.
- **not covered** — the honest gap. Say it plainly, say what would fix it, and
  do not let a green status imply otherwise.

"Nothing is ever on local disk" is not a reachable state and is not the right
target. A handful of tiny, rebuildable, deliberately-local files is normal and
desirable; the goal is that nothing *irreplaceable* is only there, and that the
small volume cannot be filled by accident.
