#!/bin/sh
# offload.sh — keep the small persistent disk (/data) out of harm's way.
#
# THE PROBLEM THIS SOLVES
#   The container has two very different filesystems:
#
#     /       overlay   2.9 TB   EPHEMERAL (gone on restart)  <-- plenty of room
#     /data   ext4      434 MB   PERSISTENT (a real volume)    <-- tiny, valuable
#
#   Hermes sets TMPDIR=$HERMES_HOME/cache/scratch, which is on the SMALL disk.
#   Measured: a single 500 MB temp job filled /data to 100%. That is the real
#   risk to "the main disk filling up" — not skills, which are 3.9 MB.
#
# THE RULE
#   Tier 1 (/data)      : only durable data that is small or irreplaceable —
#                         config, memories, credentials, the ghstore tool.
#   Tier 2 ($OFFLOAD)   : everything big or rebuildable — temp files, scratch,
#                         downloads, clones, builds, skill working copies.
#
#   Anything allowed into Tier 2 must be restorable from the GitHub repo.
#   If it is not in the repo, it does not belong there.
#
# Usage:
#   sh offload.sh setup      create the area, patch .env, report sizes
#   sh offload.sh status     show both tiers and what is eating space
#   sh offload.sh env        print export lines to eval into a shell
#   sh offload.sh clean      drop rebuildable cargo in Tier 2
#   sh offload.sh verify     prove temp writes bypass /data

set -eu

HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
OFFLOAD_ROOT="${HERMES_OFFLOAD_ROOT:-/var/tmp/hermes-offload}"
ENV_FILE="${HERMES_HOME}/.env"

log() { printf '%s\n' "$*"; }

# --- helpers ---------------------------------------------------------------

persistent_fs() { findmnt -T /data -o SOURCE -n 2>/dev/null | head -1; }
offload_fs()    { findmnt -T "$OFFLOAD_ROOT" -o SOURCE -n 2>/dev/null | head -1; }

check_tiers_differ() {
    p="$(persistent_fs)"; o="$(offload_fs)"
    if [ -z "$o" ]; then
        log "WARNING: $OFFLOAD_ROOT does not exist yet; it will be created on the offload filesystem."
        return 0
    fi
    if [ "$p" = "$o" ]; then
        log "REFUSING: offload root is on the SAME filesystem as /data ($p)."
        log "Offloading would not free anything. Set HERMES_OFFLOAD_ROOT elsewhere."
        return 1
    fi
    return 0
}

# --- commands --------------------------------------------------------------

cmd_setup() {
    check_tiers_differ || exit 3

    mkdir -p "$OFFLOAD_ROOT"/tmp "$OFFLOAD_ROOT"/work "$OFFLOAD_ROOT"/skills \
             "$OFFLOAD_ROOT"/downloads "$OFFLOAD_ROOT"/clones
    chmod 700 "$OFFLOAD_ROOT"

    # TMPDIR/TMP/TEMP: honoured by Hermes (verified — apply_scratch_tmp_env leaves
    # a user-set value alone) and by Python's tempfile, and by anything calling
    # mkstemp. This is the single highest-value change: it moves the proven
    # disk-filling path off /data entirely.
    add_env_var TMPDIR "$OFFLOAD_ROOT/tmp"
    add_env_var TMP  "$OFFLOAD_ROOT/tmp"
    add_env_var TEMP "$OFFLOAD_ROOT/tmp"

    log "offload area ready: $OFFLOAD_ROOT"
    cmd_status
}

add_env_var() {
    key="$1"; value="$2"
    if [ ! -f "$ENV_FILE" ]; then
        log "WARNING: $ENV_FILE not found; set $key=$value manually."
        return 0
    fi
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
        # Rewrite the value in place, preserving the line's position.
        tmp="${ENV_FILE}.offload.$$"
        awk -v k="$key" -v v="$value" -F= '
            $1 == k { print k "=" v; next } { print }
        ' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        log "  updated $key in the credential store"
    else
        printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        log "  added   $key to the credential store"
    fi
}

