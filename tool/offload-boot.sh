#!/bin/sh
# offload-boot.sh — re-establish the offload area after a container restart.
#
# WHY THIS EXISTS
#   /var/tmp lives on the EPHEMERAL overlay filesystem. It survives process
#   restarts but NOT container recreation, so after a redeploy the offload
#   directories are gone while .env still points TMPDIR at them.
#
#   That combination is actively dangerous: Python's tempfile falls back to the
#   next candidate when TMPDIR does not exist, and the next candidate here is
#   $HERMES_HOME/cache/scratch — the small /data volume this whole exercise is
#   meant to protect. Verified: with TMPDIR=/var/tmp/missing, tempfile.gettempdir()
#   returned /data/.hermes/cache/scratch and mkstemp wrote there.
#
#   So TMPDIR pointing at a missing directory is WORSE than not setting it:
#   it looks configured while silently falling back to the disk we are guarding.
#
# Wired as an on_session_start shell hook in config.yaml and also runs happily
# from cron or by hand. Idempotent and fast (directory creation only).
#
# Registered via:
#   hooks:
#     on_session_start:
#       - command: "sh /data/.hermes/ghfirst/offload-boot.sh"

set -eu

HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
OFFLOAD_ROOT="${HERMES_OFFLOAD_ROOT:-/var/tmp/hermes-offload}"

# Recreate the tree. mkdir -p is a no-op when it already exists.
mkdir -p "$OFFLOAD_ROOT"/tmp "$OFFLOAD_ROOT"/work "$OFFLOAD_ROOT"/skills \
         "$OFFLOAD_ROOT"/downloads "$OFFLOAD_ROOT"/clones
chmod 700 "$OFFLOAD_ROOT" 2>/dev/null || true

# Confirm we are NOT about to point temp at the persistent disk.
if [ "$(findmnt -T "$OFFLOAD_ROOT" -o SOURCE -n 2>/dev/null)" = \
     "$(findmnt -T /data -o SOURCE -n 2>/dev/null)" ]; then
    printf 'offload-boot: WARNING — %s is on the same filesystem as /data; offloading is useless.\n' \
        "$OFFLOAD_ROOT" >&2
fi

# A stale entry in $OFFLOAD_ROOT/tmp can be large after a long session; Hermes
# also prunes its own scratch on a 24h idle rule, which does not apply here.
find "$OFFLOAD_ROOT/tmp" -mindepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null || true

# --- keep the credential-store sidecar alive -------------------------------
#
# `$HERMES_HOME/.env` is REWRITTEN by the Hermes container entrypoint on every
# boot: it truncates the file and re-emits only the keys present in the
# container's environment. A token appended to `.env` by hand therefore survives
# until the next restart and then vanishes — measured on this deployment
# (GITHUB_TOKEN was gone after a container restart, and every scheduled push
# failed with "no GitHub credential found").
#
# The durable local copy is `$HERMES_HOME/.ghfirst/token` (mode 600, outside the
# sync map, never committed). Forward it into the credential store so the
# platform-managed `.env` and the sidecar agree, without regenerating it here:
# if the sidecar is absent, nothing is invented.
SIDECAR="${HERMES_HOME}/.ghfirst/token"
ENV_FILE="${HERMES_HOME}/.env"
if [ -s "$SIDECAR" ] && [ -f "$ENV_FILE" ] && ! grep -q '^GITHUB_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    printf 'GITHUB_TOKEN=%s\n' "$(cat "$SIDECAR")" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    printf 'offload-boot: restored GITHUB_TOKEN into the credential store from the local sidecar\n'
fi

# The same entrypoint rewrite drops TMPDIR, which silently puts temp writes back
# on the 434 MB volume — the exact failure this whole area exists to prevent.
# Re-assert it every tick; the directory above is guaranteed to exist by now.
if [ -f "$ENV_FILE" ] && ! grep -q '^TMPDIR=' "$ENV_FILE" 2>/dev/null; then
    printf 'TMPDIR=%s/tmp\n' "$OFFLOAD_ROOT" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    printf 'offload-boot: re-asserted TMPDIR in the credential store\n'
fi

