#!/usr/bin/env bash
# archive.sh — park finished projects OUT of the agent's active skill catalogue
# while keeping every byte on disk and in the repo backup.
#
# WHY THIS EXISTS
#   "Remove it from your mind" and "delete it" are different requests, and
#   conflating them destroys work. Finished projects must stop influencing the
#   agent (not be listed as skills, not be loaded by skill_view, not be part of
#   the working context) while the data itself stays recoverable. So the bytes are
#   MOVED to a location the skill loader does not scan, and the repo backup is
#   left untouched.
#
# WHY A MOVE AND NOT A DELETE
#   The skill loader scans $HERMES_HOME/skills/ recursively AND every directory in
#   skills.external_dirs. Anything with a SKILL.md under either path becomes an
#   active skill. Parking therefore means "put it where neither scan reaches",
#   not "unlink it".
#
# WHAT COUNTS AS PARKED
#   $HERMES_HOME/archive/<project>/   — on the PERSISTENT volume, outside external_dirs,
#                                       outside skills/, and in ghstore's SYNC_MAP as
#                                       state/archive (so it is also in the repo backup).
#
# Usage:
#   sh archive.sh list                 what is parked, with sizes
#   sh archive.sh park <project>       move a project out of the active scan
#   sh archive.sh restore <project>    put it back into the active scan
#   sh archive.sh migrate              move a legacy off-volume archive onto the volume
#   sh archive.sh verify               prove the catalogue no longer lists them
#   sh archive.sh doctor               show every scan path the loader uses
#
# WHY THE ARCHIVE MOVED OFF /var/tmp
#   Parking used to land in <offload-root>/archive on the ephemeral overlay, which is
#   erased when the container is recreated — so "park it, never delete it" would have
#   deleted it on the next deploy, silently. Parked bytes go on the state volume, and
#   ghstore syncs them so they survive container loss twice over.

set -uo pipefail

HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
OFFLOAD_ROOT="${HERMES_OFFLOAD_ROOT:-/var/tmp/hermes-offload}"
# Parked bytes belong on the PERSISTENT volume, not the ephemeral overlay: /var/tmp
# is wiped when the container is recreated, which would turn "park it, don't delete
# it" into a silent deletion. $HERMES_HOME/archive is also in ghstore's SYNC_MAP,
# so parked projects survive container loss through the repo as well.
ARCHIVE="${HERMES_ARCHIVE_ROOT:-$HERMES_HOME/archive}"
LEGACY_ARCHIVE="${OFFLOAD_ROOT}/archive"
SKILLS_LIVE="${OFFLOAD_ROOT}/skills"
STAGE="${HERMES_HOME}/skills/.offloaded"
VPY="${HERMES_PYTHON:-/opt/hermes/.venv/bin/python}"

say()  { printf '\n=== %s ===\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  OK    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
die()  { printf '\nFATAL: %s\n' "$*" >&2; exit 1; }

# Project name -> space-separated list of source paths to move. A project can span
# several roots (the game lives in workspace/, its skills on the big disk), and
# parking has to catch all of them or the catalogue stays polluted.
sources_for() {
    case "$1" in
        gamedev-skills)
            printf '%s\n' "$SKILLS_LIVE/gamedev-disciplines" "$SKILLS_LIVE/gamedev-genres" \
                          "$SKILLS_LIVE/gamedev-godot" "$SKILLS_LIVE/gamedev-other-engines" \
                          "$SKILLS_LIVE/gamedev-web-engines" "$SKILLS_LIVE/gamedev-workflows" \
                          "$STAGE" ;;
        room13-game)   printf '%s\n' "$HERMES_HOME/workspace/horror-game" ;;
        vpn-ops)       printf '%s\n' "$HERMES_HOME/ghfirst/ops" ;;
        *)             return 1 ;;
    esac
}

all_projects() { printf '%s\n' gamedev-skills room13-game vpn-ops; }