cmd_status() {
    log ""
    log "=== TIER 1: persistent, must stay small ==="
    log "/data           $(df -h /data | tail -1 | awk '{print $2" total, "$3" used, "$4" free ("$5")"}')"
    if [ -d "$HERMES_HOME" ]; then
        log "  $HERMES_HOME  $(du -sh "$HERMES_HOME" 2>/dev/null | cut -f1)"
        log "  largest items:"
        du -sh "$HERMES_HOME"/* 2>/dev/null | sort -rh | head -6 | sed 's/^/    /'
    fi

    log ""
    log "=== TIER 2: ephemeral, rebuildable, huge ==="
    if [ -d "$OFFLOAD_ROOT" ]; then
        log "$OFFLOAD_ROOT  $(df -h "$OFFLOAD_ROOT" | tail -1 | awk '{print $2" total, "$4" free ("$5" used)"}')"
        log "  current size: $(du -sh "$OFFLOAD_ROOT" 2>/dev/null | cut -f1)"
    else
        log "$OFFLOAD_ROOT  (not created — run: sh $0 setup)"
    fi

    log ""
    log "=== where does temp actually go? ==="
    log "  TMPDIR in this shell : ${TMPDIR:-(unset)}"
    log "  python tempfile      : $(python3 -c 'import tempfile;print(tempfile.gettempdir())' 2>/dev/null || echo 'python3 unavailable')"
    log "  .env TMPDIR setting  : $(grep -E '^TMPDIR=' "$ENV_FILE" 2>/dev/null || echo '(not set)')"
    case "${TMPDIR:-}" in
        /data/*) log "  => RISK: temp is on the SMALL persistent disk." ;;
        "$OFFLOAD_ROOT"/*) log "  => temp is offloaded. /data is protected." ;;
        "") log "  => inherited from the caller; see .env above." ;;
        *) log "  => on ${TMPDIR} (not /data — fine)." ;;
    esac
}

cmd_env() {
    cat <<EOF
export HERMES_OFFLOAD_ROOT="$OFFLOAD_ROOT"
export TMPDIR="$OFFLOAD_ROOT/tmp"
export TMP="$OFFLOAD_ROOT/tmp"
export TEMP="$OFFLOAD_ROOT/tmp"
export HERMES_WORKBENCH="$OFFLOAD_ROOT/work"
EOF
}

cmd_clean() {
    [ -d "$OFFLOAD_ROOT" ] || { log "nothing to clean"; exit 0; }
    before="$(du -sh "$OFFLOAD_ROOT" 2>/dev/null | cut -f1)"
    for d in tmp work downloads clones; do
        [ -d "$OFFLOAD_ROOT/$d" ] || continue
        # Keep the dir itself, drop the contents.
        find "$OFFLOAD_ROOT/$d" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
    done
    after="$(du -sh "$OFFLOAD_ROOT" 2>/dev/null | cut -f1)"
    log "offload cleaned: $before -> $after"
    log "note: the skills working copy is NOT touched — it is restored from GitHub,"
    log "      and clearing it would break skill loading until the next reconcile."
}

cmd_verify() {
    log "=== proving temp writes bypass /data ==="
    before="$(df -k /data | tail -1 | awk '{print $3}')"
    log "  /data used before : ${before} KiB"

    probe="$OFFLOAD_ROOT/tmp/verify.$$"
    mkdir -p "$OFFLOAD_ROOT/tmp"
    dd if=/dev/zero of="$probe" bs=1M count=200 status=none
    where="$(findmnt -T "$probe" -o SOURCE -n)"
    mid="$(df -k /data | tail -1 | awk '{print $3}')"
    log "  wrote 200 MiB to  : $probe"
    log "  lands on          : $where"
    log "  /data used during : ${mid} KiB"
    delta=$((mid - before))
    rm -f "$probe"

    if [ "$where" = "$(persistent_fs)" ]; then
        log "  FAIL: the probe landed on the /data filesystem."
        exit 4
    fi
    if [ "$delta" -gt 2048 ]; then
        log "  FAIL: /data grew by ${delta} KiB during the write."
        exit 4
    fi
    log "  PASS: 200 MiB written, /data grew by ${delta} KiB — the small disk is untouched."
    log ""
    log "  for contrast, the same write into HERMES_HOME/cache/scratch would"
    log "  have consumed half of the 434 MiB volume and could exhaust it."
}

case "${1:-status}" in
    setup)  cmd_setup ;;
    status) cmd_status ;;
    env)    cmd_env ;;
    clean)  cmd_clean ;;
    verify) cmd_verify ;;
    -h|--help) sed -n '2,30p' "$0" ;;
    *) log "unknown command: $1 (try: setup, status, env, clean, verify)"; exit 64 ;;
esac
