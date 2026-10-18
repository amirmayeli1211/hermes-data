#!/bin/sh
# cred-rotate.sh — audit credential exposure, adopt a new token, scrub leaks.
#
# WHY THIS EXISTS
#   GitHub provides NO API to create or rotate a personal access token: it is a
#   browser-only flow, and this tool will never ask for or type a password.
#   What it CAN do is everything around that one manual step — show exactly what
#   is exposed and where, validate a replacement before trusting it, swap it in
#   atomically, and clean up copies that should never have existed.
#
# THE PROBLEM THIS WAS BUILT FOR
#   A classic token arrived in a chat message. It is now in:
#     - .env               (correct — that is the credential store)
#     - state.db / -wal    (the session transcript that contains the message)
#     - cache/documents/   (the attachment the message came in)
#   And it carries delete_repo, admin:org, workflow, write:packages, audit_log —
#   far more than "read and write one private repository" needs.
#
#   Redacting the local copies does NOT undo that exposure. The token has been
#   transmitted and stored in plaintext beyond any single machine; the only
#   correct fix is to revoke it and use a new, least-privilege one. Scrubbing
#   here is damage limitation, not a substitute for revocation.
#
# Usage:
#   sh cred-rotate.sh audit                       what credentials exist, where they leak
#   sh cred-rotate.sh check-token <candidate>     validate BEFORE adopting (no writes)
#   sh cred-rotate.sh adopt <candidate>           swap in atomically after validating
#   sh cred-rotate.sh scrub                       redact the exposed token from non-store files
#   sh cred-rotate.sh verify                      prove the configured token still works
#
# Exit codes: 0 ok · 3 no credential configured · 4 candidate rejected
#             5 refused (unsafe) · 6 verification failed

set -u

HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
ENV_FILE="${HERMES_HOME}/.env"
REPO="${GHSTORE_REPO:-amirmayeli1211/hermes-data}"
TOOL="${HERMES_HOME}/ghfirst/ghstore.py"
PY="${HERMES_PYTHON:-$(command -v python3)}"

log() { printf '%s\n' "$*"; }
# Print only the message: using "$*" would append the exit-code argument, so a
# call like `die "msg" 4` printed "msg 4".
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

current_token() {
    # Read from the environment first, then the credential store. Never echoes
    # the value to stdout — callers capture it into a variable only.
    if [ -n "${GITHUB_TOKEN:-}" ]; then printf '%s' "$GITHUB_TOKEN"; return 0; fi
    [ -f "$ENV_FILE" ] || return 1
    awk -F= '/^GITHUB_TOKEN=/{sub(/^GITHUB_TOKEN=/,""); print; exit}' "$ENV_FILE"
}

# --- token validation (the part that must not be skipped) ------------------

