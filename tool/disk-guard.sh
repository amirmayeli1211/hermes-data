#!/bin/sh
# disk-guard.sh — keep /data from filling up and taking the gateway down.
#
# WHY THIS EXISTS
#   /data is 434 MB and persistent. It holds state.db (session history), the
#   gateway's logs, and the caches Hermes rebuilds. When it fills, the gateway
#   cannot write, crashes, and the agent stops responding entirely — there is no
#   graceful degradation. So this runs on a schedule and reclaims space BEFORE
#   that happens, escalating only as far as needed.
#
# WHAT MAY BE RECLAIMED, in order of increasing cost
#
#   tier 1  pure garbage, zero information loss
#           *.wal files after a checkpoint, rotated logs, stale locks,
#           __pycache__, .pyc, orphaned tmp
#   tier 2  rebuildable caches, re-downloaded on next use (a few seconds of cost)
#           models_dev_cache.json (5.6 MB!), provider_models_cache.json,
#           model catalogs, usage snapshots
#   tier 3  old history, lost but not essential — ONLY above the critical
#           threshold, and only the oldest items
#           hermes backup zips, cron output older than 7 days, sessions
#           mirror JSON, logs older than 3 days
#
#   NEVER touched, at any threshold:
#     .env  auth.json  config.yaml  SOUL.md  memories/  skills/  state.db
#     ghfirst/  kanban.db  shared/  plans/  cron/jobs.json
#
# Note on state.db: it is the one file that both matters and can be large. This
# script NEVER deletes it. It only runs a WAL checkpoint, which is safe and
# lossless — verified on the live database (2.8 MB reclaimed, integrity_check ok,
# all session rows still readable) — and that alone is usually enough.
#
# Usage:
#   sh disk-guard.sh check          report usage, change nothing
#   sh disk-guard.sh clean          reclaim only what the current level needs
#   sh disk-guard.sh clean --force  run all three tiers regardless of usage
#
# Exit codes: 0 fine · 1 warning level · 2 critical level

set -u

HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
MOUNT="${HERMES_DISK_GUARD_MOUNT:-/data}"

# Thresholds as percent used.
WARN_PCT="${HERMES_DISK_WARN_PCT:-75}"
CRIT_PCT="${HERMES_DISK_CRIT_PCT:-88}"

FORCE=0
[ "${2:-}" = "--force" ] && FORCE=1

log() { printf '%s\n' "$*"; }

