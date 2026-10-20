#!/usr/bin/env python3
"""ghstore — GitHub-first durable storage for Hermes Agent state.

Design rule (the whole point of this tool):
    The GitHub repository is the primary, permanent home of every durable
    artifact of this Hermes instance. The local filesystem is treated as a
    *reconstructible cache*, never as the system of record.

What lives in the repo
    state/**   durable Hermes state: config, memories, skills, plans, hooks,
               plugins, skins, cron job definitions + scripts, workspace files
    tool/**    this tool itself, so a fresh container can self-install
    state/manifest.json   per-file sha256 index + schema version

What never lives in the repo (enforced, fail-closed)
    .env, auth.json, any *.db / SQLite, session transcripts, logs, caches,
    locks/pid/sockets. Secrets are blocked by a regex scan that ABORTS the
    push; high-entropy strings produce warnings only (skills contain code
    samples that would false-positive).

Subcommands
    doctor   check token, repo, permissions, and what would be synced
    status   local vs repo drift (three-way: synced / local-only / remote-only)
    push     atomic multi-file commit of the whole tree, then read-back verify
    verify   read every remote blob back and compare sha256 against manifest
    pull     restore state from the repo into HERMES_HOME (safe by default)
    plan     show exactly which paths map where, no network writes

Only the standard library is used: this environment has no pip, no requests,
no jq. Anything else would not run here.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TOOL_VERSION = "1.0.0"
MANIFEST_SCHEMA = 1
DEFAULT_REPO = "amirmayeli1211/hermes-data"
DEFAULT_BRANCH = "main"
API_ROOT = "https://api.github.com"

MAX_ATTEMPTS = 5
BACKOFF_BASE = 1.5
BACKOFF_CAP = 60.0
HTTP_TIMEOUT = 45
MAX_FILE_BYTES = 4 * 1024 * 1024

# Guard rails for deletion, which is the one irreversible operation here.
DELETION_RATIO_LIMIT = 0.10   # >10% of tracked files disappearing needs --allow-deletions
DELETION_ABS_LIMIT = 25


# --------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------

def hermes_home() -> Path:
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env)
    return Path("/data/.hermes")


def tool_dir() -> Path:
    return Path(__file__).resolve().parent


def cache_dir() -> Path:
    return hermes_home() / ".ghfirst"


def cache_file() -> Path:
    return cache_dir() / "state.json"


# --------------------------------------------------------------------------
# what is durable vs what must never be committed
# --------------------------------------------------------------------------

# (local path relative to HERMES_HOME, repo path). Dirs are walked recursively.
# Top-level directories in the repository that hold restorable content. Used
# wherever the tool must recognise "a path this repo owns" (verify read-back,
# manifest cross-check, drift). `projects/` was added for product source code;
# forgetting it here made `push` commit successfully and then crash in verify.
REPO_ROOTS = ("state/", "tool/", "projects/")

SYNC_MAP = [
    ("config.yaml", "state/config.yaml"),
    ("SOUL.md", "state/SOUL.md"),
    ("memories", "state/memories"),
    ("skills", "state/skills"),
    ("plans", "state/plans"),
    ("hooks", "state/hooks"),
    ("plugins", "state/plugins"),
    ("skins", "state/skins"),
    ("scripts", "state/scripts"),
    ("workspace", "state/workspace"),
    # Parked projects (archive.sh): finished work whose bytes must survive a
    # container loss while staying out of the skill loader's scan paths.
    ("archive", "state/archive"),
    # Real software projects (not Hermes skills): source of every product Reza
    # builds here. Mapped to a top-level `projects/` tree so product code stays
    # separate from Hermes runtime state; one directory per project, flat.
    ("projects", "projects"),
    ("cron/jobs.json", "state/cron/jobs.json"),
    ("cron/output", "state/cron/output"),
]

# Any path component equal to one of these prunes the whole subtree.
EXCLUDE_DIRS = {
    ".git", "__pycache__", "node_modules", ".venv", "venv",
    "cache", "backups", "state-snapshots", "checkpoints",
    ".op.env", "pending_messages", "installs", "audio_cache",
    "image_cache", "plugin-update-checks", "cron-executions",
}

# Matched against the final path segment.
EXCLUDE_NAME_PATTERNS = [
    re.compile(r"^\.env"),                      # credential store, all variants
    re.compile(r"^auth\.json$"),                # OAuth tokens / credential pools
    re.compile(r"\.lock$"),                     # lock files (matched with search())
    re.compile(r"\.tmp$"),
    re.compile(r"\.pid$"),                      # pid files
    re.compile(r"\.sock$"),                     # sockets
    re.compile(r"\.db$"),                       # SQLite: sessions, kanban, cron
    re.compile(r"\.db-wal$"), re.compile(r"\.db-shm$"),
    re.compile(r"\.sqlite3?$"),
    re.compile(r"^models_dev_cache\.json$"),    # vendored model catalog cache
    re.compile(r"^provider_models_cache\.json$"),
    re.compile(r"^gateway_state\.json$"),
    re.compile(r"^gateway-starts\.log$"),
    re.compile(r"^telegram_update_receipts_.*\.json$"),
    re.compile(r"^\.skills_prompt_snapshot\.json$"),
    re.compile(r"^state\.json$"),               # local-only sync bookkeeping
    # Append-only per-fire cron telemetry (timings, token counts, errors).
    # Found by `audit` on a live home; grows a line per job fire.
    re.compile(r"^usage_audit\.jsonl$"),
    re.compile(r"\.pyc$"),
    re.compile(r"\.ghfirst-tmp$"),
    # Backups and sidecars of credential/state files. A careless `cp auth.json
    # auth.json.bak` would otherwise be committed: the .bak suffix is not in the
    # deny list, and the file it copies holds live tokens.
    re.compile(r"\.bak$"),
    re.compile(r"\.bak\.[0-9]+$"),
    re.compile(r"\.old$"),
    re.compile(r"\.orig$"),
    re.compile(r"\.save$"),
    re.compile(r"\.swp$"),
    re.compile(r"~$"),                          # editor backups (file~)
    re.compile(r"\.pre-rotate\."),
]

# Individual paths under HERMES_HOME that are runtime-only even though they are
# not caught by name alone.
EXCLUDE_REL_PREFIXES = (
    "sessions", "logs", "runtime", "pairing", "state",
    "shared", ".curator_backups",
    # Subprocess HOME: browser caches, fontconfig, NSS key database.
    "home", "pending",
    "cron/executions.db", "cron/.tick.lock", "cron/.jobs.lock",
    "cron/ticker_heartbeat", "cron/ticker_last_success",
    "cron/executions.db-wal", "cron/executions.db-shm",
    # Catch-up bookkeeping written by the cron ticker each fire; meaningless to
    # Git and regenerated on boot. Found by `audit` after a container rebuild.
    "cron/catch_up_occurrences",
    ".ghfirst",
)

# Runtime churn that is rebuildable or meaningless to Git. Every one of these
# must have a reason, because the `audit` command fails on any file it cannot
# classify — a silent gap is how unwanted data accumulates on the disk.
REBUILDABLE_PREFIXES = (
    "logs", "sessions", "runtime", "cache", "backups", "pairing",
    "pending_messages", "installs", "image_cache", "audio_cache",
    "plugin-update-checks", "kanban", "state", "shared", ".curator_backups",
    # gateway/ holds restart-loop bookkeeping (boot timestamps). Found by `audit`
    # after a container restart; regenerated by the supervisor, meaningless to Git.
    "gateway",
    # HERMES_HOME/home is the subprocess HOME for terminal tools. Running a
    # browser for the test suite fills it with fontconfig caches, a chromium
    # profile and an NSS key database — all regenerated on demand, and the key
    # database can hold client certificates, so it must never be committed.
    "home",
    # pending/ is the background-review queue: transient memory operations that
    # Hermes applies itself. Committing a snapshot of it would risk re-applying
    # an operation on restore.
    "pending",
)

# Individual runtime files that are neither synced nor caught by a prefix above.
RUNTIME_LOCAL_FILES = (
    "channel_directory.json",   # regenerated from gateway routing on boot
    "processes.json",           # live process table, empty on restart
    "install_id",               # per-install identity; a restored one would collide
    ".initialized",             # container boot marker
    "models_dev_cache.etag",    # HTTP cache validator, refetched
    "models_dev_cache.json",    # vendored model catalog, re-downloaded
    "provider_models_cache.json",
    "gateway_state.json",
    ".skills_prompt_snapshot.json",
)

# Credential material that lives directly under HERMES_HOME. Never in SYNC_MAP;
# enumerated so the exclusion report can name them instead of silently dropping.
SENSITIVE_LOCAL_FILES = (
    ".env", ".env.local", ".env.production", ".op.env",
    "auth.json", "credentials.json",
    "shared/nous_auth.json",    # holds live OAuth JWTs for the Nous portal
    "shared/nous_auth.lock",
)

SECRET_BLOCK_PATTERNS = [
    # Token patterns carry a negative lookbehind so that a hyphenated word such as
    # `task-concurrency-diagnosis.md` cannot masquerade as an `sk-` key.
    ("github-classic-token", re.compile(r"(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{20,}")),
    ("github-fine-grained-token", re.compile(r"(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}")),
    ("github-oauth-token", re.compile(r"(?<![A-Za-z0-9_])gh[ousr]_[A-Za-z0-9]{30,}")),
    ("openai-anthropic-key", re.compile(r"(?<![A-Za-z0-9_])sk-(?:ant-)?[A-Za-z0-9_\-]{20,}")),
    ("xai-key", re.compile(r"(?<![A-Za-z0-9_])xai-[A-Za-z0-9]{20,}")),
    ("google-api-key", re.compile(r"(?<![A-Za-z0-9_])AIza[0-9A-Za-z_\-]{30,}")),
    ("aws-access-key", re.compile(r"(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}")),
    ("slack-token", re.compile(r"(?<![A-Za-z0-9_])xox[baprs]-[A-Za-z0-9\-]{10,}")),
    ("npm-token", re.compile(r"(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{30,}")),
    ("pypi-token", re.compile(r"(?<![A-Za-z0-9_])pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\-]{10,}")),
    ("telegram-bot-token", re.compile(r"(?<!\d)\d{8,10}:[A-Za-z0-9_\-]{35}(?![\w\-])")),
    ("private-key-block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    # A JWT is three base64url segments. OAuth access/refresh tokens (Nous portal,
    # Google, etc.) are JWTs and match nothing else here, so without this a live
    # bearer token in a synced file would pass the gate with only a soft warning.
    ("jwt-token", re.compile(
        r"(?<![A-Za-z0-9_\-])eyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{10,}")),
    ("bearer-token", re.compile(r"[Bb]earer[ \t]+(?<![A-Za-z0-9_])[A-Za-z0-9_\-\.]{30,}")),
    ("db-uri-with-password", re.compile(r"(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s:@/]+:[^\s@/]{6,}@")),
    # `[ \t]` and not `\s`: an assignment must be on ONE line. With bare `\s` the
    # pattern spans newlines and matches `client_secret:` followed by the next
    # line's identifier, which is how a docstring produced a false positive.
    ("credential-assignment", re.compile(
        r"(?i)\b(api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token"
        r"|auth[_-]?token|private[_-]?key|password|passwd|bot[_-]?token)\b"
        r"[ \t]*[:=][ \t]*[\"']?([A-Za-z0-9/+_\-\.]{16,})")),
]

SECRET_PLACEHOLDER_RE = re.compile(
    r"(?i)^(?:x{2,}|\.{3,}|\*{3,}|<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}|"
    r"your[-_ ]?\w*|changeme|placeholder|redacted|example|none|null|dummy|test)$")


def _is_placeholder(value: str) -> bool:
    return bool(SECRET_PLACEHOLDER_RE.match(value.strip()))


def scan_text(text: str) -> tuple[list[str], list[str]]:
    """Return (blocking_findings, warning_findings) for one text blob."""
    blocking: list[str] = []
    warnings: list[str] = []
    for label, pattern in SECRET_BLOCK_PATTERNS:
        for m in pattern.finditer(text):
            matched = m.group(0)
            captured = m.group(m.lastindex) if (m.lastindex and m.lastindex >= 1) else ""
            # Documentation carries invented keys: `ghp_xx...xxxx`, `sk-xxx...xxxx`,
            # `YOUR_API_KEY`. Blocking on those would make every skills tree
            # unpushable, so a placeholder-shaped match is not a finding.
            if _is_placeholder(captured) or _is_placeholder(matched):
                continue
            if "..." in matched or "xxx" in matched.lower() or "your" in matched.lower():
                continue
            blocking.append(label)
            break
    for cand in re.findall(r"[A-Za-z0-9+/=_\-]{32,}", text):
        if _shannon(cand) >= 4.4 and not _is_placeholder(cand):
            warnings.append("high-entropy-string")
            break
    return blocking, warnings


def _shannon(s: str) -> float:
    if not s:
        return 0.0
    counts: dict[str, int] = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def is_excluded(rel: str) -> bool:
    """True when a HERMES_HOME-relative path must never be synced.

    Single source of truth for exclusion: `collect_local` (what gets pushed) and
    `cmd_audit` (what gets reported) must never disagree about a path, or a file
    could sit on the container disk while both report it handled.
    """
    rel = rel.strip("/")
    if not rel:
        return True
    if rel in SENSITIVE_LOCAL_FILES or rel in RUNTIME_LOCAL_FILES:
        return True
    parts = rel.split("/")
    for p in parts[:-1]:
        if p in EXCLUDE_DIRS:
            return True
    if parts[-1] in EXCLUDE_DIRS:
        return True
    for prefix in EXCLUDE_REL_PREFIXES:
        if rel == prefix or rel.startswith(prefix + "/"):
            return True
    name = parts[-1]
    for pat in EXCLUDE_NAME_PATTERNS:
        # search(), not match(): patterns like `\.lock$` are suffix-anchored and
        # `match()` would only ever accept names *beginning* with the suffix.
        if pat.search(name):
            return True
    return False


# --------------------------------------------------------------------------
# GitHub REST client: bounded retries, backoff, rate-limit aware
# --------------------------------------------------------------------------

class GhError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, body: str = ""):
        super().__init__(message)
        self.status = status
        self.body = body


class GitHub:
    def __init__(self, token: str, repo: str, verbose: bool = False):
        self.token = token
        self.repo = repo
        self.verbose = verbose
        self.calls = 0

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": f"ghstore/{TOOL_VERSION}",
        }

    def request(self, method: str, path: str, body: dict | None = None,
                expectation: tuple[int, ...] = (200, 201), allow_404: bool = False):
        url = path if path.startswith("http") else API_ROOT + path
        payload = json.dumps(body).encode() if body is not None else None
        last_err: Exception | None = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            req = urllib.request.Request(url, data=payload, method=method,
                                         headers=self._headers())
            if payload is not None:
                req.add_header("Content-Type", "application/json")
            try:
                self.calls += 1
                with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                    data = resp.read()
                    if self.verbose:
                        print(f"  [http] {method} {path} -> {resp.status}", file=sys.stderr)
                    if resp.status in expectation or resp.status == 200:
                        return json.loads(data) if data else {}
                    raise GhError(f"unexpected HTTP {resp.status}", resp.status, data[:500].decode("utf-8", "replace"))
            except urllib.error.HTTPError as exc:
                status = exc.code
                try:
                    err_body = exc.read().decode("utf-8", "replace")
                except Exception:
                    err_body = ""
                if allow_404 and status == 404:
                    return None
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                remaining = exc.headers.get("X-RateLimit-Remaining") if exc.headers else None
                rate_limited = status in (403, 429) and (retry_after is not None or remaining == "0")
                server_error = 500 <= status < 600
                if (rate_limited or server_error) and attempt < MAX_ATTEMPTS:
                    delay = self._delay(attempt, retry_after, rate_limited)
                    last_err = GhError(f"HTTP {status} (retrying in {delay:.1f}s)", status, err_body[:300])
                    print(f"  [retry] {method} {path} -> HTTP {status}; attempt "
                          f"{attempt}/{MAX_ATTEMPTS}, sleeping {delay:.1f}s", file=sys.stderr)
                    time.sleep(delay)
                    continue
                raise GhError(f"HTTP {status} on {method} {path}: {err_body[:400]}", status, err_body)
            except (urllib.error.URLError, socket.timeout, ConnectionError, TimeoutError) as exc:
                last_err = exc
                if attempt < MAX_ATTEMPTS:
                    delay = self._delay(attempt, None, False)
                    print(f"  [retry] {method} {path} -> network error {exc!r}; attempt "
                          f"{attempt}/{MAX_ATTEMPTS}, sleeping {delay:.1f}s", file=sys.stderr)
                    time.sleep(delay)
                    continue
                raise GhError(f"network failure on {method} {path}: {exc!r}") from exc
        raise GhError(f"exhausted {MAX_ATTEMPTS} attempts on {method} {path}: {last_err}")

    @staticmethod
    def _delay(attempt: int, retry_after: str | None, rate_limited: bool) -> float:
        if retry_after:
            try:
                return min(float(retry_after) + 0.5, BACKOFF_CAP)
            except ValueError:
                pass
        base = min(BACKOFF_BASE ** attempt, BACKOFF_CAP)
        return base * (2.0 if rate_limited else 1.0)

    # --- git data API -----------------------------------------------------

    def get_user(self) -> dict:
        return self.request("GET", "/user")

    def get_repo(self) -> dict:
        return self.request("GET", f"/repos/{self.repo}")

    def get_ref(self, branch: str) -> dict | None:
        try:
            return self.request("GET", f"/repos/{self.repo}/git/ref/heads/{branch}",
                                allow_404=True)
        except GhError as exc:
            # An initialized-but-empty repository answers 409 "Git Repository is
            # empty" instead of 404 — that is the pre-first-push state, not an error.
            if exc.status == 409:
                return None
            raise

    def get_commit(self, sha: str) -> dict:
        return self.request("GET", f"/repos/{self.repo}/git/commits/{sha}")

    def get_tree(self, sha: str, recursive: bool = True) -> dict:
        suffix = "?recursive=1" if recursive else ""
        return self.request("GET", f"/repos/{self.repo}/git/trees/{sha}{suffix}")

    def get_blob(self, sha: str) -> dict:
        return self.request("GET", f"/repos/{self.repo}/git/blobs/{sha}")

    def create_blob(self, content: bytes) -> str:
        resp = self.request("POST", f"/repos/{self.repo}/git/blobs", {
            "content": base64.b64encode(content).decode("ascii"),
            "encoding": "base64",
        })
        return resp["sha"]

    def create_tree(self, entries: list[dict], base_tree: str | None) -> str:
        body: dict = {"tree": entries}
        if base_tree:
            body["base_tree"] = base_tree
        resp = self.request("POST", f"/repos/{self.repo}/git/trees", body)
        return resp["sha"]

    def create_commit(self, message: str, tree: str, parents: list[str]) -> dict:
        return self.request("POST", f"/repos/{self.repo}/git/commits", {
            "message": message, "tree": tree, "parents": parents,
        })

    def create_ref(self, branch: str, sha: str) -> dict:
        return self.request("POST", f"/repos/{self.repo}/git/refs",
                            {"ref": f"refs/heads/{branch}", "sha": sha})

    def update_ref(self, branch: str, sha: str, force: bool = False) -> dict:
        return self.request("PATCH", f"/repos/{self.repo}/git/refs/heads/{branch}",
                            {"sha": sha, "force": force})

    def is_empty(self) -> bool:
        """A repo with zero commits rejects the whole git-data API with 409."""
        try:
            data = self.request("GET", f"/repos/{self.repo}/commits?per_page=1",
                                allow_404=True)
        except GhError as exc:
            if exc.status == 409:
                return True
            raise
        return not data

    def initialize_with_seed(self, branch: str, message: str) -> str:
        """Create the repository's very first commit.

        ``POST /git/blobs`` answers 409 "Git Repository is empty" until a ref
        exists, so the git-data path cannot bootstrap itself. The Contents API
        CAN create the first commit, so seed one tiny file with it, after which
        every normal git-data operation works.
        """
        seed = ("# hermes-data\n\nBootstrapped by ghstore. Real content follows "
                "in the next commit.\n")
        try:
            resp = self.request("PUT", f"/repos/{self.repo}/contents/README.md", {
                "message": message,
                "content": base64.b64encode(seed.encode()).decode("ascii"),
                "branch": branch,
            }, expectation=(200, 201))
        except GhError as exc:
            if exc.status == 422 and "sha" in exc.body.lower():
                # A README already exists (repo initialized out of band).
                ref = self.get_ref(branch)
                if ref:
                    return ref["object"]["sha"]
            raise
        commit_sha = resp.get("commit", {}).get("sha")
        if not commit_sha:
            raise GhError("repository initialization returned no commit sha")
        return commit_sha


# --------------------------------------------------------------------------
# token resolution
# --------------------------------------------------------------------------

def resolve_token(explicit: str | None = None) -> tuple[str | None, str]:
    """Return (token, source). Source is reported so failures are diagnosable.

    Three sources, in order, because `$HERMES_HOME/.env` is REGENERATED by the
    Hermes container entrypoint on every boot (it rewrites the file from the
    container's environment). A token appended to `.env` by hand survives until
    the next restart and then vanishes — measured on this deployment, which is
    why the sidecar below exists:

      1. explicit (--token) / environment
      2. `$HERMES_HOME/.ghfirst/token` — survives restarts, local-only, never synced
      3. `$HERMES_HOME/.env` — canonical location when the platform sets
         GITHUB_TOKEN as a container environment variable
    """
    if explicit:
        return explicit, "--token"
    env = os.environ.get("GHSTORE_TOKEN") or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if env and env.strip():
        return env.strip(), "environment"
    sidecar = cache_dir() / "token"
    if sidecar.exists():
        try:
            value = sidecar.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            value = ""
        if value:
            return value, f"{sidecar} (local sidecar)"
    env_file = hermes_home() / ".env"
    if env_file.exists():
        try:
            for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                if key.strip() in ("GITHUB_TOKEN", "GHSTORE_TOKEN", "GH_TOKEN"):
                    value = value.strip().strip('"').strip("'")
                    if value:
                        return value, f"{env_file} (credential store)"
        except OSError:
            pass
    return None, "missing"


def require_token(explicit: str | None = None) -> str:
    token, source = resolve_token(explicit)
    if not token:
        raise SystemExit(
            "ERROR: no GitHub credential found.\n"
            "  Set GITHUB_TOKEN in the environment, or add this line to "
            f"{hermes_home() / '.env'} (the credential store, never committed):\n"
            "      GITHUB_TOKEN=ghp_...\n"
            "No token is invented or requested interactively by design."
        )
    return token


# --------------------------------------------------------------------------
# local collection
# --------------------------------------------------------------------------

def iter_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS)
        for name in sorted(filenames):
            yield Path(dirpath) / name


def collect_local(home: Path) -> tuple[dict[str, bytes], list[dict], list[dict]]:
    """Return (repo_path -> content, excluded report, skipped report)."""
    files: dict[str, bytes] = {}
    excluded: list[dict] = []
    skipped: list[dict] = []

    for rel, repo_path in SYNC_MAP:
        local = home / rel
        if not local.exists():
            continue
        if local.is_dir():
            for path in iter_files(local):
                sub = path.relative_to(local).as_posix()
                full_rel = f"{rel}/{sub}"
                if is_excluded(full_rel):
                    excluded.append({"path": full_rel, "reason": "exclude-rule"})
                    continue
                data = _read_bounded(path, full_rel, skipped)
                if data is not None:
                    files[f"{repo_path}/{sub}"] = data
        else:
            if is_excluded(rel):
                excluded.append({"path": rel, "reason": "exclude-rule"})
                continue
            data = _read_bounded(local, rel, skipped)
            if data is not None:
                files[repo_path] = data

    # Runtime churn inside cron/output is noisy; keep only the newest 40 files.
    out_keys = sorted(k for k in files if k.startswith("state/cron/output/"))
    for key in out_keys[:-40]:
        files.pop(key, None)
        excluded.append({"path": key, "reason": "cron-output-rotation"})

    # Credential-store files are outside SYNC_MAP entirely, so they would vanish
    # without a trace. Report them explicitly: "we saw a secret and chose not to
    # sync it" must be visible, not implied by absence.
    for rel in SENSITIVE_LOCAL_FILES:
        if (home / rel).exists():
            excluded.append({"path": rel, "reason": "credential-store-never-synced"})

    # The tool ships itself so a fresh container can bootstrap from the repo.
    for path in iter_files(tool_dir()):
        if path.name.endswith(".pyc") or "__pycache__" in path.parts:
            continue
        sub = path.relative_to(tool_dir()).as_posix()
        data = _read_bounded(path, f"tool/{sub}", skipped)
        if data is not None:
            files[f"tool/{sub}"] = data

    return files, excluded, skipped


def _read_bounded(path: Path, rel: str, skipped: list[dict]) -> bytes | None:
    try:
        size = path.stat().st_size
    except OSError as exc:
        skipped.append({"path": rel, "reason": f"stat-failed: {exc}"})
        return None
    if size > MAX_FILE_BYTES:
        skipped.append({"path": rel, "reason": f"oversize ({size} bytes > {MAX_FILE_BYTES})"})
        return None
    try:
        return path.read_bytes()
    except OSError as exc:
        skipped.append({"path": rel, "reason": f"read-failed: {exc}"})
        return None


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def gate_secrets(files: dict[str, bytes], strict: bool) -> tuple[list[dict], list[dict]]:
    """Screen every outgoing file. Returns (blocking, warnings)."""
    blocking: list[dict] = []
    warnings: list[dict] = []
    for repo_path, data in sorted(files.items()):
        if b"\x00" in data[:4096]:
            continue  # binary: no reliable text scan, and binaries are scanned by name rules
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        hits, warns = scan_text(text)
        if hits:
            blocking.append({"path": repo_path, "patterns": sorted(set(hits))})
        if warns:
            warnings.append({"path": repo_path, "kinds": sorted(set(warns))})
    if strict and warnings:
        blocking.extend({"path": w["path"], "patterns": [f"strict:{k}" for k in w["kinds"]]}
                        for w in warnings)
    return blocking, warnings


# --------------------------------------------------------------------------
# manifest + remote state
# --------------------------------------------------------------------------

def build_manifest(files: dict[str, bytes], excluded: list[dict], skipped: list[dict],
                   commit: str | None = None) -> dict:
    return {
        "schema": MANIFEST_SCHEMA,
        "tool": "ghstore",
        "tool_version": TOOL_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "host": socket.gethostname(),
        "commit": commit,
        "file_count": len(files),
        "total_bytes": sum(len(v) for v in files.values()),
        "files": {
            path: {"sha256": sha256_hex(data), "size": len(data)}
            for path, data in sorted(files.items())
        },
        "excluded_count": len(excluded),
        "skipped_count": len(skipped),
        "notes": [
            "Secrets (.env, auth.json, tokens, private keys) are never stored here.",
            "Live SQLite state (state.db: sessions, kanban, cron executions) is not "
            "Git-suitable and is deliberately absent.",
        ],
    }


GITIGNORE = """\
# hermes-data is written by its own tool (tool/ghstore.py), not by hand-edited
# git. This ignore file exists so that a manual clone + `git add -A` can never
# commit a credential or runtime churn. Keep it in sync with the tool's
# EXCLUDE_NAME_PATTERNS / EXCLUDE_REL_PREFIXES.

# --- credentials: never ---
.env
.env.*
!.env.example
# Sidecars of credential/state files. A careless `cp auth.json auth.json.bak`
# would otherwise be committed — the .bak suffix is not a deny-listed name.
*.bak
*.bak.*
*.old
*.orig
*.save
*.swp
*~
*.pem
*.key
*.p12
*.pfx
id_rsa*
id_ed25519*
auth.json
credentials*.json
.op.env

# --- live state / databases: not Git-suitable ---
*.db
*.db-wal
*.db-shm
*.sqlite
*.sqlite3
state/manifest.json

# --- runtime churn ---
*.lock
*.pid
*.sock
*.tmp
*.ghfirst-tmp
*.log
**/__pycache__/
*.pyc
.cache/

# --- local-only tool bookkeeping ---
.ghfirst/
"""

GITATTRIBUTES = """\
# Keep every synced artifact byte-exact: line-ending translation or diff
# normalization would silently change sha256 values the manifest verifies.
* -text -diff
state/manifest.json -text
"""


def render_readme(manifest: dict, repo: str) -> bytes:
    lines = [
        "# hermes-data — GitHub-first durable state",
        "",
        "This repository is the **primary, permanent home** of every durable artifact of",
        "the Hermes instance it belongs to. The container filesystem is a rebuildable",
        "cache; a fresh container restores itself from here.",
        "",
        f"- schema: `{manifest['schema']}` · tool `{manifest['tool']} v{manifest['tool_version']}`",
        f"- generated: `{manifest['generated_at']}` · host `{manifest['host']}`",
        f"- files: `{manifest['file_count']}` · bytes: `{manifest['total_bytes']}`",
        "",
        "## Layout",
        "",
        "| path | contents |",
        "| --- | --- |",
        "| `state/` | durable Hermes state: config, memories, skills, plans, hooks, plugins, skins, cron jobs + scripts, workspace |",
        "| `state/manifest.json` | per-file sha256 + size index; the integrity record |",
        "| `tool/` | `ghstore.py` and bootstrap scripts — the restore path itself |",
        "",
        "## Restore into a fresh container",
        "",
        "```sh",
        "export GITHUB_TOKEN=<token with access to this repo>",
        f"git clone https://github.com/{repo}.git /tmp/hermes-data",
        "HERMES_HOME=/data/.hermes python3 /tmp/hermes-data/tool/ghstore.py pull --repo "
        + repo,
        "```",
        "",
        "## Never stored here",
        "",
        "`.env`, `auth.json`, all `*.db` SQLite state (session transcripts, kanban,",
        "cron executions), logs, caches, locks. A push that would leak a credential",
        "aborts instead of committing.",
        "",
    ]
    return "\n".join(lines).encode("utf-8")


def fetch_remote_state(gh: GitHub, branch: str, initialize: bool = False):
    """Return (ref_sha, tree_sha, {path: blob_sha}, parents) or empty-repo marker.

    With ``initialize=True`` an empty repository gets its required first commit so
    the git-data API can be used at all.
    """
    ref = gh.get_ref(branch)
    if not ref and initialize and gh.is_empty():
        seeded = gh.initialize_with_seed(
            branch, "chore: initialize repository for GitHub-first state")
        print(f"  [bootstrap] repository was empty; created first commit {seeded}")
        ref = gh.get_ref(branch)
    if not ref:
        return None, None, {}, []
    commit_sha = ref["object"]["sha"]
    commit = gh.get_commit(commit_sha)
    tree_sha = commit["tree"]["sha"]
    tree = gh.get_tree(tree_sha, recursive=True)
    blobs = {e["path"]: e["sha"] for e in tree.get("tree", [])
             if e["type"] == "blob" and e["path"].startswith(REPO_ROOTS)}
    return commit_sha, tree_sha, blobs, [commit_sha]


def remote_manifest(gh: GitHub, blobs: dict[str, str]) -> dict | None:
    sha = blobs.get("state/manifest.json")
    if not sha:
        return None
    blob = gh.get_blob(sha)
    if blob.get("encoding") != "base64":
        return None
    raw = base64.b64decode(blob["content"])
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def load_cache() -> dict:
    path = cache_file()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_cache(data: dict) -> None:
    path = cache_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------

def cmd_plan(args) -> int:
    home = hermes_home()
    files, excluded, skipped = collect_local(home)
    print(f"HERMES_HOME: {home}")
    print(f"repo:        {args.repo}  branch: {args.branch}")
    print(f"would sync:  {len(files)} files, {sum(len(v) for v in files.values())} bytes")
    for path in sorted(files):
        print(f"  + {path}  ({len(files[path])} B)")
    if excluded:
        reasons: dict[str, int] = {}
        for item in excluded:
            reasons[item["reason"]] = reasons.get(item["reason"], 0) + 1
        print(f"excluded:    {len(excluded)} entries " +
              " ".join(f"[{k}={v}]" for k, v in sorted(reasons.items())))
    for item in skipped:
        print(f"  ! skipped {item['path']}: {item['reason']}")
    return 0


def cmd_doctor(args) -> int:
    home = hermes_home()
    print("== environment ==")
    print(f"HERMES_HOME          : {home} (exists={home.exists()})")
    print(f"cwd                  : {os.getcwd()}")
    print(f"python               : {sys.version.split()[0]}")
    token, source = resolve_token(args.token)
    print(f"credential           : {'FOUND via ' + source if token else 'MISSING'}")
    if not token:
        print("\nBLOCKED: no credential. Nothing can be stored or restored.")
        require_token(args.token)
    gh = GitHub(token, args.repo, args.verbose)
    try:
        user = gh.get_user()
        repo = gh.get_repo()
    except GhError as exc:
        print(f"\nBLOCKED: repository unreachable: {exc}")
        return 2
    print(f"authenticated as     : {user.get('login')}")
    scopes = os.environ.get("GHSTORE_LAST_SCOPES", "")
    if scopes:
        print(f"token scopes         : {scopes}")
    print(f"repo                 : {repo['full_name']} private={repo['private']} "
          f"default_branch={repo['default_branch']}")
    perms = repo.get("permissions", {})
    print(f"permissions          : push={perms.get('push')} admin={perms.get('admin')}")
    if not perms.get("push"):
        print("BLOCKED: token cannot push to this repository.")
        return 2
    ref = gh.get_ref(args.branch)
    print(f"branch {args.branch:<12}: {'absent (first push creates it)' if not ref else ref['object']['sha']}")
    files, excluded, skipped = collect_local(home)
    print(f"local syncable files : {len(files)} ({sum(len(v) for v in files.values())} bytes)")
    print(f"excluded entries     : {len(excluded)}")
    print(f"skipped (oversize/io): {len(skipped)}")
    blocking, warnings = gate_secrets(files, args.strict_scan)
    print(f"secret scan          : blocking={len(blocking)} warnings={len(warnings)}")
    for item in blocking:
        print(f"  BLOCK {item['path']}: {', '.join(item['patterns'])}")
    if args.branch != repo["default_branch"]:
        print(f"note: branch {args.branch!r} is not the default branch "
              f"({repo['default_branch']!r})")
    print(f"api calls made       : {gh.calls}")
    return 0 if not blocking else 3


def cmd_audit(args) -> int:
    """Classify EVERY file under HERMES_HOME as synced / excluded / unclassified.

    The point is the third bucket. A file that is neither in the repo nor covered
    by an explicit rule is a silent gap: it survives on the container disk only,
    and nobody notices until the container is gone. This command fails on those,
    so the gap has to be answered rather than ignored.
    """
    home = hermes_home()
    token = require_token(args.token)
    gh = GitHub(token, args.repo, args.verbose)
    _, _, blobs, _ = fetch_remote_state(gh, args.branch)
    manifest = remote_manifest(gh, blobs)
    in_repo = set((manifest or {}).get("files", {}))
    if not in_repo:
        print("NOTE: repo manifest is empty/unreadable — every file will look "
              "unclassified. Push first.")

    synced: list[tuple[str, str]] = []
    excluded: list[tuple[str, str]] = []
    unclassified: list[str] = []

    for path in iter_files(home):
        rel = path.relative_to(home).as_posix()
        if rel.startswith(".ghfirst/"):
            excluded.append((rel, "sync bookkeeping (local cache, by design)"))
            continue
        if rel.startswith("ghfirst/"):
            repo_path = "tool/" + rel[len("ghfirst/"):]
            if repo_path in in_repo:
                synced.append((rel, repo_path))
            else:
                unclassified.append(rel)
            continue
        repo_path = "state/" + rel
        if repo_path in in_repo:
            synced.append((rel, repo_path))
            continue
        if is_excluded(rel):
            excluded.append((rel, "exclusion rule"))
            continue
        # The collector keeps only the newest N files under cron/output, so an older
        # one is absent from the repo by rule and not a gap. Without this branch the
        # audit reported every rotated-out file as UNCLASSIFIED (measured: 10 false
        # failures) — the collector and the auditor MUST share one predicate or they
        # disagree about the same path.
        if rel.startswith("cron/output/"):
            excluded.append((rel, "cron-output rotation (newest kept)"))
            continue
        top = rel.split("/")[0]
        if top in REBUILDABLE_PREFIXES:
            excluded.append((rel, "runtime/rebuildable"))
            continue
        unclassified.append(rel)

    total = len(synced) + len(excluded) + len(unclassified)
    print(f"HERMES_HOME: {home}")
    print(f"repo:        {args.repo}@{args.branch}  head-manifest files={len(in_repo)}")
    print(f"total local files: {total}")
    print(f"  in repo            : {len(synced)}")
    print(f"  excluded by design : {len(excluded)}")
    print(f"  UNCLASSIFIED       : {len(unclassified)}")
    if unclassified:
        print("\nUNCLASSIFIED files are neither in the repo nor covered by a rule.")
        print("Each is either (a) missing from the sync map and should be pushed,")
        print("or (b) runtime state that needs an explicit rule in the tool:")
        for rel in unclassified[:60]:
            print(f"  ? {rel}")
        if len(unclassified) > 60:
            print(f"  ... and {len(unclassified) - 60} more")
        if args.verbose:
            print("\n--- excluded detail ---")
            for rel, why in excluded:
                print(f"  - {rel}  [{why}]")
        return 9
    print("\nAUDIT OK: every local file is either in GitHub or explicitly excluded.")
    if args.verbose:
        for rel, why in excluded:
            print(f"  - {rel}  [{why}]")
    return 0


def cmd_status(args) -> int:
    home = hermes_home()
    token = require_token(args.token)
    gh = GitHub(token, args.repo, args.verbose)
    files, excluded, skipped = collect_local(home)
    commit_sha, tree_sha, blobs, parents = fetch_remote_state(gh, args.branch)
    if not commit_sha:
        print("repo branch is empty — everything below is local-only.")
        for path in sorted(files):
            print(f"  local-only  {path}")
        return 0
    remote = remote_manifest(gh, blobs)
    cache = load_cache()
    last = cache.get("files", {})

    local_hashes = {path: sha256_hex(data) for path, data in files.items()}
    remote_hashes = {p: e["sha256"] for p, e in (remote or {}).get("files", {}).items()}

    only_local = sorted(set(local_hashes) - set(remote_hashes))
    only_remote = sorted(set(remote_hashes) - set(local_hashes))
    changed = sorted(p for p in set(local_hashes) & set(remote_hashes)
                     if local_hashes[p] != remote_hashes[p])

    conflicts = []
    for path in changed:
        remote_changed = path in last and last[path].get("sha256") != remote_hashes[path]
        if remote_changed:
            conflicts.append(path)

    print(f"branch {args.branch} head: {commit_sha}")
    print(f"remote manifest        : {'present' if remote else 'MISSING'} "
          f"({(remote or {}).get('generated_at', '-')})")
    print(f"local files={len(local_hashes)} remote files={len(remote_hashes)}")
    print(f"local-only={len(only_local)} remote-only={len(only_remote)} differing={len(changed)}")
    for path in only_local[:50]:
        print(f"  + local-only   {path}")
    for path in only_remote[:50]:
        print(f"  - remote-only  {path}")
    for path in changed[:50]:
        tag = "CONFLICT" if path in conflicts else "changed"
        print(f"  ~ {tag:<8} {path}")
    if conflicts:
        print(f"\n{len(conflicts)} conflicting path(s): both sides changed since the last "
              f"sync. A plain push would overwrite remote work; inspect before forcing.")
    if excluded:
        print(f"excluded from sync: {len(excluded)} entries")
    return 0


def cmd_push(args) -> int:
    home = hermes_home()
    token = require_token(args.token)
    gh = GitHub(token, args.repo, args.verbose)
    files, excluded, skipped = collect_local(home)
    blocking, warnings = gate_secrets(files, args.strict_scan)
    # Entropy warnings are advisory, and a busy home produces dozens of them; a
    # wall of notices buried the one line that mattered in the cron alert. Summarise
    # by default and list them in full only when asked.
    if warnings:
        kinds: dict[str, int] = {}
        for warn in warnings:
            for kind in warn["kinds"]:
                kinds[kind] = kinds.get(kind, 0) + 1
        summary = ", ".join(f"{k}={v}" for k, v in sorted(kinds.items()))
        print(f"scan warnings: {len(warnings)} file(s) ({summary})")
        if args.verbose:
            for warn in warnings:
                print(f"  [scan-warning] {warn['path']}: {', '.join(warn['kinds'])}")
        else:
            for warn in warnings[:5]:
                print(f"  [scan-warning] {warn['path']}: {', '.join(warn['kinds'])}")
            if len(warnings) > 5:
                print(f"  ... and {len(warnings) - 5} more (re-run with --verbose)")
    if blocking:
        print("\nABORTED: the secret gate found credential-shaped content. Nothing was pushed.")
        for item in blocking:
            print(f"  BLOCK {item['path']}: {', '.join(item['patterns'])}")
            if not args.strict_scan and any(p.startswith("strict:") for p in item['patterns']):
                print("        (raised only because --strict-scan is on)")
        print("Remove the secret, move it to the credential store "
              f"({home / '.env'}), and re-run.")
        return 4

    commit_sha, tree_sha, remote_blobs, parents = fetch_remote_state(
        gh, args.branch, initialize=True)
    remote = remote_manifest(gh, remote_blobs)
    cache = load_cache()
    last = cache.get("files", {})

    if remote and not args.force:
        remote_hashes = {p: e["sha256"] for p, e in remote.get("files", {}).items()}
        local_hashes = {p: sha256_hex(d) for p, d in files.items()}
        conflicts = [p for p in set(local_hashes) & set(remote_hashes)
                     if local_hashes[p] != remote_hashes[p]
                     and p in last and last[p].get("sha256") != remote_hashes[p]]
        if conflicts:
            print(f"ABORTED: {len(conflicts)} path(s) changed both locally and remotely "
                  f"since the last sync. Re-run with --force only after inspecting:")
            for path in sorted(conflicts)[:40]:
                print(f"  CONFLICT {path}")
            return 5
        fingerprint = hashlib.sha256(
            json.dumps(remote_hashes, sort_keys=True).encode()).hexdigest()
        if fingerprint == cache.get("remote_fingerprint") and \
                local_hashes == {k: v["sha256"] for k, v in last.items()}:
            print("no changes since the last sync — nothing to commit.")
            return 0

    manifest = build_manifest(files, excluded, skipped)
    readme = render_readme(manifest, args.repo)
    outgoing: dict[str, bytes] = dict(files)
    outgoing["README.md"] = readme
    outgoing[".gitignore"] = GITIGNORE.encode()
    outgoing[".gitattributes"] = GITATTRIBUTES.encode()

    # Upload only blobs whose content differs from what the repo already holds.
    reused = 0
    uploaded: list[str] = []
    tree_entries: list[dict] = []
    for path in sorted(outgoing):
        data = outgoing[path]
        want = sha256_hex(data)
        have_sha = remote_blobs.get(path)
        if have_sha and remote and remote.get("files", {}).get(path, {}).get("sha256") == want:
            tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": have_sha})
            reused += 1
            continue
        if path == "README.md" and have_sha and not args.force:
            pass
        blob_sha = gh.create_blob(data)
        tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob_sha})
        uploaded.append(path)

    # Manifest is written last so it never indexes content the commit lacks.
    manifest_bytes = json.dumps(manifest, indent=2, sort_keys=True).encode()
    manifest_sha = gh.create_blob(manifest_bytes)
    tree_entries = [e for e in tree_entries if e["path"] != "state/manifest.json"]
    tree_entries.append({"path": "state/manifest.json", "mode": "100644",
                         "type": "blob", "sha": manifest_sha})

    # Deletions: repo paths we no longer carry.
    #
    # A push is computed from the LOCAL tree, so a half-populated or wrong
    # HERMES_HOME looks exactly like "the user deleted 330 files" and would
    # silently wipe the repository. Deletion is therefore gated: a large or
    # majority-ratio deletion is refused unless explicitly authorized.
    deletions = [path for path in remote_blobs
                 if path not in outgoing and path != "state/manifest.json"]
    if deletions and not args.allow_deletions:
        tracked = len(remote_blobs) or 1
        ratio = len(deletions) / tracked
        if len(deletions) > DELETION_ABS_LIMIT or ratio > DELETION_RATIO_LIMIT:
            print(f"ABORTED: this push would delete {len(deletions)} of {tracked} "
                  f"tracked files ({ratio:.0%}). That usually means the wrong "
                  f"HERMES_HOME or an unmounted volume, not a real deletion.")
            for path in sorted(deletions)[:20]:
                print(f"  - would delete {path}")
            if len(deletions) > 20:
                print(f"  ... and {len(deletions) - 20} more")
            print(f"Verify HERMES_HOME={home} holds the full state, then re-run with "
                  f"--allow-deletions to confirm the removal is intentional.")
            return 6
        print(f"note: deleting {len(deletions)} tracked file(s) "
              f"({ratio:.1%} of {tracked})")
    for path in deletions:
        tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})

    new_tree = gh.create_tree(tree_entries, tree_sha)
    message = args.message or f"sync: {len(outgoing)} files from {socket.gethostname()}"
    commit = gh.create_commit(message, new_tree, parents)
    if commit_sha:
        gh.update_ref(args.branch, commit["sha"], force=args.force)
    else:
        gh.create_ref(args.branch, commit["sha"])
    print(f"committed {commit['sha']}  files={len(outgoing)} uploaded={len(uploaded)} "
          f"reused={reused} deleted={sum(1 for e in tree_entries if e['sha'] is None)}")
    for path in uploaded:
        print(f"  up {path}")

    save_cache({
        "last_commit": commit["sha"],
        "branch": args.branch,
        "repo": args.repo,
        "pushed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "remote_fingerprint": hashlib.sha256(json.dumps(
            {p: e["sha256"] for p, e in manifest["files"].items()},
            sort_keys=True).encode()).hexdigest(),
        "files": {p: {"sha256": e["sha256"], "size": e["size"]}
                  for p, e in manifest["files"].items()},
    })

    if args.no_verify:
        print(f"verification skipped (--no-verify); api calls={gh.calls}")
        return 0
    return _verify_remote(gh, args.branch, manifest, quiet=False)


def _verify_remote(gh: GitHub, branch: str, manifest: dict, quiet: bool = False) -> int:
    commit_sha, tree_sha, blobs, _ = fetch_remote_state(gh, branch)
    if not commit_sha:
        print("VERIFY FAILED: branch has no commit after push")
        return 6
    remote = remote_manifest(gh, blobs)
    mismatches: list[str] = []
    for path, meta in manifest["files"].items():
        if path not in blobs:
            mismatches.append(f"{path}: absent from committed tree")
    checked = 0
    sample = sorted(manifest["files"])
    if len(sample) > 25:
        step = len(sample) / 25.0
        sample = [sample[int(i * step)] for i in range(25)]
    for path in sample:
        blob = gh.get_blob(blobs[path])
        raw = base64.b64decode(blob["content"])
        if sha256_hex(raw) != manifest["files"][path]["sha256"]:
            mismatches.append(f"{path}: content sha256 mismatch after read-back")
        checked += 1
    manifest_ok = remote is not None and remote.get("file_count") == manifest["file_count"]
    if not manifest_ok:
        mismatches.append("state/manifest.json does not match the pushed manifest")
    if mismatches:
        print(f"VERIFY FAILED ({len(mismatches)} problems)")
        for m in mismatches[:20]:
            print(f"  ! {m}")
        return 6
    if not quiet:
        print(f"VERIFY OK: commit={commit_sha} files={len(manifest['files'])} "
              f"read-back={checked} manifest=ok")
        print(f"recovery anchor: {commit_sha}")
    return 0


def cmd_verify(args) -> int:
    token = require_token(args.token)
    gh = GitHub(token, args.repo, args.verbose)
    commit_sha, tree_sha, blobs, _ = fetch_remote_state(gh, args.branch)
    if not commit_sha:
        print("VERIFY FAILED: branch is empty")
        return 6
    remote = remote_manifest(gh, blobs)
    if not remote:
        print("VERIFY FAILED: state/manifest.json missing or unreadable")
        return 6
    problems: list[str] = []
    target = args.commit or commit_sha
    for path, meta in sorted(remote["files"].items()):
        if path not in blobs:
            problems.append(f"{path}: indexed in manifest but absent from tree")
            continue
        if args.full:
            blob = gh.get_blob(blobs[path])
            if sha256_hex(base64.b64decode(blob["content"])) != meta["sha256"]:
                problems.append(f"{path}: sha256 mismatch")
    extra = sorted(set(blobs) - set(remote["files"]) - {"state/manifest.json"})
    for path in extra:
        problems.append(f"{path}: present in tree but not indexed (drift)")
    print(f"verify commit={target} indexed={len(remote['files'])} "
          f"tree_blobs={len(blobs)} deep_readback={'yes' if args.full else 'index-only'}")
    if problems:
        print(f"VERIFY FAILED ({len(problems)} problems)")
        for p in problems[:40]:
            print(f"  ! {p}")
        return 6
    print("VERIFY OK")
    return 0


def cmd_pull(args) -> int:
    home = hermes_home()
    token = require_token(args.token)
    gh = GitHub(token, args.repo, args.verbose)
    commit_sha, tree_sha, blobs, _ = fetch_remote_state(gh, args.branch)
    if not commit_sha:
        print("NOTHING TO RESTORE: the branch has no commits yet.")
        return 7
    remote = remote_manifest(gh, blobs)
    if not remote:
        print("ABORTED: state/manifest.json is missing; refusing a blind restore.")
        return 7
    wanted = args.paths or sorted(remote["files"])

    restored, unchanged, blocked, failed = [], [], [], []
    for repo_path in wanted:
        meta = remote["files"].get(repo_path)
        if not meta:
            failed.append(f"{repo_path}: not in manifest")
            continue
        dest = _dest_for(home, repo_path)
        if dest is None:
            failed.append(f"{repo_path}: no local mapping")
            continue
        if repo_path not in blobs:
            failed.append(f"{repo_path}: blob missing from tree")
            continue
        blob = gh.get_blob(blobs[repo_path])
        raw = base64.b64decode(blob["content"])
        if sha256_hex(raw) != meta["sha256"]:
            failed.append(f"{repo_path}: content corrupted in transit (sha256 mismatch)")
            continue
        if dest.exists():
            current = sha256_hex(dest.read_bytes())
            if current == meta["sha256"]:
                unchanged.append(repo_path)
                continue
            if not args.overwrite:
                blocked.append(repo_path)
                continue
        if args.dry_run:
            restored.append(repo_path + " (dry-run)")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".ghfirst-tmp")
        tmp.write_bytes(raw)
        os.chmod(tmp, 0o600 if _sensitive(repo_path) else 0o644)
        os.replace(tmp, dest)
        restored.append(repo_path)

    print(f"restore source commit: {commit_sha}")
    print(f"restored={len(restored)} already-current={len(unchanged)} "
          f"skipped-local-differs={len(blocked)} failed={len(failed)}")
    for path in restored:
        print(f"  <- {path} -> {_dest_for(home, path)}")
    for path in blocked:
        print(f"  ! local copy differs, not overwritten: {path} (use --overwrite)")
    for item in failed:
        print(f"  ! {item}")
    if blocked or failed:
        return 8
    return 0


def _dest_for(home: Path, repo_path: str) -> Path | None:
    if repo_path.startswith("state/"):
        return home / repo_path[len("state/"):]
    if repo_path.startswith("projects/"):
        return home / repo_path
    if repo_path.startswith("tool/"):
        return tool_dir() / repo_path[len("tool/"):]
    return None


def _sensitive(repo_path: str) -> bool:
    return any(part in repo_path for part in ("config.yaml", "memories/", "cron/"))


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ghstore",
        description="GitHub-first durable storage for Hermes state.")
    # Shared global flags. They are attached to the main parser AND to every
    # subparser so `ghstore --repo R push` and `ghstore push --repo R` both work;
    # SUPPRESS defaults keep a subparser copy from overwriting a value already
    # given before the subcommand.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--repo", default=argparse.SUPPRESS,
                        help=f"target repository (default: {DEFAULT_REPO})")
    common.add_argument("--branch", default=argparse.SUPPRESS,
                        help=f"target branch (default: {DEFAULT_BRANCH})")
    common.add_argument("--token", default=argparse.SUPPRESS,
                        help="Explicit token. Prefer GITHUB_TOKEN in the environment "
                             "or the credential store; passing tokens on a command "
                             "line exposes them in the process list.")
    common.add_argument("--verbose", action="store_true", default=argparse.SUPPRESS)

    parser.add_argument("--repo", default=os.environ.get("GHSTORE_REPO", DEFAULT_REPO))
    parser.add_argument("--branch", default=os.environ.get("GHSTORE_BRANCH", DEFAULT_BRANCH))
    parser.add_argument("--token", default=None)
    parser.add_argument("--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("doctor", parents=[common],
                       help="check credential, repo, permissions, sync scope")
    p.add_argument("--strict-scan", action="store_true")
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("plan", parents=[common],
                       help="show path mapping and scope; no network writes")
    p.set_defaults(func=cmd_plan)

    p = sub.add_parser("status", parents=[common], help="local vs repo drift")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("audit", parents=[common],
                       help="classify EVERY local file: in repo / excluded / "
                            "unclassified (fails on unclassified)")
    p.set_defaults(func=cmd_audit)

    p = sub.add_parser("push", parents=[common],
                       help="commit the whole tree atomically, then verify")
    p.add_argument("--message", default=None)
    p.add_argument("--force", action="store_true",
                   help="overwrite remote changes and skip the conflict gate")
    p.add_argument("--strict-scan", action="store_true",
                   help="treat entropy warnings as blocking")
    p.add_argument("--allow-deletions", action="store_true",
                   help="permit a large deletion (default: refuse, to protect "
                        "against a wrong/mounted-out HERMES_HOME wiping the repo)")
    p.add_argument("--no-verify", action="store_true")
    p.set_defaults(func=cmd_push)

    p = sub.add_parser("verify", parents=[common],
                       help="integrity check the committed tree")
    p.add_argument("--full", action="store_true", help="download and hash every blob")
    p.add_argument("--commit", default=None)
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("pull", parents=[common], help="restore state from the repo")
    p.add_argument("--overwrite", action="store_true",
                   help="replace locally modified files")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("paths", nargs="*", default=[])
    p.set_defaults(func=cmd_pull)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except GhError as exc:
        print(f"FAILED: {exc}")
        return 10
    except KeyboardInterrupt:
        print("interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