cmd_list() {
    say "active (visible to the skill loader)"
    local n=0
    for d in "$SKILLS_LIVE"/*/; do
        [ -d "$d" ] || continue
        local c
        c=$(find "$d" -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')
        [ "$c" -gt 0 ] || continue
        printf '  %-34s %3s skills\n' "$(basename "$d")" "$c"
        n=$((n + c))
    done
    if [ -d "$STAGE" ]; then
        local s
        s=$(find "$STAGE" -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')
        [ "$s" -gt 0 ] && { printf '  %-34s %3s skills  (INSIDE skills/ — scanned!)\n' ".offloaded" "$s"; n=$((n + s)); }
    fi
    [ "$n" -gt 0 ] || info "(none)"
    info "total active skills: $n"

    say "parked (on disk, out of the loader's reach)"
    local m=0
    if [ -d "$ARCHIVE" ]; then
        for d in "$ARCHIVE"/*/; do
            [ -d "$d" ] || continue
            printf '  %-22s %8s\n' "$(basename "$d")" "$(du -sh "$d" 2>/dev/null | cut -f1)"
            m=$((m + 1))
        done
    fi
    [ "$m" -gt 0 ] || info "(nothing parked)"

    if [ -d "$LEGACY_ARCHIVE" ] && [ "$LEGACY_ARCHIVE" != "$ARCHIVE" ]; then
        warn "legacy archive on the EPHEMERAL disk: $LEGACY_ARCHIVE (survives nothing)"
        warn "migrate it: sh archive.sh migrate"
    fi

    say "disk"
    df -h /data | tail -1 | awk '{print "  /data   "$3" used, "$4" free ("$5")"}'
    du -sh "$OFFLOAD_ROOT" 2>/dev/null | sed 's/^/  offload /'
}

cmd_park() {
    local project="${1:-}"
    [ -n "$project" ] || die "usage: archive.sh park <project>   (see: archive.sh list)"
    sources_for "$project" >/dev/null 2>&1 || die "unknown project: $project"

    mkdir -p "$ARCHIVE/$project"
    local moved=0 missing=0
    # Collect the source list first, then iterate a here-doc. Process substitution
    # (`< <(...)`) is a bashism that dash rejects with "redirection unexpected",
    # and this script is also invoked as `sh archive.sh`.
    local list
    list=$(sources_for "$project")
    local oldifs="$IFS"
    IFS='
'
    for src in $list; do
        [ -n "$src" ] || continue
        if [ ! -e "$src" ]; then missing=$((missing + 1)); continue; fi
        local base
        base=$(basename "$src")
        rm -rf "$ARCHIVE/$project/$base"
        mv "$src" "$ARCHIVE/$project/$base"
        info "parked $(basename "$src")"
        moved=$((moved + 1))
    done
    IFS="$oldifs"

    [ "$moved" -gt 0 ] || die "nothing found to park for '$project' (already parked?)"
    ok "moved $moved path(s) into $ARCHIVE/$project"
    [ "$missing" -gt 0 ] && info "$missing source path(s) were already absent"
    info "bytes are intact and the repo backup is untouched"
}

