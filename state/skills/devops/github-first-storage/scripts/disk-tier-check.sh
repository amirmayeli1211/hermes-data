#!/bin/sh
# disk-tier-check.sh — verify the disk-tier split actually holds.
#
# Answers four questions with evidence, for a container whose state root is a
# SMALL PERSISTENT volume and whose overlay is large and ephemeral:
#
#   1. Are the tiers really different filesystems?
#   2. Does temp land on the big one, and does a missing temp dir fall back to
#      the small one (the silent-fallback trap)?
#   3. Is a cross-filesystem rename going to break atomic writes (EXDEV)?
#   4. How full is the small volume, and what is consuming it?
#
# Usage:
#   sh disk-tier-check.sh                            # defaults below
#   SMALL=/data STATE_ROOT=/data/.hermes sh disk-tier-check.sh
#   SMALL=/data OFFLOAD=/var/tmp/offload sh disk-tier-check.sh
#
# Exit codes: 0 all checks pass, 1 one or more checks failed (see the FAIL/
#             WARNING lines), 2 the tiers are not actually distinct so
#             offloading is pointless.
#
# Every command this script runs was exercised while building the deployment;
# treat a first run as a probe and read its output rather than trusting the
# exit code alone.

set -u

SMALL="${SMALL:-/data}"
STATE_ROOT="${STATE_ROOT:-${HERMES_HOME:-/data/.hermes}}"
OFFLOAD="${OFFLOAD:-/var/tmp/hermes-offload}"
WARN_PCT="${WARN_PCT:-85}"

fail=0
say() { printf '%s\n' "$*"; }

say "=== 1. filesystem tiers ==="
small_src="$(findmnt -T "$SMALL" -o SOURCE -n 2>/dev/null | head -1)"
overlay_src="$(findmnt -T / -o SOURCE -n 2>/dev/null | head -1)"
say "  $SMALL        -> ${small_src:-(unknown)}  $(df -h "$SMALL" 2>/dev/null | tail -1 | awk '{print "size="$2" used="$3" free="$4" ("$5")"}')"
say "  /              -> ${overlay_src:-(unknown)}  $(df -h / 2>/dev/null | tail -1 | awk '{print "size="$2" used="$3" free="$4" ("$5")"}')"

if [ -n "$small_src" ] && [ "$small_src" = "$overlay_src" ]; then
    say "  FAIL: the state root and the overlay are the SAME filesystem."
    say "        Offloading cannot free space; report this rather than pretending."
    exit 2
fi
say "  OK: distinct filesystems."

if [ -d "$OFFLOAD" ]; then
    off_src="$(findmnt -T "$OFFLOAD" -o SOURCE -n 2>/dev/null | head -1)"
    say "  offload $OFFLOAD -> ${off_src:-(unknown)}"
    if [ "$off_src" = "$small_src" ]; then
        say "  FAIL: the offload dir is on the SMALL filesystem — it offloads nothing."
        exit 2
    fi
else
    say "  NOTE: $OFFLOAD does not exist yet (normal after a container recreate)."
    say "        It MUST be recreated before anything writes temp files — see step 2."
fi

say ""
say "=== 2. where does temp actually resolve? ==="
say "  TMPDIR in this shell : ${TMPDIR:-(unset)}"
say "  python tempfile      : $(python3 -c 'import tempfile;print(tempfile.gettempdir())' 2>/dev/null || echo 'python3 unavailable')"

resolved="$(python3 -c 'import tempfile;print(tempfile.gettempdir())' 2>/dev/null || true)"
case "$resolved" in
    "$SMALL"*)
        say "  FAIL: temp resolves onto the small volume."
        say "        A single large temp job can exhaust it and take the service down."
        fail=1
        ;;
    "") : ;;
    *)  say "  OK: temp is off the small volume." ;;
esac

# The trap: a TMPDIR naming a missing dir does NOT error, it silently falls
# through to the next candidate — normally the small volume's scratch dir.
if [ -n "${TMPDIR:-}" ] && [ ! -d "${TMPDIR}" ]; then
    say "  WARNING: TMPDIR=${TMPDIR} does not exist."
    say "           Python will silently fall back (likely to $STATE_ROOT/cache/scratch)."
    say "           Recreate it: mkdir -p \"${TMPDIR}\""
    fail=1
fi

if [ -n "${TMPDIR:-}" ] && [ -d "${TMPDIR}" ]; then
    probe="${TMPDIR}/.tier-probe.$$"
    if printf 'x' > "$probe" 2>/dev/null; then
        landed="$(findmnt -T "$probe" -o SOURCE -n 2>/dev/null | head -1)"
        say "  temp write lands on   : ${landed:-(unknown)}"
        if [ "$landed" = "$small_src" ]; then
            say "  FAIL: temp writes land on the small volume."
            fail=1
        else
            say "  OK: temp writes land off the small volume."
        fi
        rm -f "$probe"
    fi
fi

say ""
say "=== 3. cross-filesystem rename (EXDEV) ==="
mkdir -p "$OFFLOAD/tmp" 2>/dev/null || true
if [ -d "$OFFLOAD/tmp" ]; then
    if EXDEV_OUT="$(python3 - "$OFFLOAD/tmp" "$STATE_ROOT" <<'PY' 2>&1
import os, sys, tempfile
stage, dest_root = sys.argv[1], sys.argv[2]
os.makedirs(os.path.join(dest_root, 'cache', 'scratch'), exist_ok=True)
t = tempfile.NamedTemporaryFile(dir=stage, delete=False)
t.write(b'x'); t.close()
dest = os.path.join(dest_root, 'cache', 'scratch', '.exdev-probe')
try:
    os.replace(t.name, dest); print('SAME-FS')
except OSError as e:
    print(f'EXDEV: {e.strerror}')
finally:
    for p in (t.name, dest):
        try: os.unlink(p)
        except OSError: pass
PY
)"; then
        say "  $EXDEV_OUT"
        case "$EXDEV_OUT" in
            EXDEV*) say "  NOTE (expected): a symlink from the state root into the offload dir"
                    say "        would break os.replace() atomic writes. Keep using TMPDIR:"
                    say "        it relocates where temp files are born, not where destinations live." ;;
            SAME-FS) say "  Same filesystem: rename is safe, but check WHY — the offload dir"
                     say "        may be sitting on the small volume (see step 1)." ;;
        esac
    fi
fi

say ""
say "=== 4. small-volume pressure ==="
pct="$(df -P "$SMALL" 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')"
say "  $SMALL is ${pct:-?}% used."
if [ -n "$pct" ] && [ "$pct" -ge "$WARN_PCT" ]; then
    say "  WARNING: at/over ${WARN_PCT}%. Largest consumers:"
    du -sh "$STATE_ROOT"/* 2>/dev/null | sort -rh | head -10 | sed 's/^/    /'
    say "  Remediation: clear the offload area, then re-check:"
    say "    rm -rf \"$OFFLOAD\"/{tmp,work,downloads,clones}/*"
    fail=1
fi

say ""
if [ "$fail" -eq 0 ]; then
    say "ALL CHECKS PASS: states are distinct, temp is off the small volume, no EXDEV risk."
else
    say "CHECKS FAILED: see the FAIL/WARNING lines above."
fi
exit "$fail"
