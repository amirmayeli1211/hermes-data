#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Hermes Gateway Supervisor
#
# Keeps `hermes gateway run` alive on hosts WITHOUT systemd (containers,
# sandboxes running tini/boxd, WSL without systemd, etc.).
#
# Why this exists: when the gateway receives an unexpected SIGTERM it exits
# with code 1 *on purpose*, because it expects systemd's Restart=on-failure to
# bring it back (see gateway/run.py). On this host there is no systemd, so
# nothing revives it and the agent goes permanently offline.
#
# This script is the missing supervisor. It is started detached (setsid) so it
# has no controlling TTY and therefore survives the death of the terminal
# session that launched it — which is exactly what was killing the gateway.
#
# Silent by design: everything goes to a log FILE, never to chat.
# ─────────────────────────────────────────────────────────────────────────────

set -u

HERMES_BIN="/usr/local/lib/hermes-agent/venv/bin/hermes"
LOG_DIR="${HOME}/.hermes/logs"
SUP_LOG="${LOG_DIR}/gateway-supervisor.log"
LOCK_FILE="${HOME}/.hermes/gateway-supervisor.lock"
RESTART_DELAY=5
GW_PATTERN="venv/bin/hermes gateway run"

export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin"

# ── Offload area (big scratch on the real disk, never tmpfs) ────────────────
# /tmp is a 996 MB tmpfs: contents are RAM, so a large temp job both fails and
# starves the gateway. /var/tmp-style paths do not survive a container restart,
# so the tree is re-created before every launch — a TMPDIR that points at a
# missing directory is worse than unset, because Python silently falls back to
# a candidate inside HERMES_HOME. See scripts/offload.sh.
export HERMES_OFFLOAD_ROOT="${HERMES_OFFLOAD_ROOT:-/home/user/hermes-offload}"
mkdir -p "$HERMES_OFFLOAD_ROOT"/tmp "$HERMES_OFFLOAD_ROOT"/work \
         "$HERMES_OFFLOAD_ROOT"/downloads "$HERMES_OFFLOAD_ROOT"/clones \
         "$HERMES_OFFLOAD_ROOT"/skills 2>/dev/null || true
export TMPDIR="$HERMES_OFFLOAD_ROOT/tmp"
export TMP="$TMPDIR"
export TEMP="$TMPDIR"
export HERMES_WORKBENCH="$HERMES_OFFLOAD_ROOT/work"

mkdir -p "$LOG_DIR"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >> "$SUP_LOG"; }

# ── Single-instance guard ────────────────────────────────────────────────────
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "another supervisor already holds the lock; exiting"
    exit 0
fi

# ── Wait for any pre-existing (unsupervised) gateway to go away ──────────────
# Prevents two Telegram pollers running at once ("Conflict: terminated by
# other getUpdates request") during the cutover to supervised operation.
terminate_stale_gateways() {
    local waited=0
    while pgrep -f "$GW_PATTERN" >/dev/null 2>&1; do
        if [ "$waited" -eq 0 ]; then
            log "stale gateway detected — sending SIGTERM"
        fi
        pkill -TERM -f "$GW_PATTERN" 2>/dev/null
        sleep 2
        waited=$((waited + 2))
        if [ "$waited" -ge 120 ]; then
            log "stale gateway still alive after ${waited}s — sending SIGKILL"
            pkill -KILL -f "$GW_PATTERN" 2>/dev/null
            sleep 2
            break
        fi
    done
    [ "$waited" -gt 0 ] && log "stale gateway cleared after ${waited}s"
    return 0
}

terminate_stale_gateways

log "=== supervisor started (pid $$) ==="

# ── Supervision loop ─────────────────────────────────────────────────────────
delay="$RESTART_DELAY"

while true; do
    started_at=$(date +%s)
    log "launching: $HERMES_BIN gateway run"
    "$HERMES_BIN" gateway run < /dev/null >> "$SUP_LOG" 2>&1
    rc=$?
    ran_for=$(( $(date +%s) - started_at ))

    # Adaptive backoff: a gateway that dies fast is crash-looping (bad config,
    # missing platform credential, DNS failure). Slow down instead of hammering
    # it, and reset to the normal delay once a run actually gets established.
    if [ "$ran_for" -lt 10 ]; then
        delay=$(( delay * 2 ))
        [ "$delay" -gt 60 ] && delay=60
    else
        delay="$RESTART_DELAY"
    fi

    log "gateway exited rc=$rc after ${ran_for}s — restarting in ${delay}s"
    sleep "$delay"
done
