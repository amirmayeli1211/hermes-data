#!/bin/sh
# offload-sync.sh — mirror the offload skills tree into the repo, and back.
#
# WHY THIS REPLACES THE OLD APPROACH
#   `skill-fetch.sh push` assumed every entry under the offload skills dir had a
#   SKILL.md at its top level (one skill per directory). That holds for a repo
#   fetched with `add <owner/repo>` when the repo root is the skill, but NOT for a
#   category layout — `gamedev-disciplines/ai-behavior-trees-utility-ai/SKILL.md`
#   is two levels deep, so the old check found 0 skills and staged nothing.
#   Silently: it printed "staged 0" and the snapshot was empty.
#
#   The fix is to stop guessing the depth. Mirror the tree verbatim, and keep a
#   manifest so the restore direction knows where it came from.
#
# Usage:
#   sh offload-sync.sh push     mirror offload skills -> repo staging  (then run ghstore push)
#   sh offload-sync.sh pull     restore repo staging  -> offload skills
#   sh offload-sync.sh status   compare both sides
#   sh offload-sync.sh manifest print the installation record

set -eu

HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
OFFLOAD_ROOT="${HERMES_OFFLOAD_ROOT:-/var/tmp/hermes-offload}"
LIVE="${OFFLOAD_ROOT}/skills"
STAGE="${HERMES_HOME}/skills/.offloaded"
MANIFEST="${STAGE}/.installed.json"

log() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit "${1:-1}"; }

count_skills() {
    # A "skill" is any directory holding a SKILL.md, at any depth.
    [ -d "$1" ] || { printf '0'; return; }
    find "$1" -name SKILL.md -type f 2>/dev/null | wc -l | tr -d ' '
}

tree_size() {
    [ -d "$1" ] || { printf '0 B'; return; }
    du -sh "$1" 2>/dev/null | cut -f1
}

cmd_status() {
    log "=== offloaded skills ==="
    log "  live  ($LIVE): $(count_skills "$LIVE") skills, $(tree_size "$LIVE")"
    log "  stage ($STAGE): $(count_skills "$STAGE") skills, $(tree_size "$STAGE")"

    if [ -d "$LIVE" ]; then
        log ""
        log "  categories installed:"
        for d in "$LIVE"/*/; do
            [ -d "$d" ] || continue
            n=$(count_skills "$d")
            [ "$n" -gt 0 ] || continue
            printf '    %-26s %3s skills\n' "$(basename "$d")" "$n"
        done
    fi

    log ""
    log "=== disk ==="
    log "  /data   $(df -h /data | tail -1 | awk '{print $3" used, "$4" free ("$5")"}')"
    log "  offload $(du -sh "$OFFLOAD_ROOT" 2>/dev/null | cut -f1) of the 100 MB install budget"
}

# Write a record of what was installed, from where. Provenance matters: a rebuilt
# container should be able to show which upstream commit the content came from,
# and an operator should be able to see that `unity`/`unreal` were deliberately
# omitted rather than forgotten.
write_manifest() {
    src_repo="${1:-unknown}"
    src_commit="${2:-unknown}"
    cat > "$MANIFEST" <<EOF
{
  "schema": 1,
  "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_repo": "$src_repo",
  "source_commit": "$src_commit",
  "skills_installed": $(count_skills "$LIVE"),
  "layout": "verbatim mirror of the offload skills tree; nesting depth preserved",
  "note": "Restore direction is offload-sync.sh pull. Content here is a snapshot so a container rebuild does not need network access to re-fetch."
}
EOF
    log "  wrote $MANIFEST"
}

cmd_push() {
    [ -d "$LIVE" ] || die "nothing to push: $LIVE does not exist" 3
    n=$(count_skills "$LIVE")
    [ "$n" -gt 0 ] || die "no SKILL.md found under $LIVE — refusing to stage an empty tree" 5

    mkdir -p "$STAGE"
    # Mirror verbatim. Delete-then-copy keeps the stage an exact image, so a
    # skill removed upstream does not linger in the repo forever.
    for old in "$STAGE"/*/; do
        [ -e "$old" ] || continue
        rm -rf "$old"
    done
    cp -R "$LIVE"/. "$STAGE"/

    # Source provenance from the last install, if it left a marker.
    src_commit="unknown"
    src_repo="unknown"
    if [ -f "$OFFLOAD_ROOT/.source" ]; then
        # shellcheck disable=SC1090
        . "$OFFLOAD_ROOT/.source"
        src_commit="${SOURCE_COMMIT:-unknown}"
        src_repo="${SOURCE_REPO:-unknown}"
    fi
    write_manifest "$src_repo" "$src_commit"

    log "staged $(count_skills "$STAGE") skills ($(tree_size "$STAGE")) into $STAGE"
    log "  layouts preserved; no depth assumption"
    log ""
    log "commit it: python3 ${HERMES_HOME}/ghfirst/ghstore.py push"
}

cmd_pull() {
    [ -d "$STAGE" ] || die "nothing to restore: $STAGE does not exist" 3
    n=$(count_skills "$STAGE")
    [ "$n" -gt 0 ] || die "stage has no SKILL.md — nothing to restore" 5

    mkdir -p "$LIVE"
    # Only replace entries that actually exist in the stage, so a locally added
    # skill is not wiped by a restore that predates it.
    replaced=0
    for d in "$STAGE"/*/; do
        [ -d "$d" ] || continue
        name="$(basename "$d")"
        case "$name" in .*) continue ;; esac
        rm -rf "$LIVE/$name"
        cp -R "$d" "$LIVE/$name"
        replaced=$((replaced + 1))
    done
    log "restored $replaced category dir(s), $(count_skills "$LIVE") skills, into $LIVE"
}


# Restore the manifest file too, so provenance survives a rebuild.
cmd_manifest() {
    if [ -f "$MANIFEST" ]; then
        cat "$MANIFEST"
    else
        log "no manifest recorded yet (run: sh $0 push)"
    fi
}

case "${1:-status}" in
    push)     cmd_push ;;
    pull)     cmd_pull ;;
    status)   cmd_status ;;
    manifest) cmd_manifest ;;
    -h|--help) sed -n '2,26p' "$0" ;;
    *) die "unknown command: $1 (try: push, pull, status, manifest)" 64 ;;
esac
