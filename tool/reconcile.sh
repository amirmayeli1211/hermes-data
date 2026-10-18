# ghstore cron entrypoint — scheduled push + verify + drift report
#
# Wire this into Hermes cron (or system cron) so the repo stays current without
# the container depending on its own disk. Output is a single short block; the
# cron job's configured delivery target decides where it lands.
#
# Intended schedule: every 30 minutes.
#   hermes cron: prompt "run /data/.hermes/ghfirst/reconcile.sh and report its output"
#   system cron: */30 * * * * /data/.hermes/ghfirst/reconcile.sh >> /data/.hermes/logs/ghstore.log 2>&1

set -u

HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
TOOL="${HERMES_HOME}/ghfirst/ghstore.py"
PY="${HERMES_PYTHON:-$(command -v python3)}"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ ! -f "$TOOL" ]; then
    echo "ghstore reconcile $STAMP: FAILED — $TOOL missing"
    exit 3
fi

echo "ghstore reconcile $STAMP"

# 0. Recreate the offload area. /var/tmp is on the ephemeral overlay, so after a
#    container restart the offload directories are gone while .env still points
#    TMPDIR at them — and a TMPDIR that does not exist makes Python fall back to
#    $HERMES_HOME/cache/scratch, i.e. the small persistent disk we are guarding.
#    Running this first every tick keeps that fallback from ever being reachable.
if [ -f "${HERMES_HOME}/ghfirst/offload-boot.sh" ]; then
    sh "${HERMES_HOME}/ghfirst/offload-boot.sh" 2>&1 || \
        echo "offload-boot: failed (temp may fall back to the small disk)"
fi

# 0b. Disk watchdog on the SMALL persistent volume. It is 434 MB; a runaway temp
#     file or a log spiral can exhaust it, and a full /data takes the gateway
#     down with it. This RECLAIMS space (not just warns): tier 1 always, and
#     escalating tiers as usage rises. Protected at every level: .env, auth.json,
#     config.yaml, SOUL.md, memories/, skills/, state.db, ghfirst/.
GUARD="${HERMES_HOME}/ghfirst/disk-guard.sh"
if [ -f "$GUARD" ]; then
    sh "$GUARD" clean 2>&1
    guard_rc=$?
    if [ "$guard_rc" -ge 2 ]; then
        echo "DISK: still critical after cleanup — real data needs a bigger volume"
    fi
else
    DATA_PCT="$(df -P /data | tail -1 | awk '{print $5}' | tr -d '%')"
    DATA_FREE="$(df -h /data | tail -1 | awk '{print $4}')"
    echo "disk: /data ${DATA_PCT}% used (${DATA_FREE} free) — disk-guard.sh missing"
fi

# 1. Push any local changes (the tool aborts on secret hits or conflicts).
"$PY" "$TOOL" push 2>&1
push_rc=$?

case "$push_rc" in
    0) echo "push: ok" ;;
    4) echo "push: BLOCKED by secret gate — nothing written"; exit 4 ;;
    5) echo "push: BLOCKED by conflict — both sides changed"; exit 5 ;;
    10) echo "push: FAILED (network/API) — will retry next tick"; exit 10 ;;
    *) echo "push: unexpected exit $push_rc"; exit "$push_rc" ;;
esac

# 2. Independently verify the committed tree indexes every file we hold.
"$PY" "$TOOL" verify 2>&1
verify_rc=$?
if [ "$verify_rc" -ne 0 ]; then
    echo "verify: FAILED (exit $verify_rc) — repository integrity problem"
    exit "$verify_rc"
fi
echo "verify: ok"

# 3. Report drift so silent divergence surfaces instead of hiding.
"$PY" "$TOOL" status 2>&1 | tail -6
exit 0