# Validates a candidate by calling the API with THAT token, never the stored one.
validate_candidate() {
    cand="$1"
    [ -n "$cand" ] || die "no candidate token given" 4

    "$PY" - "$cand" "$REPO" <<'PY'
import json, sys, urllib.error, urllib.request

token, repo = sys.argv[1], sys.argv[2]
API = "https://api.github.com"


def call(path):
    req = urllib.request.Request(
        API + path,
        headers={"Authorization": f"Bearer {token}",
                 "Accept": "application/vnd.github+json",
                 "User-Agent": "cred-rotate"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read()), dict(r.headers)
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
        except Exception:
            body = {}
        return e.code, body, dict(e.headers)


fail = []

status, user, _ = call("/user")
if status != 200:
    print(f"  REJECTED: token does not authenticate (HTTP {status}: "
          f"{user.get('message', 'unknown')})")
    sys.exit(4)
login = user.get("login")
print(f"  authenticates as   : {login}")

status, repo_info, _ = call(f"/repos/{repo}")
if status != 200:
    print(f"  REJECTED: cannot see {repo} (HTTP {status}) — scope it to this "
          f"repository, or the name is wrong")
    sys.exit(4)
print(f"  target repo        : {repo_info['full_name']} "
      f"private={repo_info['private']}")

perms = repo_info.get("permissions", {})
if not perms.get("push"):
    print("  REJECTED: token cannot push to this repository (needs Contents: "
          "Read and write)")
    sys.exit(4)
print(f"  push permission    : yes")

# The header is only present for classic tokens; fine-grained tokens report an
# empty scope list and are governed by their resource permissions instead.
status, _, headers = call("/user")
scopes = [s.strip() for s in headers.get("X-OAuth-Scopes", "").split(",") if s.strip()]
if scopes:
    print(f"  classic scopes     : {', '.join(scopes)}")
    dangerous = {"delete_repo", "admin:org", "admin:enterprise", "admin:org_hook",
                 "workflow", "write:packages", "delete:packages", "audit_log",
                 "admin:public_key", "admin:ssh_signing_key", "user",
                 "write:network_configurations", "codespace", "copilot"}
    extra = sorted(set(scopes) & dangerous)
    if extra:
        print(f"  EXCESSIVE scopes   : {', '.join(extra)}")
        print("  This token can do far more than store state in one repo. "
              "A fine-grained token with Contents: Read and write is the fix.")
        fail.append("excessive-scopes")
    if "repo" not in scopes:
        print("  REJECTED: no 'repo' scope; cannot read/write a private repo")
        sys.exit(4)
else:
    print("  token type         : fine-grained (no classic scopes)")

# Confirm it can actually write: list branches is a cheap read, and the
# create-blob path is what a push needs. Do NOT create anything during a check.
status, _, _ = call(f"/repos/{repo}/git/ref/heads/{repo_info['default_branch']}")
if status not in (200, 404, 409):
    print(f"  REJECTED: cannot read refs (HTTP {status})")
    sys.exit(4)
print(f"  repo read access   : yes")

if fail:
    print("\n  Valid for the job, but over-privileged. Prefer a narrower token:")
    print("  GitHub -> Settings -> Developer settings -> Personal access tokens")
    print("  -> Fine-grained tokens -> Generate new token")
    print(f"     Repository access : Only select repositories -> {repo}")
    print("     Permissions       : Contents = Read and write")
    print("   (Metadata: Read-only is added automatically.)")
    sys.exit(0)

print("\n  ACCEPTED: least-privilege token suitable for this repo.")
sys.exit(0)
PY
}

cmd_check_token() {
    log "=== validating candidate token (nothing is written) ==="
    validate_candidate "${1:-}"
    rc=$?
    if [ "$rc" -eq 0 ]; then
        log ""
        log "adopt it with: sh $0 adopt <candidate>"
    fi
    return "$rc"
}

cmd_adopt() {
    cand="${1:-}"
    [ -n "$cand" ] || die "usage: cred-rotate.sh adopt <new-token>" 64
    [ -f "$ENV_FILE" ] || die "credential store not found: $ENV_FILE" 5

    log "=== step 1: validate the candidate before trusting it ==="
    validate_candidate "$cand"
    rc=$?
    [ "$rc" -eq 0 ] || die "candidate rejected (exit $rc) — nothing changed" 4

    old="$(current_token || true)"

    log ""
    log "=== step 2: back up the credential store ==="
    bak="${ENV_FILE}.pre-rotate.$(date -u +%Y%m%dT%H%M%SZ)"
    cp "$ENV_FILE" "$bak"
    chmod 600 "$bak"
    log "  saved: $bak (mode 600)"

    log ""
    log "=== step 3: swap the token atomically ==="
    tmp="${ENV_FILE}.rotate.$$"
    awk -v new="$cand" '
        /^GITHUB_TOKEN=/ { print "GITHUB_TOKEN=" new; replaced = 1; next }
        { print }
        END { if (!replaced) print "GITHUB_TOKEN=" new }
    ' "$ENV_FILE" > "$tmp"
    chmod 600 "$tmp"
    # Atomic: a crash mid-write cannot leave a half-written credential store.
    mv "$tmp" "$ENV_FILE"
    log "  GITHUB_TOKEN updated in $ENV_FILE"

    log ""
    log "=== step 4: prove the NEW token works end to end ==="
    GITHUB_TOKEN="$cand" "$PY" "$TOOL" verify 2>&1 | tail -3
    vrc=$?
    if [ "$vrc" -ne 0 ]; then
        log ""
        log "  VERIFY FAILED with the new token — rolling back"
        cp "$bak" "$ENV_FILE"; chmod 600 "$ENV_FILE"
        die "  restored the previous credential store from $bak" 6
    fi

    log ""
    log "=== step 5: confirm the OLD token is now unused ==="
    if [ -n "$old" ]; then
        if [ "$old" = "$cand" ]; then
            log "  WARNING: the candidate is identical to the token already in place."
            log "  Nothing was actually rotated."
        else
            log "  Old token is no longer referenced by $ENV_FILE."
            log "  REVOKE IT NOW so the exposure in chat/history becomes inert:"
            log "    https://github.com/settings/tokens"
        fi
    fi

    log ""
    log "Rotation complete. Keep the backup until you have confirmed things work:"
    log "  rm $bak"
}

# --- exposure audit -------------------------------------------------------

cmd_audit() {
    tok="$(current_token || true)"

    log "=== credential stores ==="
    for f in .env auth.json credentials.json shared/nous_auth.json .op.env; do
        [ -e "${HERMES_HOME}/$f" ] || continue
        perms="$(stat -c%a "${HERMES_HOME}/$f")"
        size="$(stat -c%s "${HERMES_HOME}/$f")"
        flag="ok"
        [ "$perms" = "600" ] || flag="LOOSE PERMISSIONS (should be 600)"
        printf '  %-28s %6sB  mode=%s  %s\n' "$f" "$size" "$perms" "$flag"
    done

    log ""
    log "=== key names present (values never printed) ==="
    if [ -f "$ENV_FILE" ]; then
        awk -F= '/^[A-Z_]+=/ {print "  " $1}' "$ENV_FILE" | sort -u
    fi

    log ""
    log "=== where does the configured token appear on disk? ==="
    if [ -z "$tok" ]; then
        log "  (no token configured — nothing to scan for)"
    else
        "$PY" - "$tok" "$HERMES_HOME" <<'PY'
import pathlib, sys
tok, home = sys.argv[1].encode(), pathlib.Path(sys.argv[2])
LEGIT = {".env"}
hits = []
for p in home.rglob("*"):
    if not p.is_file():
        continue
    try:
        if p.stat().st_size > 8_000_000:
            continue
        if tok in p.read_bytes():
            hits.append(p.relative_to(home).as_posix())
    except OSError:
        continue
if not hits:
    print("  no copies found")
for h in sorted(hits):
    top = h.split("/")[0]
    if h in LEGIT:
        print(f"  [store]          {h}   (correct place)")
    elif top in ("cache",) or "/documents/" in h:
        print(f"  [LEAK: staging]  {h}   (a staged upload/download copy)")
    elif h.startswith("state.db"):
        print(f"  [LEAK: history]  {h}   (session transcript containing the message)")
    elif h in ("logs",) or h.startswith("logs/"):
        print(f"  [LEAK: log]      {h}")
    else:
        print(f"  [LEAK: other]    {h}")
PY
    fi

    log ""
    log "=== token scope ==="
    if [ -z "$tok" ]; then
        log "  (none configured)"
    else
        GITHUB_TOKEN="$tok" "$PY" - "$REPO" <<'PY'
import json, sys, urllib.error, urllib.request
repo = sys.argv[1]
req = urllib.request.Request("https://api.github.com/user",
    headers={"Authorization": f"Bearer {__import__('os').environ['GITHUB_TOKEN']}",
             "Accept": "application/vnd.github+json", "User-Agent": "cred-rotate"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        scopes = [s.strip() for s in r.headers.get("X-OAuth-Scopes", "").split(",") if s.strip()]
        print(f"  classic scopes       : {', '.join(scopes) if scopes else '(none — fine-grained)'}")
        dangerous = sorted(set(scopes) & {"delete_repo", "admin:org", "admin:enterprise",
            "admin:org_hook", "workflow", "write:packages", "delete:packages",
            "audit_log", "codespace", "copilot", "user"})
        if dangerous:
            print(f"  EXCESSIVE            : {', '.join(dangerous)}")
            print(f"  -> can delete repositories and alter org settings; a state-storage")
            print(f"     token needs only Contents: Read and write on {repo}")
except Exception as e:
    print(f"  could not read scopes: {e}")
PY
    fi

    log ""
    log "the only complete fix for a token that left this machine is revocation;"
    log "run: sh $0 adopt <new-token>   then revoke the old one in the browser."
}

# --- scrubbing ------------------------------------------------------------

# Redact the token from files that should never hold it. state.db is the session
# transcript; cache/ holds staged attachments. logs are plain text.
cmd_scrub() {
    tok="$(current_token || true)"
    [ -n "$tok" ] || die "no token configured; nothing to scrub" 3

    log "=== step 1: stop writers that could re-introduce the value ==="
    log "  state.db is held open by the gateway; scrubbing a live SQLite file"
    log "  requires the WAL to be checkpointed first. Running that now."
    "$PY" -c "
import sqlite3
c = sqlite3.connect('${HERMES_HOME}/state.db', timeout=10)
c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
c.close()
print('  WAL checkpointed')
"

    log ""
    log "=== step 2: back up everything about to be modified ==="
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    bakdir="${HERMES_HOME}/backups/cred-scrub-${stamp}"
    mkdir -p "$bakdir"
    chmod 700 "$bakdir"
    for f in state.db .env; do
        [ -f "${HERMES_HOME}/$f" ] && cp "${HERMES_HOME}/$f" "$bakdir/$f" 2>/dev/null
    done
    log "  backups in: $bakdir"

    log ""
    log "=== step 3: redact from non-store files ==="
    "$PY" - "$tok" "$HERMES_HOME" <<'PY'
import pathlib, sqlite3, sys

tok, home = sys.argv[1], pathlib.Path(sys.argv[2])
REDACT = "[REDACTED-ROTATED-TOKEN]"
LEGIT = {"state.db", ".env"}   # handled separately, never touched as plain text
changed = []

# -- plain-text files: logs, staged attachments, caches --------------------
for p in home.rglob("*"):
    if not p.is_file():
        continue
    rel = p.relative_to(home).as_posix()
    if rel in LEGIT or rel.startswith("backups/"):
        continue
    if rel.startswith("state.db"):
        continue
    try:
        if p.stat().st_size > 8_000_000:
            continue
        data = p.read_bytes()
    except OSError:
        continue
    if tok.encode() not in data:
        continue
    # Only rewrite formats we can rewrite safely: text-ish files.
    if b"\x00" in data[:4096]:
        print(f"  SKIP (binary, not rewritten): {rel}")
        continue
    p.write_bytes(data.replace(tok.encode(), REDACT.encode()))
    changed.append(rel)

# -- the session store ----------------------------------------------------
# UPDATE ... REPLACE across every TEXT column of every table: the token may sit
# in a message body, a tool result, or an attachment reference. Values are
# replaced in place so surrounding history stays intact.
db = home / "state.db"
if db.exists():
    try:
        con = sqlite3.connect(str(db), timeout=15)
        tables = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")]
        n = 0
        for t in tables:
            try:
                cols = [r[1] for r in con.execute(f'PRAGMA table_info("{t}")')]
            except sqlite3.Error:
                continue
            text_cols = []
            for c in cols:
                try:
                    row = con.execute(
                        f'SELECT typeof("{c}") FROM "{t}" LIMIT 1').fetchone()
                except sqlite3.Error:
                    continue
                if row and row[0] in ("text", "null"):
                    text_cols.append(c)
            for c in text_cols:
                try:
                    cur = con.execute(
                        f'UPDATE "{t}" SET "{c}" = REPLACE("{c}", ?, ?) '
                        f'WHERE "{c}" LIKE ?', (tok, REDACT, f"%{tok}%"))
                    n += cur.rowcount if cur.rowcount > 0 else 0
                except sqlite3.Error:
                    continue
        con.commit()
        try:
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error:
            pass
        con.close()
        if n:
            changed.append(f"state.db ({n} field(s) redacted)")
    except sqlite3.Error as e:
        print(f"  state.db redaction FAILED: {e}")

if changed:
    for c in changed:
        print(f"  redacted: {c}")
else:
    print("  nothing needed redaction")
PY

    log ""
    log "=== step 4: verify the token is gone from everywhere except the store ==="
    "$PY" - "$tok" "$HERMES_HOME" <<'PY'
import pathlib, sys
tok, home = sys.argv[1].encode(), pathlib.Path(sys.argv[2])
left = []
for p in home.rglob("*"):
    if not p.is_file():
        continue
    rel = p.relative_to(home).as_posix()
    if rel == ".env" or rel.startswith("backups/"):
        continue
    try:
        if p.stat().st_size > 8_000_000:
            continue
        if tok in p.read_bytes():
            left.append(rel)
    except OSError:
        continue
if left:
    for l in sorted(left):
        print(f"  STILL PRESENT: {l}")
    sys.exit(1)
print("  clean: the token now exists only in .env (and the backups)")
PY
    rc=$?

    log ""
    log "IMPORTANT: scrubbing does not undo the exposure. The token was sent"
    log "through Telegram and stored in plaintext; rotate it and revoke the old one."
    return "$rc"
}

cmd_verify() {
    log "=== verifying the configured credential ==="
    "$PY" "$TOOL" verify --full 2>&1 | tail -3
}

case "${1:-audit}" in
    audit)      cmd_audit ;;
    check-token) shift; cmd_check_token "${1:-}" ;;
    adopt)      shift; cmd_adopt "${1:-}" ;;
    scrub)      cmd_scrub ;;
    verify)     cmd_verify ;;
    -h|--help)  sed -n '2,40p' "$0" ;;
    *) die "unknown command: $1 (try: audit, check-token, adopt, scrub, verify)" 64 ;;
esac
