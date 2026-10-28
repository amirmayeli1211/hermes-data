#!/usr/bin/env bash
# disk_guard_watch.sh — scheduled disk guard with a quiet-by-default contract.
#
# Runs the ported disk-guard.sh (tiers 1-2 at >=75%, tier 3 at >=88%) and speaks
# only when it matters:
#
#   * critical level reached          -> report (always)
#   * a reclaim freed >= 200 MiB      -> report (worth knowing)
#   * guard failed to run (exit >= 3) -> report (a broken guard is silent danger)
#   * otherwise                       -> print nothing, exit 0
#
# Empty stdout + exit 0 is the scheduler's "nothing to report" signal.
set -u

export PATH="/usr/local/bin:/usr/bin:/bin"

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
GUARD="$SCRIPTS_DIR/disk-guard.sh"
MOUNT="${HERMES_DISK_GUARD_MOUNT:-/}"
THRESHOLD_MIB="${DISK_GUARD_REPORT_MIB:-200}"

[ -f "$GUARD" ] || { echo "disk-guard FAILED: $GUARD is missing"; exit 1; }

free_before="$(df -P "$MOUNT" | tail -1 | awk '{print $4}')"
OFFLOAD="$SCRIPTS_DIR/offload.sh"
# Stale scratch in the offload area is the one cache disk-guard does not know
# about (it only looks inside HERMES_HOME), so it is swept here. Its output is
# captured, not printed: a synced-in wrapper must stay quiet on a normal run.
if [ -f "$OFFLOAD" ]; then
    HERMES_HOME="${HERMES_HOME:-/home/user/.hermes}" sh "$OFFLOAD" clean >/dev/null 2>&1 || true
fi
out="$(HERMES_HOME="${HERMES_HOME:-/home/user/.hermes}" sh "$GUARD" clean 2>&1)"
rc=$?
free_after="$(df -P "$MOUNT" | tail -1 | awk '{print $4}')"
freed_mib=$(( (free_after - free_before) / 1024 ))
pct="$(df -P "$MOUNT" | tail -1 | awk '{print $5}')"

case "$rc" in
    0) level="ok" ;;
    1) level="warning" ;;
    2) level="critical" ;;
    *) echo "disk-guard FAILED (exit $rc) on $MOUNT"
       echo "$out" | tail -8
       exit 1 ;;
esac

if [ "$level" = "critical" ] || [ "$freed_mib" -ge "$THRESHOLD_MIB" ]; then
    echo "disk-guard: $MOUNT at $pct used — reclaimed ${freed_mib} MiB (level: $level)"
    echo "$out" | grep -E "reclaimed|result:|level:" | head -12
    exit 0
fi

exit 0
