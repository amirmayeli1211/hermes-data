#!/bin/sh
# install-gamedev-skills.sh — install the gamedev skill pack, filtered to what
# can actually be used in THIS environment.
#
# WHY FILTERED
#   The pack ships 9 skill dirs (888 KB). Two of them target engines that cannot
#   run here at all: `unity` and `unreal`. There is no Unity/Unreal binary, no
#   .NET SDK, and no display; those skills would load and describe workflows that
#   can never be executed. Installing them makes the skill catalogue claim
#   capability the machine does not have.
#
#   `godot` IS installed because Godot ships a self-contained Linux binary that
#   runs headless, so the workflow in those docs is genuinely executable.
#
#   Only `skills/` is taken. `docs/assets/*.png` is 1.8 MB of banner image — more
#   than half the repo — and has no role at runtime.
#
# Idempotent: re-running replaces the installed copies.

set -eu

HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
OFFLOAD_ROOT="${HERMES_OFFLOAD_ROOT:-/var/tmp/hermes-offload}"
SKILLS_DIR="${OFFLOAD_ROOT}/skills"
DOWNLOADS="${OFFLOAD_ROOT}/downloads"

REPO="gamedev-skills/awesome-gamedev-agent-skills"

# Kept: the engines and disciplines that are runnable or studyable here.
KEEP="disciplines genres godot other-engines web-engines workflows"
# Skipped, with the reason recorded so the choice is auditable later.
SKIP="unity unreal"

log() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit "${1:-1}"; }

need_git_check() {
    command -v git >/dev/null 2>&1 || die "git is required" 3
}

main() {
    need_git_check

    if [ ! -d "$SKILLS_DIR" ]; then
        die "external skills dir missing: $SKILLS_DIR
Run the offload setup first: sh $HERMES_HOME/ghfirst/offload.sh setup" 7
    fi
    if ! grep -q "$SKILLS_DIR" "${HERMES_HOME}/config.yaml" 2>/dev/null; then
        die "skills.external_dirs does not list $SKILLS_DIR — the agent would not
see these skills. Set it: hermes config set skills.external_dirs '[\"$SKILLS_DIR\"]'" 7
    fi

    mkdir -p "$DOWNLOADS"
    work="${DOWNLOADS}/gamedev.$$"
    rm -rf "$work"

    log "cloning $REPO (shallow, filtered checkout)"
    # Sparse + blobless would be lighter, but the pack is under 3 MB, so a plain
    # shallow clone is simpler and just as fast.
    if ! git clone --depth 1 --quiet "https://github.com/${REPO}.git" "$work" 2>&1; then
        rm -rf "$work"
        die "clone failed: $REPO" 4
    fi

    installed=0
    log ""
    log "installing to $SKILLS_DIR"
    for name in $KEEP; do
        src="$work/skills/$name"
        if [ ! -d "$src" ]; then
            log "  ! missing in repo: $name (skipped)"
            continue
        fi
        # External dirs are scanned ONE level deep, so each listed dir must be a
        # skill root. These are category dirs containing real skills, so copy
        # them under a category name of our own.
        target="$SKILLS_DIR/gamedev-$name"
        rm -rf "$target"
        cp -R "$src" "$target"
        n=$(find "$target" -type f | wc -l)
        sz=$(du -sh "$target" | cut -f1)
        log "  + gamedev-$name  ($n files, $sz)"
        installed=$((installed + 1))
    done

    rm -rf "$work"

    log ""
    log "skipped on purpose:"
    for name in $SKIP; do
        log "  - $name — no Unity/Unreal runtime here (no engine binary, no .NET"
        log "    SDK, no display). The docs would be unexecutable."
    done

    log ""
    log "installed $installed category dir(s)"
    log "sizes: /data $(df -h /data | tail -1 | awk '{print $3}') used (unchanged),"
    log "       offload $(du -sh "$OFFLOAD_ROOT" | cut -f1)"
    log ""
    log "next: sh $HERMES_HOME/ghfirst/skill-fetch.sh list"
    log "      sh $HERMES_HOME/ghfirst/skill-fetch.sh push   # snapshot into the repo"
}

main