cmd_restore() {
    local project="${1:-}"
    [ -n "$project" ] || die "usage: archive.sh restore <project>"
    local dir="$ARCHIVE/$project"
    [ -d "$dir" ] || die "not parked: $project"

    local n=0 staged=0
    # Enumerate with `find`, not a `"$dir"/*` glob: the gamedev project's only
    # payload is the DOT-directory `.offloaded`, which a plain glob never matches —
    # so a glob-based restore reported "nothing to restore" while 60 parked skills
    # sat in the archive. Verify with an entry count, not with trust.
    local entries
    entries=$(find "$dir" -mindepth 1 -maxdepth 1 | sort)
    # Newline-separated so an entry containing a space survives; every expansion in
    # the loop body is quoted, so the temporary IFS changes nothing else.
    local oldifs="$IFS"
    IFS='
'
    for d in $entries; do
        [ -e "$d" ] || continue
        local base dest
        base=$(basename "$d")
        case "$base" in
            .offloaded)    dest="$STAGE" ; staged=1 ;;
            gamedev-*)     dest="$SKILLS_LIVE/$base" ;;
            horror-game)   dest="$HERMES_HOME/workspace/$base" ;;
            ops)           dest="$HERMES_HOME/ghfirst/$base" ;;
            *)             warn "unrecognised item '$base' — leaving it parked"; continue ;;
        esac
        mkdir -p "$(dirname "$dest")"
        rm -rf "$dest"
        mv "$d" "$dest"
        info "restored $base -> $dest"
        n=$((n + 1))
    done
    IFS="$oldifs"
    [ "$n" -gt 0 ] || die "nothing to restore in $project"
    ok "restored $n item(s)"

    # A restore into the staging dir is not visible to the agent: staging is
    # deliberately outside every scan path. Rehydrate it into the live external dir
    # in the same command (offload-boot does the same on each tick), otherwise
    # "restored" is true on disk and false in skill_view.
    #
    # Mirror by TOP-LEVEL ENTRY, not by `$STAGE/*/SKILL.md`: the staged tree is
    # category/nested-skill/SKILL.md, so a one-level glob matches no SKILL.md at all
    # and reports "rehydrated 0" while the catalogue stays empty. The loader scans
    # the external dir recursively, so a whole-subtree copy is the correct unit.
    if [ "$staged" -eq 1 ] && [ -d "$STAGE" ]; then
        mkdir -p "$SKILLS_LIVE"
        local r=0
        for d in "$STAGE"/*/; do
            [ -d "$d" ] || continue
            local name
            name=$(basename "$d")
            rm -rf "$SKILLS_LIVE/$name"
            cp -R "$d" "$SKILLS_LIVE/$name"
            r=$((r + 1))
        done
        # Drop live categories the staging area no longer holds, so a re-park does
        # not leave a stale visible copy behind.
        for d in "$SKILLS_LIVE"/*/; do
            [ -d "$d" ] || continue
            local name
            name=$(basename "$d")
            [ -e "$STAGE/$name" ] || rm -rf "$d"
        done
        ok "rehydrated $r categor$( [ "$r" = 1 ] && echo y || echo ies ) into $SKILLS_LIVE (live to the loader)"
        sh "$0" verify
    fi
}

