#!/bin/sh
# skill-fetch.sh — install a skill from GitHub straight onto the BIG disk.
#
# THE POINT
#   /data is 434 MB and persistent. Skills are small (334 files = 3.9 MB today)
#   but a large skill pack, a repo with examples, or anything with dependencies
#   is not. So: fetch to the offload area, register it via skills.external_dirs,
#   and back it up to the hermes-data repo — leaving /data untouched apart from
#   the tiny config entry and the repo snapshot.
#
# WHY EXTERNAL DIRS AND NOT A SYMLINK
#   Symlinking $HERMES_HOME/skills/<name> into the offload area was tested and
#   REJECTED: Hermes writes skills with tmp-file + os.replace(), and os.replace
#   across filesystems fails with EXDEV ("Invalid cross-device link"). A symlink
#   would break skill creation the first time it happened. skills.external_dirs
#   is the supported mechanism, verified to resolve at tier=3:
#     tier=1 /data/.hermes/skills              (local, precedence)
#     tier=3 /var/tmp/hermes-offload/skills    (external, this)
#
# DIRECTORY SHAPE
#   External dirs are scanned one level deep, so a skill must sit at
#   <external_root>/<skill-name>/SKILL.md — NOT nested under a category folder.
#
# Usage:
#   sh skill-fetch.sh add <owner/repo> [skill-subpath]   fetch a skill from GitHub
#   sh skill-fetch.sh add-url <git-url> <skill-name>     fetch from any git remote
#   sh skill-fetch.sh list                               what is installed
#   sh skill-fetch.sh remove <skill-name>                drop it
#   sh skill-fetch.sh push                               snapshot it into hermes-data
#   sh skill-fetch.sh doctor                             verify wiring
#
# Exit codes: 0 ok · 3 missing dependency · 4 not found · 5 invalid skill
#             6 refused (unsafe path) · 7 not configured

set -eu

# Host adaptation (sandbox-b1e0eab0): Hermes home lives on the container root disk.
HERMES_HOME="${HERMES_HOME:-/home/user/.hermes}"
OFFLOAD_ROOT="${HERMES_OFFLOAD_ROOT:-/home/user/hermes-offload}"
SKILLS_DIR="${OFFLOAD_ROOT}/skills"
DOWNLOADS="${OFFLOAD_ROOT}/downloads"
TOOL="${HERMES_HOME}/ghfirst/ghstore.py"

log() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit "${2:-1}"; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1" 3; }

# --- wiring ---------------------------------------------------------------

ensure_wiring() {
    mkdir -p "$SKILLS_DIR" "$DOWNLOADS"

    # Confirm the offload root is NOT on the small persistent filesystem.
    off_fs="$(findmnt -T "$SKILLS_DIR" -o SOURCE -n 2>/dev/null || true)"
    data_fs="$(findmnt -T /data -o SOURCE -n 2>/dev/null || true)"
    if [ -n "$off_fs" ] && [ "$off_fs" = "$data_fs" ]; then
        die "REFUSED: $SKILLS_DIR is on the same filesystem as /data ($off_fs).
Offloading there saves nothing. Set HERMES_OFFLOAD_ROOT to a different mount." 6
    fi

    # Verify skills.external_dirs names this directory; without it the skills
    # are invisible to the agent even though the files exist.
    if ! grep -q "$SKILLS_DIR" "${HERMES_HOME}/config.yaml" 2>/dev/null; then
        die "NOT CONFIGURED: ${HERMES_HOME}/config.yaml has no skills.external_dirs
entry for $SKILLS_DIR. Add it with (do not hand-edit YAML):

  hermes config set skills.external_dirs '[\"$SKILLS_DIR\"]'

Then re-run." 7
    fi
}

# --- validation -----------------------------------------------------------