pct_used() { df -P "$MOUNT" 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%'; }
free_h()   { df -h "$MOUNT" 2>/dev/null | tail -1 | awk '{print $4}'; }
used_h()   { df -h "$MOUNT" 2>/dev/null | tail -1 | awk '{print $3}'; }
total_h()  { df -h "$MOUNT" 2>/dev/null | tail -1 | awk '{print $2}'; }

# Print the free-space delta around a reclaim step so the report shows what worked.
# df -P reports 1024-byte blocks, so the delta/1024 is MiB, not KiB. Mislabeling
# this as KiB understated a 290 MiB reclaim as "290 KiB".
reclaim() {
    label="$1"; shift
    before="$(df -P "$MOUNT" | tail -1 | awk '{print $4}')"
    "$@" >/dev/null 2>&1 || true
    after="$(df -P "$MOUNT" | tail -1 | awk '{print $4}')"
    gained=$(( (after - before) / 1024 ))
    if [ "$gained" -ge 1024 ]; then
        log "    $label: reclaimed $((gained / 1024)) GiB"
    elif [ "$gained" -gt 0 ]; then
        log "    $label: reclaimed ${gained} MiB"
    else
        log "    $label: nothing to reclaim"
    fi
    RECLAIMED=$((RECLAIMED + (after - before)))
}

RECLAIMED=0

# --- tier 1: garbage -------------------------------------------------------

tier1() {
    log "  tier 1 — pure garbage:"

    # WAL checkpoint. Safe on a live DB: SQLite handles the concurrency, and a
    # busy database simply returns without truncating. This is the single most
    # valuable step because the WAL grows with every conversation turn.
    reclaim "sqlite WAL checkpoints" python3 -c "
import sqlite3, glob, os
for db in glob.glob('${HERMES_HOME}/**/*.db', recursive=True):
    try:
        c = sqlite3.connect(db, timeout=2)
        c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        c.close()
    except Exception:
        pass
"

    reclaim "orphaned temp files" find "${HERMES_HOME}/cache/scratch" \
        -mindepth 1 -mmin +120 -delete

    reclaim "python bytecode" find "${HERMES_HOME}" -name '__pycache__' \
        -type d -prune -exec rm -rf {} +

    # Lock files are deliberately NOT touched. They are 0 bytes, so deleting them
    # frees nothing, while removing one that a live process still holds invites a
    # race (two writers believing they hold the same lock). Observed: this rule
    # removed skills/.locks/*.lock on a --force run, which freed 0 KiB.

    # Rotated/oversized gateway logs. The active file is kept; Hermes only ever
    # appends, so truncating an oversized log loses diagnostic history, not state.
    for lg in "${HERMES_HOME}"/logs/*.log; do
        [ -f "$lg" ] || continue
        size="$(stat -c%s "$lg" 2>/dev/null || echo 0)"
        if [ "$size" -gt 10485760 ]; then
            reclaim "$(basename "$lg") truncated" truncate -s 2M "$lg"
        fi
    done
}

# --- tier 2: rebuildable caches -------------------------------------------

tier2() {
    log "  tier 2 — rebuildable caches (re-downloaded on next use):"

    # These are vendored copies of remote catalogs, refreshed automatically.
    for f in models_dev_cache.json models_dev_cache.etag \
             provider_models_cache.json; do
        [ -f "${HERMES_HOME}/$f" ] || continue
        sz="$(du -h "${HERMES_HOME}/$f" 2>/dev/null | cut -f1)"
        reclaim "$f ($sz)" rm -f "${HERMES_HOME}/$f"
    done

    reclaim "tool-discovery cache" rm -rf "${HERMES_HOME}/cache/tool_discovery_cache.json"
    reclaim "usage snapshot" rm -f "${HERMES_HOME}/cache/usage_snapshot.json"
}

# --- tier 3: history, only when critical ----------------------------------

tier3() {
    log "  tier 3 — old history (last resort; oldest items first):"

    # Backup zips. A backup you cannot restore is just clutter, and the real
    # durable copy is the GitHub repo. Keep the newest two.
    if [ -d "${HERMES_HOME}/backups" ]; then
        ls -1t "${HERMES_HOME}"/backups/*.zip 2>/dev/null | tail -n +3 > "${HERMES_HOME}/cache/.oldbak" 2>/dev/null
        if [ -s "${HERMES_HOME}/cache/.oldbak" ]; then
            reclaim "old backup zips" sh -c \
                "while read -r f; do rm -f \"\$f\"; done < '${HERMES_HOME}/cache/.oldbak'"
        fi
        rm -f "${HERMES_HOME}/cache/.oldbak"
    fi

    reclaim "cron output >7d" find "${HERMES_HOME}/cron/output" -type f -mtime +7 -delete

    reclaim "logs >3d" find "${HERMES_HOME}/logs" -type f -mtime +3 -delete

    # The legacy routing mirror; canonical data is in state.db.
    reclaim "sessions mirror" find "${HERMES_HOME}/sessions" -type f -mtime +3 -delete

    reclaim "generated media >7d" find "${HERMES_HOME}/audio_cache" "${HERMES_HOME}/image_cache" \
        -type f -mtime +7 -delete 2>/dev/null
}

# --- safety guard ---------------------------------------------------------

# Refuse to run if this is not the filesystem we think it is. A wrong
# HERMES_HOME would make every `find` below a no-op at best and destructive at
# worst; a mount that is not /data means the thresholds are meaningless.
preflight() {
    if [ ! -d "$HERMES_HOME" ]; then
        log "ERROR: HERMES_HOME ($HERMES_HOME) does not exist." >&2
        exit 3
    fi
    case "$HERMES_HOME" in
        /*) : ;;
        *) log "ERROR: HERMES_HOME must be an absolute path." >&2; exit 3 ;;
    esac
    for protected in .env config.yaml; do
        if [ ! -e "${HERMES_HOME}/${protected}" ]; then
            log "WARNING: ${HERMES_HOME}/${protected} is missing — is this the right home?" >&2
        fi
    done
    # free space must be parseable; a broken df means we cannot judge anything
    if ! df -P "$MOUNT" >/dev/null 2>&1; then
        log "ERROR: cannot read disk usage for $MOUNT" >&2
        exit 3
    fi
}

preflight

PCT="$(pct_used)"

case "${1:-check}" in
    check)
        log "disk-guard: $MOUNT ${PCT}% used ($(used_h) of $(total_h), $(free_h) free)"
        if [ "$PCT" -ge "$CRIT_PCT" ]; then
            log "  level: CRITICAL (>= ${CRIT_PCT}%)"
            log "  would run: tier 1 + tier 2 + tier 3"
            exit 2
        elif [ "$PCT" -ge "$WARN_PCT" ]; then
            log "  level: WARNING (>= ${WARN_PCT}%)"
            log "  would run: tier 1 + tier 2"
            exit 1
        fi
        log "  level: OK (< ${WARN_PCT}%)"
        log "  would run: tier 1 only"
        exit 0
        ;;

    clean)
        log "disk-guard: $MOUNT ${PCT}% used ($(free_h) free)"
        if [ "$FORCE" -eq 1 ]; then
            log "  --force: running all tiers"
            level=3
        elif [ "$PCT" -ge "$CRIT_PCT" ]; then
            log "  CRITICAL — escalating to all tiers"
            level=3
        elif [ "$PCT" -ge "$WARN_PCT" ]; then
            log "  WARNING — running tiers 1-2"
            level=2
        else
            log "  OK — running tier 1 only"
            level=1
        fi

        tier1
        [ "$level" -ge 2 ] && tier2
        [ "$level" -ge 3 ] && tier3

        after="$(pct_used)"
        log "  result: ${PCT}% -> ${after}% used, $(free_h) free"
        if [ "$after" -ge "$CRIT_PCT" ]; then
            log ""
            log "  STILL CRITICAL after cleanup. Everything reclaimable is gone."
            log "  remaining space is real data:"
            du -sh "${HERMES_HOME}"/* 2>/dev/null | sort -rh | head -8 | sed 's/^/    /'
            log "  the durable files (config, memories, skills, credentials) are the"
            log "  ones that must not be deleted; consider a larger /data volume."
            exit 2
        fi
        exit 0
        ;;

    *)
        log "usage: sh disk-guard.sh [check|clean] [--force]" >&2
        exit 64
        ;;
esac