# --- rehydrate offloaded skills -------------------------------------------
#
# The live copies of offloaded skills live HERE, on the ephemeral volume. Their
# durable snapshot is in the repo at state/skills/.offloaded/, which a restore
# writes to $HERMES_HOME/skills/.offloaded/ — a staging directory, NOT a path the
# agent scans. Without this step a container rebuild leaves every offloaded skill
# restored-but-invisible: present on the small disk, absent from skill_view.
#
# Verified before/after: a restored skill appeared only under
# $HERMES_HOME/skills/.offloaded/ and was missing from the live external dir.
STAGE="${HERMES_HOME}/skills/.offloaded"
if [ -d "$STAGE" ]; then
    added=0
    for d in "$STAGE"/*/; do
        [ -f "${d}SKILL.md" ] || continue
        name="$(basename "$d")"
        # Only copy when absent or changed, so a live edit is not silently reverted
        # on every tick. Compare the SKILL.md, which is what defines the skill.
        if [ ! -f "$OFFLOAD_ROOT/skills/$name/SKILL.md" ] || \
           ! cmp -s "${d}SKILL.md" "$OFFLOAD_ROOT/skills/$name/SKILL.md"; then
            rm -rf "$OFFLOAD_ROOT/skills/$name"
            cp -R "$d" "$OFFLOAD_ROOT/skills/$name"
            added=$((added + 1))
        fi
    done
    [ "$added" -gt 0 ] && printf 'offload-boot: rehydrated %s skill(s) from the repo snapshot\n' "$added"
fi

# --- keep big rebuildable trees OFF the small disk -------------------------
#
# The language-server tree (npm-installed pyright and friends) is 38 MB of
# third-party node_modules — 11% of the whole 434 MB volume, and it is pure
# rebuildable cache. It lives on the ephemeral disk and is reached through a
# symlink so Hermes' own <HERMES_HOME>/lsp lookups keep working unchanged.
#
# The symlink survives a container rebuild; its TARGET does not. A dangling
# symlink is worse than none: `os.makedirs(<home>/lsp/bin)` then fails with
# FileNotFoundError (measured), so `hermes lsp status` breaks instead of
# reinstalling. Recreate the target directory every tick.
LSP_LINK="${HERMES_HOME}/lsp"
LSP_REAL="${OFFLOAD_ROOT}/lsp"
if [ -L "$LSP_LINK" ]; then
    # The link survives a container rebuild; its target does not. Recreate it, or
    # every lookup through it fails with FileNotFoundError.
    mkdir -p "$LSP_REAL/bin"
elif [ -d "$LSP_LINK" ]; then
    # A REAL directory on /data: either the tree was never offloaded, or a
    # restore put it back. Move it to the big disk and re-point the link, so
    # the bytes stop occupying the small volume. The move is copy+delete
    # across filesystems (EXDEV), so it needs ~2x the tree size free here —
    # 38 MB on a 434 MB volume is fine, and the copy is checked before the
    # original is removed.
    if [ -d "$LSP_LINK/node_modules" ] || [ -s "$LSP_LINK/package.json" ]; then
        mkdir -p "$LSP_REAL"
        if cp -a "$LSP_LINK/." "$LSP_REAL/" 2>/dev/null && [ -d "$LSP_REAL/node_modules" ]; then
            rm -rf "$LSP_LINK"
            ln -sfn "$LSP_REAL" "$LSP_LINK"
            printf 'offload-boot: moved the language-server tree off /data\n'
        else
            printf 'offload-boot: WARNING — could not move the lsp tree; leaving it on /data\n' >&2
        fi
    fi
    mkdir -p "$LSP_LINK/bin" 2>/dev/null || true
fi
if [ ! -e "$LSP_LINK" ]; then
    mkdir -p "$LSP_REAL/bin"
    ln -sfn "$LSP_REAL" "$LSP_LINK"
fi

# npm's download cache is the same story at a smaller scale (5.7 MB): rebuildable,
# re-downloaded on demand. Symlinked, because a directory symlink is only
# traversed by npm — no os.replace across devices ever touches the link itself.
NPM_LINK="${HERMES_HOME}/home/.npm"
NPM_REAL="${OFFLOAD_ROOT}/npm-cache"
if [ -d "$NPM_LINK" ] && [ ! -L "$NPM_LINK" ]; then
    mkdir -p "$NPM_REAL"
    cp -a "$NPM_LINK/." "$NPM_REAL/" 2>/dev/null || true
    rm -rf "$NPM_LINK"
    ln -sfn "$NPM_REAL" "$NPM_LINK"
elif [ -L "$NPM_LINK" ]; then
    mkdir -p "$NPM_REAL"
fi

used="$(df -h /data | tail -1 | awk '{print $5}')"
printf 'offload-boot: %s ready; /data at %s used\n' "$OFFLOAD_ROOT" "$used"
exit 0
