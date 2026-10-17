#!/bin/sh
# ghstore bootstrap — rebuild a Hermes instance from its GitHub repository.
#
# This script is the recovery entry point for a container whose filesystem is
# empty. It fetches the repo (or just the restore tool from it), then delegates
# to `ghstore.py pull`, which restores every durable state file and verifies
# each sha256 against state/manifest.json.
#
# Usage:
#   GITHUB_TOKEN=ghp_... sh bootstrap.sh [--repo owner/name] [--branch main]
#   GITHUB_TOKEN=... sh bootstrap.sh --dry-run
#
# Exit codes: 0 restored, 2 missing credential, 7 no commit/manifest,
#             8 partial (local files differed; re-run with --overwrite),
#             9 network failure, 10 API failure.

set -eu

REPO="${GHSTORE_REPO:-amirmayeli1211/hermes-data}"
BRANCH="${GHSTORE_BRANCH:-main}"
DRY_RUN=""
OVERWRITE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --repo) REPO="$2"; shift 2 ;;
        --branch) BRANCH="$2"; shift 2 ;;
        --dry-run) DRY_RUN="--dry-run"; shift ;;
        --overwrite) OVERWRITE="--overwrite"; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 64 ;;
    esac
done

if [ -z "${GITHUB_TOKEN:-}" ] && [ -z "${GHSTORE_TOKEN:-}" ]; then
    echo "ERROR: GITHUB_TOKEN is not set." >&2
    echo "  Provide a token that can read ${REPO}; nothing is fetched without it." >&2
    exit 2
fi

HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
export HERMES_HOME

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
    echo "ERROR: python3 not found; ghstore needs it (standard library only)." >&2
    exit 3
fi

WORK="${TMPDIR:-/tmp}/ghstore-bootstrap.$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT INT TERM

echo "[bootstrap] fetching ${REPO}@${BRANCH}"
if command -v git >/dev/null 2>&1; then
    if git clone --depth 1 --branch "$BRANCH" \
        "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" \
        "$WORK/repo" >"$WORK/clone.log" 2>&1; then
        TOOL="$WORK/repo/tool/ghstore.py"
    else
        echo "[bootstrap] git clone failed, falling back to the API" >&2
        sed -n '1,5p' "$WORK/clone.log" >&2 || true
        TOOL=""
    fi
else
    TOOL=""
fi

if [ -z "${TOOL:-}" ] || [ ! -f "$TOOL" ]; then
    mkdir -p "$WORK/repo/tool"
    API="https://api.github.com/repos/${REPO}/contents/tool/ghstore.py?ref=${BRANCH}"
    if ! curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
            -H "Accept: application/vnd.github.raw" "$API" -o "$WORK/repo/tool/ghstore.py"; then
        echo "ERROR: could not fetch tool/ghstore.py — check the token and repo." >&2
        exit 9
    fi
    TOOL="$WORK/repo/tool/ghstore.py"
fi

# Install the tool into a stable local path so cron and later runs do not
# depend on this temp directory.
mkdir -p "${HERMES_HOME}/ghfirst"
cp "$TOOL" "${HERMES_HOME}/ghfirst/ghstore.py"
chmod 0755 "${HERMES_HOME}/ghfirst/ghstore.py"

echo "[bootstrap] restoring into ${HERMES_HOME}"
set +e
"$PY" "${HERMES_HOME}/ghfirst/ghstore.py" pull --repo "$REPO" --branch "$BRANCH" \
    $DRY_RUN $OVERWRITE
rc=$?
set -e

case "$rc" in
    0) echo "[bootstrap] restore complete" ;;
    8) echo "[bootstrap] PARTIAL: some local files differ from the repo." >&2
       echo "  Inspect them, then re-run with --overwrite." >&2 ;;
    7) echo "[bootstrap] nothing to restore (empty repo or missing manifest)." >&2 ;;
    *) echo "[bootstrap] restore FAILED (exit $rc)" >&2 ;;
esac

echo "[bootstrap] verify the repo independently with:"
echo "  python3 ${HERMES_HOME}/ghfirst/ghstore.py verify --full"
exit "$rc"
