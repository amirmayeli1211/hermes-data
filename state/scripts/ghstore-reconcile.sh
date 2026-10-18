#!/bin/sh
# Cron wrapper: the real reconcile lives in ghfirst/ so it stays next to the
# tool it drives, but the Hermes cron runner requires jobs under scripts/.
# Keep this a pure delegate — logic belongs in exactly one place.
exec sh "${HERMES_HOME:-/data/.hermes}/ghfirst/reconcile.sh"