# Prove the active catalogue no longer contains the parked project. This is the
# check that matters: a move that leaves a scanned copy behind looks successful
# and changes nothing.
cmd_verify() {
    local bad=0
    say "does the loader still see parked content?"
    if [ -d "$STAGE" ]; then
        local s
        s=$(find "$STAGE" -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')
        [ "$s" -gt 0 ] && { warn "$s SKILL.md still under skills/.offloaded (scanned!)"; bad=1; }
    fi
    if ls "$SKILLS_LIVE"/gamedev-* >/dev/null 2>&1; then
        warn "gamedev-* still under the external dir (scanned!)"; bad=1
    fi

    if [ "$bad" -eq 0 ]; then
        ok "no parked content is inside any scan path"
    fi

    say "loader's live catalogue"
    # Parked names are DERIVED from the archive, never hardcoded: a hand-kept list
    # stops covering a project the moment a new one is parked, and verify would
    # then pass while that project sits inside a scan path.
    "$VPY" - "$HERMES_HOME" "$ARCHIVE" "$LEGACY_ARCHIVE" "$SKILLS_LIVE" "$STAGE" <<'PY' 2>/dev/null || warn "could not query the loader"
import os, sys, pathlib
home, archive, legacy, live, stage = sys.argv[1:6]
os.environ['HERMES_HOME'] = home
sys.path.insert(0, '/opt/hermes')
try:
    import agent.skill_utils as su
except Exception as e:
    print(f"  (loader import failed: {e})"); raise SystemExit(0)
parked = set()
for root in (archive, legacy):
    if os.path.isdir(root):
        parked |= {p.parent.name for p in pathlib.Path(root).rglob('SKILL.md')}
names = []
for tier, d in su.get_skill_search_roots():
    if not d.is_dir():
        print(f"  tier={tier}  {d}  (missing)"); continue
    found = [p.parent.name for p in d.rglob('SKILL.md')]
    print(f"  tier={tier}  {d}  -> {len(found)} skill(s)")
    names += found
hits = sorted(parked & set(names))
print(f"  parked skill names: {len(parked)}")
print(f"  parked names visible to the loader: {hits if hits else 'NONE'}")
PY

    if [ -d "$LEGACY_ARCHIVE" ] && [ "$LEGACY_ARCHIVE" != "$ARCHIVE" ]; then
        warn "legacy archive still on the ephemeral disk: $LEGACY_ARCHIVE"
        bad=1
    fi

    [ "$bad" -eq 0 ] || exit 1
}

cmd_migrate() {
    [ -d "$LEGACY_ARCHIVE" ] || { ok "no legacy archive at $LEGACY_ARCHIVE"; return 0; }
    [ "$LEGACY_ARCHIVE" = "$ARCHIVE" ] && { ok "archive already on the persistent disk"; return 0; }

    mkdir -p "$ARCHIVE"
    local before after moved=0
    before=$(find "$LEGACY_ARCHIVE" -type f 2>/dev/null | wc -l | tr -d ' ')
    for d in "$LEGACY_ARCHIVE"/*/; do
        [ -d "$d" ] || continue
        local base
        base=$(basename "$d")
        if [ -e "$ARCHIVE/$base" ]; then
            warn "$base already exists at $ARCHIVE — merging"
            cp -a "$d". "$ARCHIVE/$base"/ || die "copy failed for $base"
            rm -rf "$d"
        else
            mv "$d" "$ARCHIVE/$base" || die "move failed for $base"
        fi
        info "migrated $base"
        moved=$((moved + 1))
    done
    after=$(find "$ARCHIVE" -type f 2>/dev/null | wc -l | tr -d ' ')
    [ "$moved" -gt 0 ] || die "nothing migrated (archive held no project directories)"
    [ "$after" -ge "$before" ] || die "file count dropped ($before -> $after) — investigate before removing anything"
    # Remove the now-empty legacy root only when it is genuinely empty.
    rmdir "$LEGACY_ARCHIVE" 2>/dev/null || warn "$LEGACY_ARCHIVE not empty — inspect remaining files"
    ok "migrated $moved project(s); $before files -> $after on the persistent disk"
    info "now in ghstore's SYNC_MAP as state/archive — survives container loss in the repo too"
}

cmd_doctor() {
    say "every path the skill loader scans"
    for p in "$HERMES_HOME/skills" "$STAGE" "$SKILLS_LIVE"; do
        if [ -d "$p" ]; then
            printf '  %-52s %3s SKILL.md\n' "$p" "$(find "$p" -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')"
        else
            printf '  %-52s (missing)\n' "$p"
        fi
    done

    say "skills.external_dirs in config"
    grep -A3 "^  external_dirs:" "$HERMES_HOME/config.yaml" 2>/dev/null | sed 's/^/  /' || info "(not set)"

    say "archive roots"
    for p in "$ARCHIVE" "$LEGACY_ARCHIVE"; do
        if [ -d "$p" ]; then
            printf '  %s\n' "$p"
            du -sh "$p" 2>/dev/null | sed 's/^/    /'
            ls "$p" 2>/dev/null | sed 's/^/      /'
        else
            info "$p (absent)"
        fi
    done
    case "$ARCHIVE" in
        "$HERMES_HOME"/*) ok "archive is on the persistent volume and in SYNC_MAP" ;;
        *) warn "archive is OUTSIDE \$HERMES_HOME — it is not backed up and may sit on the ephemeral disk" ;;
    esac
}

case "${1:-list}" in
    list|ls) cmd_list ;;
    park)    shift; cmd_park "${1:-}" ;;
    restore) shift; cmd_restore "${1:-}" ;;
    migrate) cmd_migrate ;;
    verify)  cmd_verify ;;
    doctor)  cmd_doctor ;;
    -h|--help) sed -n '2,30p' "$0" ;;
    *) die "unknown command: $1 (try: list, park, restore, migrate, verify, doctor)" ;;
esac