# Refuse names that could escape the skills dir or break the catalog.
validate_name() {
    name="$1"
    case "$name" in
        ""|.|..|*/*|*\\*) die "refused unsafe skill name: '$name'" 6 ;;
    esac
    case "$name" in
        *[!A-Za-z0-9._-]*) die "refused skill name with unusual characters: '$name'" 6 ;;
    esac
    if [ "${#name}" -gt 64 ]; then
        die "refused over-long skill name (${#name} > 64): '$name'" 6
    fi
}

# A directory only counts as a skill when its SKILL.md carries frontmatter with
# at least a name — otherwise the agent catalog reports a broken entry.
validate_skill_dir() {
    dir="$1"
    [ -f "$dir/SKILL.md" ] || die "not a skill: no SKILL.md in $dir" 5
    head -1 "$dir/SKILL.md" | grep -q '^---$' || \
        die "invalid skill: $dir/SKILL.md does not start with YAML frontmatter (---)" 5
    grep -q '^name:' "$dir/SKILL.md" || \
        die "invalid skill: $dir/SKILL.md frontmatter has no 'name:' field" 5
    if ! grep -qi '^description:' "$dir/SKILL.md"; then
        log "  WARNING: $dir/SKILL.md has no 'description:'; it will not be routable."
    fi
}

# --- commands -------------------------------------------------------------

cmd_add() {
    repo="${1:-}"; sub="${2:-}"
    [ -n "$repo" ] || die "usage: skill-fetch.sh add <owner/repo> [skill-subpath]" 64
    need git
    ensure_wiring

    slot="$(basename "$repo" .git)"
    work="${DOWNLOADS}/${slot}.$$"
    rm -rf "$work"

    log "cloning $repo (shallow) into $DOWNLOADS"
    if ! git clone --depth 1 --quiet "https://github.com/${repo}.git" "$work" 2>&1; then
        rm -rf "$work"
        die "clone failed: $repo (check the name, and that the repo is public or
the token has access; private repos need credentials in the git URL)" 4
    fi

    src="$work"
    [ -n "$sub" ] && src="$work/$sub"
    if [ ! -d "$src" ]; then
        rm -rf "$work"
        die "subpath not found in $repo: $sub" 4
    fi

    # Accept either a single skill (has SKILL.md) or a tree of them.
    found=0
    if [ -f "$src/SKILL.md" ]; then
        name="$(basename "$(cd "$src" && pwd)")"
        validate_name "$name"
        validate_skill_dir "$src"
        rm -rf "$SKILLS_DIR/$name"
        cp -R "$src" "$SKILLS_DIR/$name"
        found=1
        log "  installed skill: $name -> $SKILLS_DIR/$name"
    else
        for d in "$src"/*/; do
            [ -f "${d}SKILL.md" ] || continue
            name="$(basename "$d")"
            validate_name "$name"
            validate_skill_dir "$d" || continue
            rm -rf "$SKILLS_DIR/$name"
            cp -R "$d" "$SKILLS_DIR/$name"
            found=1
            log "  installed skill: $name"
        done
    fi

    rm -rf "$work"
    [ "$found" -eq 1 ] || die "no SKILL.md found in $repo${sub:+ (subpath $sub)}" 5

    log ""
    log "installed into the offload area; /data was not used."
    log "snapshot it into the hermes-data repo with: sh $0 push"
}

cmd_add_url() {
    url="${1:-}"; name="${2:-}"
    [ -n "$url" ] && [ -n "$name" ] || die "usage: skill-fetch.sh add-url <git-url> <skill-name>" 64
    need git
    ensure_wiring
    validate_name "$name"

    work="${DOWNLOADS}/url-${name}.$$"
    rm -rf "$work"
    log "cloning $url into $DOWNLOADS"
    git clone --depth 1 --quiet "$url" "$work" 2>&1 || { rm -rf "$work"; die "clone failed: $url" 4; }

    validate_skill_dir "$work"
    rm -rf "$SKILLS_DIR/$name"
    cp -R "$work" "$SKILLS_DIR/$name"
    rm -rf "$work"
    log "installed skill: $name -> $SKILLS_DIR/$name"
}

