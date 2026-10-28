#!/bin/sh
# disk-reclaim-survey.sh — READ-ONLY. Answers "where did the disk go?" BEFORE
# anything is deleted. Deletes nothing, writes nothing.
#
#   sh disk-reclaim-survey.sh                # usage + top consumers + cache sizes
#   sh disk-reclaim-survey.sh --duplicates   # also hash-scan for real duplicates
#
# Companion to references/disk-reclamation.md. Exit status is always 0 so it is
# safe to run from a cron wrapper or a health check.

set -u

MOUNT="${HERMES_DISK_GUARD_MOUNT:-/}"
DEV_HOME="${HERMES_DEV_HOME:-/home/user}"

printf '== %s ==\n' "$MOUNT"
df -h "$MOUNT" | tail -1

printf '\n== top consumers on this filesystem ==\n'
du -x -h --max-depth=1 "$MOUNT" 2>/dev/null | sort -rh | head -12

printf '\n== reclaimable caches (rebuildable; delete these before anything else) ==\n'
for t in \
    "$DEV_HOME/.gradle/caches" \
    "$DEV_HOME/.gradle/wrapper/dists" \
    "$DEV_HOME/.npm/_cacache" \
    "$DEV_HOME/.cache/pip" \
    "/root/.local/share/uv" ; do
    if [ -d "$t" ]; then
        printf '  %-46s %s\n' "$t" "$(du -sh "$t" 2>/dev/null | cut -f1)"
    else
        printf '  %-46s %s\n' "$t" "absent"
    fi
done
# Per-project build output. Quoted globs: no match stays literal and fails -d.
for b in "$DEV_HOME"/.hermes/projects/*/build \
         "$DEV_HOME"/.hermes/projects/*/app/build \
         "$DEV_HOME"/.hermes/projects/*/.kotlin/sessions ; do
    [ -d "$b" ] || continue
    printf '  %-46s %s\n' "$b" "$(du -sh "$b" 2>/dev/null | cut -f1)"
done

if [ "${1:-}" = "--duplicates" ]; then
    printf '\n== duplicate payload (files >=1 MiB under /home /root /opt /var /srv) ==\n'
    python3 - <<'PY'
import collections
import hashlib
import os

ROOTS = ["/home", "/root", "/opt", "/var", "/srv"]
by_size = collections.defaultdict(list)

for root in ROOTS:
    for dp, _dns, fns in os.walk(root, onerror=lambda e: None):
        for fn in fns:
            p = os.path.join(dp, fn)
            try:
                st = os.lstat(p)
            except OSError:
                continue
            if os.path.islink(p) or not os.path.isfile(p):
                continue
            if st.st_size >= 1 << 20:
                by_size[st.st_size].append(p)

groups, wasted = [], 0
for size, paths in by_size.items():
    if len(paths) < 2:
        continue
    by_hash = collections.defaultdict(list)
    for p in paths:
        try:
            h = hashlib.md5()
            with open(p, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            by_hash[h.hexdigest()].append(p)
        except OSError:
            pass
    for plist in by_hash.values():
        if len(plist) > 1:
            groups.append((size, plist))
            wasted += size * (len(plist) - 1)

print(f"  files >=1MiB scanned: {sum(len(v) for v in by_size.values())}")
print(f"  duplicate groups: {len(groups)}    reclaimable: {wasted/1048576:.1f} MiB")
for size, plist in sorted(groups, key=lambda g: -g[0])[:10]:
    print(f"  [{size/1048576:.1f} MiB x{len(plist)}]")
    for p in plist:
        print("      " + p)

if wasted < 64 * 1048576:
    print("  -> negligible. Duplicates on a host like this sit INSIDE tool")
    print("     distributions (Gradle dist, Android cmdline-tools, Ghidra jars),")
    print("     where deleting them breaks the tool. Reclaim the caches above.")
    print("     See references/disk-reclamation.md")
PY
fi

exit 0
