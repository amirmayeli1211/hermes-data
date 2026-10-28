#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Hermes Gateway Keepalive (safety net for the supervisor)
#
# Runs from Hermes cron as a no_agent job. Its job is ONLY to make sure the
# detached supervisor process (gateway_supervisor.sh) is alive. If the
# supervisor is missing it relaunches it detached.
#
# DELIVERY CONTRACT: prints NOTHING when everything is healthy. An empty stdout
# means the cron scheduler sends no message at all — so this job is completely
# silent in normal operation and only speaks when it actually had to act.
# ─────────────────────────────────────────────────────────────────────────────

set -u

SUPERVISOR="${HOME}/.hermes/scripts/gateway_supervisor.sh"
SUP_LOG="${HOME}/.hermes/logs/gateway-supervisor.log"
SUP_PATTERN="scripts/gateway_supervisor.sh"

export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin"

# Healthy: supervisor alive → say nothing, exit quietly.
if pgrep -f "$SUP_PATTERN" >/dev/null 2>&1; then
    exit 0
fi

# Not healthy: bring the supervisor back, fully detached from any TTY.
mkdir -p "$(dirname "$SUP_LOG")"
printf '[%s] keepalive: supervisor missing — relaunching\n' "$(date -u +%FT%TZ)" >> "$SUP_LOG"

setsid nohup "$SUPERVISOR" >/dev/null 2>&1 &

sleep 3

if pgrep -f "$SUP_PATTERN" >/dev/null 2>&1; then
    echo "⚠️ Hermes gateway supervisor was down — relaunched it. The gateway should be back online within ~10s."
else
    echo "❌ Hermes gateway supervisor was down and could NOT be relaunched. Check ~/.hermes/logs/gateway-supervisor.log"
fi
