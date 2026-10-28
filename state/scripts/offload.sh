#!/bin/sh
# offload.sh — keep big, rebuildable work off the two small spaces this host has.
#
# WHY THIS IS NOT THE UPSTREAM version
#   The original (hermes-data/tool/offload.sh) was written for a two-tier host:
#   a 434 MB persistent /data volume next to a multi-TB ephemeral overlay, where
#   the job was "keep /data small". This container has neither:
#
#     /       ext4    7.8 GB   the ONE real disk (persistent-ish, small)
#     /tmp    tmpfs    996 MB  RAM-backed scratch, 0.1% of a 2 GB RAM budget
#
#   So the two failure modes worth engineering against are:
#     1. /tmp filling (996 MB) — this already broke a Node download on this
#        host, and tmpfs contents are RAM, so a big temp job also starves the
#        gateway and the analysis engines.
#     2. / filling (7.8 GB) — the gateway cannot write, crashes, agent offline.
#
#   The rule here: scratch and rebuildable work belong in $OFFLOAD_ROOT on the
#   real disk (never in tmpfs, never in $HERMES_HOME), and disk-guard.sh keeps
#   the real disk from filling. Anything parked in the offload area must be
#   restorable — from the Hermes GitHub store, from a package registry, or by a
#   rebuild; if it is not, it does not belong there.
#
# Usage:
#   sh offload.sh setup    create the area, record TMPDIR/TMP in the credential store
#   sh offload.sh status   show both spaces, the offload area and where temp resolves
#   sh offload.sh env      print export lines to eval into a shell
#   sh offload.sh clean    drop rebuildable cargo older than 2h
#   sh offload.sh verify   prove a large temp write bypasses tmpfs

set -eu

HERMES_HOME="${HERMES_HOME:-/home/user/.hermes}"
OFFLOAD_ROOT="${HERMES_OFFLOAD_ROOT:-/home/user/hermes-offload}"
ENV_FILE="${HERMES_HOME}/.env"
STALE_MINUTES="${OFFLOAD_STALE_MINUTES:-120}"

log() { printf '%s\n' "$*"; }

fs_of() { findmnt -T "$1" -o SOURCE -n 2>/dev/null | head -1; }
fstype_of() { findmnt -T "$1" -o FSTYPE -n 2>/dev/null | head -1; }

# --- helpers ---------------------------------------------------------------

assume_real_disk() {
    # The whole point is to avoid tmpfs. Refuse a tmpfs offload root, and refuse
    # a root that resolves to the same tiny RAM budget as /tmp.
    type="$(fstype_of "$OFFLOAD_ROOT")"
    case "$type" in
        tmpfs|ramfs)
            log "REFUSING: $OFFLOAD_ROOT is on $type — that is RAM, not storage."
            log "Choose a path on the real disk, e.g. /home/user/hermes-offload."
            return 1
            ;;
    esac
    return 0
}

add_env_var() {
    key="$1"; value="$2"
    if [ ! -f "$ENV_FILE" ]; then
        log "WARNING: $ENV_FILE not found; set $key=$value manually."
        return 0
    fi
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
        tmp="${ENV_FILE}.offload.$$"
        awk -v k="$key" -v v="$value" -F= '$1 == k { print k "=" v; next } { print }' \
            "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        log "  updated $key"
    else
        printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        log "  added   $key"
    fi
}

# --- commands --------------------------------------------------------------

cmd_setup() {
    mkdir -p "$OFFLOAD_ROOT"
    assume_real_disk || exit 3
    mkdir -p "$OFFLOAD_ROOT"/tmp "$OFFLOAD_ROOT"/work "$OFFLOAD_ROOT"/skills \
             "$OFFLOAD_ROOT"/downloads "$OFFLOAD_ROOT"/clones
    chmod 700 "$OFFLOAD_ROOT"

    # Hermes loads this file into the process environment at startup, and Python's
    # tempfile honours TMPDIR, so these three lines move every temp write of the
    # gateway, the terminal tool and the analysis engines off tmpfs.
    add_env_var HERMES_OFFLOAD_ROOT "$OFFLOAD_ROOT"
    add_env_var HERMES_WORKBENCH "$OFFLOAD_ROOT/work"
    add_env_var TMPDIR "$OFFLOAD_ROOT/tmp"
    add_env_var TMP "$OFFLOAD_ROOT/tmp"
    add_env_var TEMP "$OFFLOAD_ROOT/tmp"

    log "offload area ready: $OFFLOAD_ROOT (on $(fs_of "$OFFLOAD_ROOT"))"
    cmd_status
}