cmd_list() {
    [ -d "$SKILLS_DIR" ] || { log "no offloaded skills (run 'add' first)"; return 0; }
    n=0
    for d in "$SKILLS_DIR"/*/; do
        [ -f "${d}SKILL.md" ] || continue
        n=$((n + 1))
        size="$(du -sh "$d" 2>/dev/null | cut -f1)"
        desc="$(grep -m1 '^description:' "${d}SKILL.md" 2>/dev/null | cut -c14- | cut -c1-60)"
        printf '  %-28s %6s  %s\n' "$(basename "$d")" "$size" "$desc"
    done
    [ "$n" -gt 0 ] || log "  (none)"
    log ""
    log "  $n skill(s) on the big disk; total $(du -sh "$SKILLS_DIR" 2>/dev/null | cut -f1)"
}

cmd_remove() {
    name="${1:-}"
    [ -n "$name" ] || die "usage: skill-fetch.sh remove <skill-name>" 64
    validate_name "$name"
    target="$SKILLS_DIR/$name"
    [ -d "$target" ] || die "not installed here: $name" 4
    rm -rf "$target"
    log "removed $name from the offload area"
}

# Snapshot the offloaded skills into the repo so they survive a container
# rebuild. This copies into a staging dir inside HERMES_HOME — deliberately kept
# out of the live skills path so a restore can never collide with local skills —
# and ghstore picks it up from there.
cmd_push() {
    [ -d "$SKILLS_DIR" ] || { log "nothing to push"; return 0; }
    stage="${HERMES_HOME}/skills/.offloaded"
    mkdir -p "$stage"
    # Mirror the offload set exactly: remove skills that were deleted upstream.
    for old in "$stage"/*/; do
        [ -e "$old" ] || continue
        rm -rf "$old"
    done
    n=0
    for d in "$SKILLS_DIR"/*/; do
        [ -f "${d}SKILL.md" ] || continue
        cp -R "$d" "$stage/$(basename "$d")"
        n=$((n + 1))
    done
    log "staged $n offloaded skill(s) into $stage"
    log "  (the live copies stay on the big disk; this is the durable snapshot)"
    if [ -f "$TOOL" ]; then
        log ""
        log "push the snapshot to the repo:"
        log "  python3 $TOOL push"
    fi
}

cmd_doctor() {
    log "=== skill offload wiring ==="
    log "HERMES_HOME     : $HERMES_HOME"
    log "OFFLOAD_ROOT    : $OFFLOAD_ROOT"
    log "SKILLS_DIR      : $SKILLS_DIR"

    if [ -d "$SKILLS_DIR" ]; then
        log "status          : exists ($(du -sh "$SKILLS_DIR" | cut -f1))"
    else
        log "status          : MISSING — run: sh $0 add <owner/repo>"
    fi

    log ""
    log "filesystem check (must differ from /data):"
    log "  /data      -> $(findmnt -T /data -o SOURCE,FSTYPE -n 2>/dev/null || echo '?')"
    log "  skills dir -> $(findmnt -T "${SKILLS_DIR:-/tmp}" -o SOURCE,FSTYPE -n 2>/dev/null || echo '?')"

    log ""
    log "config check (skills.external_dirs):"
    if grep -q "$SKILLS_DIR" "${HERMES_HOME}/config.yaml" 2>/dev/null; then
        log "  configured      : yes"
    else
        log "  configured      : NO — the agent cannot see these skills."
        log "                    hermes config set skills.external_dirs '[\"$SKILLS_DIR\"]'"
    fi

    log ""
    log "disk pressure:"
    log "  /data          $(df -h /data | tail -1 | awk '{print $5" used, "$4" free"}')"
    log "  offload mount  $(df -h "$OFFLOAD_ROOT" 2>/dev/null | tail -1 | awk '{print $5" used, "$4" free"}')"

    log ""
    log "resolution order (local skills win on a name collision):"
    /opt/hermes/.venv/bin/python -c "
import sys; sys.path.insert(0,'/opt/hermes')
import agent.skill_utils as su
for t,d in su.get_skill_search_roots():
    label = {0:'project',1:'local  ',2:'create ',3:'EXTERNAL'}.get(t, str(t))
    print(f'  tier={t} {label}  {d}  exists={d.is_dir()}')
" 2>/dev/null || log "  (venv python unavailable; skipping)"
}

case "${1:-doctor}" in
    add)     shift; cmd_add "$@" ;;
    add-url) shift; cmd_add_url "$@" ;;
    list|ls) cmd_list ;;
    remove|rm) shift; cmd_remove "$@" ;;
    push)    cmd_push ;;
    doctor)  cmd_doctor ;;
    -h|--help) sed -n '2,40p' "$0" ;;
    *) die "unknown command: $1 (try: add, add-url, list, remove, push, doctor)" 64 ;;
esac
