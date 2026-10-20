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

used="$(df -h /data | tail -1 | awk '{print $5}')"
printf 'offload-boot: %s ready; /data at %s used\n' "$OFFLOAD_ROOT" "$used"
exit 0
