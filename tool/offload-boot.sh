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

used="$(df -h /data | tail -1 | awk '{print $5}')"
printf 'offload-boot: %s ready; /data at %s used\n' "$OFFLOAD_ROOT" "$used"
exit 0
