#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Detached launcher for the Hermes gateway supervisor.
#
# `setsid nohup` puts the supervisor in its own session with no controlling
# TTY. That is what makes it survive both (a) the death of the terminal session
# that started it and (b) Hermes' own process-group cleanup, which kills
# `killpg()` on the group of every terminal command it ran — a different
# session is untouchable by that.
#
# Safe to run repeatedly: the supervisor holds an flock, so only one survives.
# ─────────────────────────────────────────────────────────────────────────────

set -u

SUPERVISOR="${HOME}/.hermes/scripts/gateway_supervisor.sh"

setsid nohup "$SUPERVISOR" >/dev/null 2>&1 &
exit 0
