#!/usr/bin/env bash
# Push this instance's durable Hermes state to the hermes-data repository
# (the GitHub-side "second disk": state, skills, cron scripts, projects).
#
# Silence is the contract: a successful run prints NOTHING, so a scheduled run
# only ever speaks when it synced-and-wants-to-say-so or when it failed. Empty
# stdout + exit 0 means "nothing to report".
set -u

export PATH="/usr/local/bin:/usr/bin:/bin"

REPO="${GHSTORE_REPO:-amirmayeli1211/hermes-data}"
HOME_DIR="${HERMES_HOME:-/home/user/.hermes}"
STORE="${GHSTORE_DIR:-/home/user/hermes-data}"
LOG="${GHSTORE_LOG:-$HOME_DIR/logs/ghstore-sync.log}"

mkdir -p "$(dirname "$LOG")"

if [ ! -f "$STORE/tool/ghstore.py" ]; then
    echo "hermes-data sync FAILED: $STORE/tool/ghstore.py is missing"
    exit 1
fi

out=$(HERMES_HOME="$HOME_DIR" python3 "$STORE/tool/ghstore.py" push --repo "$REPO" 2>&1)
rc=$?

printf '[%s] rc=%s\n%s\n' "$(date -u +%FT%TZ)" "$rc" "$out" >> "$LOG"
# Keep the log bounded; the repo itself is the durable record.
if [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 4000 ]; then
    tail -2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

if [ "$rc" -eq 0 ]; then
    # Quiet on success, including "no changes since the last sync".
    exit 0
fi

echo "hermes-data sync FAILED (exit $rc)"
echo "$out" | tail -12
exit "$rc"