cmd_status() {
    log ""
    log "=== SPACE 1: the real disk (small, must not fill) ==="
    df -h / | tail -1 | awk '{print "  /      "$2" total, "$3" used, "$4" free ("$5")"}'
    log "  $HERMES_HOME  $(du -sh "$HERMES_HOME" 2>/dev/null | cut -f1) (durable state)"

    log ""
    log "=== SPACE 2: tmpfs scratch (RAM-backed, 996 MB ceiling) ==="
    df -h /tmp | tail -1 | awk '{print "  /tmp   "$2" total, "$3" used, "$4" free ("$5")"}'

    log ""
    log "=== OFFLOAD AREA: real disk, rebuildable only ==="
    if [ -d "$OFFLOAD_ROOT" ]; then
        log "  $OFFLOAD_ROOT  $(du -sh "$OFFLOAD_ROOT" 2>/dev/null | cut -f1) on $(fs_of "$OFFLOAD_ROOT")"
        du -sh "$OFFLOAD_ROOT"/* 2>/dev/null | sed 's/^/    /' || true
    else
        log "  $OFFLOAD_ROOT  (not created — run: sh $0 setup)"
    fi

    log ""
    log "=== where does temp actually go? ==="
    log "  TMPDIR in this shell : ${TMPDIR:-(unset)}"
    log "  python tempfile      : $(python3 -c 'import tempfile;print(tempfile.gettempdir())' 2>/dev/null || echo 'python3 unavailable')"
    log "  credential-store TMPDIR: $(grep -E '^TMPDIR=' "$ENV_FILE" 2>/dev/null || echo '(not set)')"
    case "${TMPDIR:-}" in
        "$OFFLOAD_ROOT"/*) log "  => temp is offloaded to the real disk." ;;
        /tmp/*|/tmp)       log "  => WARNING: temp is on tmpfs; a big job eats RAM." ;;
        "")                log "  => inherited from the caller; see the credential store above." ;;
        *)                 log "  => on ${TMPDIR} (not tmpfs — fine)." ;;
    esac
}

cmd_env() {
    cat <<EOF
export HERMES_OFFLOAD_ROOT="$OFFLOAD_ROOT"
export HERMES_WORKBENCH="$OFFLOAD_ROOT/work"
export TMPDIR="$OFFLOAD_ROOT/tmp"
export TMP="$OFFLOAD_ROOT/tmp"
export TEMP="$OFFLOAD_ROOT/tmp"
EOF
}

cmd_clean() {
    [ -d "$OFFLOAD_ROOT" ] || { log "nothing to clean"; exit 0; }
    before="$(du -sk "$OFFLOAD_ROOT" 2>/dev/null | cut -f1)"
    # tmp/downloads/clones are pure scratch: anything not touched in the window
    # is dead weight. work/ is left alone (a live analysis may be using it), as
    # is the skills working copy (restored from GitHub on the next reconcile).
    for d in tmp downloads clones; do
        [ -d "$OFFLOAD_ROOT/$d" ] || continue
        find "$OFFLOAD_ROOT/$d" -mindepth 1 -mmin +"$STALE_MINUTES" -exec rm -rf {} + 2>/dev/null || true
    done
    after="$(du -sk "$OFFLOAD_ROOT" 2>/dev/null | cut -f1)"
    freed=$(( (before - after) / 1024 ))
    if [ "$freed" -ge 1 ]; then
        log "offload cleaned: ${freed} MiB reclaimed (items older than ${STALE_MINUTES}m)"
    fi
    log "note: the skills working copy and work/ are not touched."
}

cmd_verify() {
    assume_real_disk || exit 4
    log "=== proving a large temp write bypasses tmpfs ==="
    t_before="$(df -k /tmp | tail -1 | awk '{print $3}')"
    mkdir -p "$OFFLOAD_ROOT/tmp"
    probe="$OFFLOAD_ROOT/tmp/verify.$$"
    dd if=/dev/zero of="$probe" bs=1M count=200 status=none
    where="$(fs_of "$probe")"
    t_after="$(df -k /tmp | tail -1 | awk '{print $3}')"
    type="$(fstype_of "$probe")"
    log "  wrote 200 MiB to : $probe"
    log "  lands on         : $where ($type)"
    log "  /tmp used before : ${t_before} KiB   after: ${t_after} KiB"
    rm -f "$probe"

    if [ "$type" = "tmpfs" ] || [ "$type" = "ramfs" ]; then
        log "  FAIL: the probe wrote into RAM."
        exit 4
    fi
    if [ $((t_after - t_before)) -gt 2048 ]; then
        log "  FAIL: tmpfs grew by $((t_after - t_before)) KiB during the write."
        exit 4
    fi
    log "  PASS: 200 MiB written to the real disk, tmpfs untouched."
    log "  for contrast, the same write into /tmp would have consumed a fifth of"
    log "  the 996 MB RAM budget and pushed the gateway toward an OOM stall."
}

case "${1:-status}" in
    setup)  cmd_setup ;;
    status) cmd_status ;;
    env)    cmd_env ;;
    clean)  cmd_clean ;;
    verify) cmd_verify ;;
    -h|--help) sed -n '2,40p' "$0" ;;
    *) log "unknown command: $1 (try: setup, status, env, clean, verify)"; exit 64 ;;
esac
