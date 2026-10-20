#!/usr/bin/env python3
"""ghstore test suite — real execution, no mocks of the network layer.

Covers: secret gate true/false positives, exclusion rules, secret resolution,
manifest integrity, and (when GITHUB_TOKEN is present) the live API path.
Run: python3 tests/test_ghstore.py
"""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent / "ghstore.py"
spec = importlib.util.spec_from_file_location("ghstore", TOOL)
ghstore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ghstore)

PASS, FAIL = [], []


def check(name: str, condition: bool, detail: str = "") -> None:
    (PASS if condition else FAIL).append(name)
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {name}" + (f" — {detail}" if detail and not condition else ""))


# --- secret gate: must block -----------------------------------------------

def test_true_positives() -> None:
    print("\nsecret gate — must block:")
    # Every fixture is assembled from fragments at runtime. Written literally, this
    # file trips its own gate (verified) and would also trip GitHub's push
    # protection — a test suite must not look like a leaked credential store.
    fake = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
    pk_header = "-----BEGIN RSA " + "PRIVATE KEY-----"
    db_scheme = "postgres" + "://"
    cases = {
        "github token in yaml": f"github_token: {fake}",
        "openai key": "OPENAI_API_KEY=sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
        "anthropic key": "key: sk-ant-" + "api03-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
        "aws access key": "aws_access_key_id = AKIA" + "IOSFODNN7EXAMPLE",
        "private key block": pk_header + "\nMIIEowIBAAKCAQEA\n",
        "slack token": "xoxb-" + "123456789012-abcdefghijklmnopqrstuvwx",
        "db uri with password": db_scheme + "admin:s3cr3tpassword@db.internal:5432/app",
        "assigned api key": 'api_key = "' + "9f8e7d6c5b4a39281706f5e4d3c2b1a0" + '"',
        "assigned password": 'password: "' + "hunter2hunter2hunter2" + '"',
        "telegram bot token": "bot " + "7654321098:AAG" + "b" * 32,
        "google api key": "AIza" + "SyD8xYz1234567890abcdefghijklmnop",
        "npm token": "npm_" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8",
        # OAuth access/refresh tokens are JWTs; they match no prefix pattern.
        "jwt oauth token": "access_token: " + (
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ."
            "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
        "jwt inside json": '{"connectors_token": {"access_token": "' + (
            "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyJleHAiOjE3OTIyNjczNzEsImlhdCI6MTc5MjE4MDk3MX0."
            "abc123DEF456ghi789JKL012mno345PQR678stu") + '"}}',
    }
    for label, text in cases.items():
        hits, _ = ghstore.scan_text(text)
        check(f"blocks {label}", bool(hits), f"no pattern matched: {text[:40]!r}")


# --- secret gate: must NOT block (regressions that broke real pushes) -------

def test_false_positives() -> None:
    print("\nsecret gate — must not block:")
    cases = {
        "hyphenated filename with sk-": (
            "| `references/delegate-task-concurrency-diagnosis.md` |\n"
            '- **"delegate_task is capped at N" reports** — see '
            "`references/delegate-task-concurrency-diagnosis.md`.\n"),
        "doc placeholder ghp_xx": 'GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_xx...xxxx"',
        "doc placeholder bearer sk": 'Authorization: "Bearer sk-xxx...xxxx"',
        "python identifiers around client_secret": (
            'def store_client_secret(path: str):\n'
            '    """Copy and validate client_secret.json to Hermes home."""\n'
            "    payload = load(path)\n"
            "    token_payload = normalize(payload)\n"),
        "config key without a value": "api_key:\n    enabled: true\n",
        "lowercase salt": 'salt = "abcdefghijklmnopqrstuvwxyz012345"',
        "skill frontmatter": "name: hermes-agent\ndescription: Use, configure, theme.\n",
    }
    for label, text in cases.items():
        hits, _ = ghstore.scan_text(text)
        check(f"allows {label}", not hits, f"false positive: {hits}")


# --- exclusion rules -------------------------------------------------------

def test_exclusions() -> None:
    print("\nexclusion rules:")
    must_exclude = [
        ".env", ".env.local", "auth.json",
        "state.db", "kanban.db-wal", "cron/executions.db",
        "sessions/sessions.json", "logs/agent.log", "runtime/active_sessions.json",
        "gateway.lock", "gateway.pid", "gateway.sock",
        "models_dev_cache.json", "provider_models_cache.json",
        "cron/.tick.lock", "cache/foo.json", "backups/x.zip",
        ".skills_prompt_snapshot.json", "skills/.usage.json.lock",
        "telegram_update_receipts_123.json", "state/gateway.heartbeat",
        # Found by `audit` on a live home: OAuth JWTs and portal identity.
        "shared/nous_auth.json", "shared/nous_auth.lock",
        "install_id", ".initialized", "channel_directory.json",
        "processes.json", "models_dev_cache.etag",
        # lsp/ is 38 MB of npm-installed language servers: rebuildable, and it
        # lives on the ephemeral disk via a symlink (offload-boot.sh).
        "lsp/node_modules/pyright/dist/pyright-internal.js",
    ]
    must_keep = [
        "config.yaml", "SOUL.md", "memories/notes.md",
        "skills/apple/apple-notes/SKILL.md",
        "cron/jobs.json", "cron/output/run-1.md",
        "workspace/main.py", "plans/roadmap.md",
        "projects/ticket-bot/db.py",
    ]
    for rel in must_exclude:
        check(f"excludes {rel}", ghstore.is_excluded(rel))
    for rel in must_keep:
        check(f"keeps {rel}", not ghstore.is_excluded(rel))
    # `audit` must map a path through SYNC_MAP, not assume `state/`. The hard-coded
    # prefix made every projects/ file look UNCLASSIFIED (6 false failures) while
    # the push was placing it correctly.
    check("maps config.yaml", ghstore.repo_path_for("config.yaml") == "state/config.yaml")
    check("maps memories", ghstore.repo_path_for("memories/USER.md") == "state/memories/USER.md")
    check("maps projects to their own root",
          ghstore.repo_path_for("projects/ticket-bot/db.py") == "projects/ticket-bot/db.py")
    check("unmapped path returns None", ghstore.repo_path_for("lsp/package.json") is None)


# --- collection + manifest -------------------------------------------------

def test_collection_and_manifest() -> None:
    print("\ncollection and manifest integrity:")
    with tempfile.TemporaryDirectory() as td:
        home = Path(td)
        (home / "memories").mkdir()
        (home / "memories" / "notes.md").write_text("remember: ship it\n")
        (home / ".env").write_text("TOKEN=should-never-sync\n")
        (home / "state.db").write_bytes(b"SQLite format 3\x00binary")
        (home / "config.yaml").write_text("model: gpt-4\n")
        files, excluded, skipped = ghstore.collect_local(home)
        paths = set(files)
        check("collects memories markdown", "state/memories/notes.md" in paths)
        check("collects config", "state/config.yaml" in paths)
        check("self-installs tool copy", any(p.startswith("tool/") for p in paths))
        check("never collects .env", not any(".env" in p for p in paths))
        check("never collects sqlite", not any(p.endswith(".db") for p in paths))
        check("reports exclusions", any(".env" in e["path"] for e in excluded))

    files = {"state/a.txt": b"alpha", "state/b/c.bin": b"\x00\x01\x02"}
    manifest = ghstore.build_manifest(files, [], [])
    check("manifest file_count", manifest["file_count"] == 2)
    check("manifest sha256 matches",
          manifest["files"]["state/a.txt"]["sha256"] == ghstore.sha256_hex(b"alpha"))
    check("manifest byte total", manifest["total_bytes"] == 8)
    check("manifest is json-serializable", isinstance(json.dumps(manifest), str))


# --- credential resolution -------------------------------------------------

def test_credential_resolution() -> None:
    print("\ncredential resolution:")
    saved = {k: os.environ.pop(k, None) for k in ("GHSTORE_TOKEN", "GITHUB_TOKEN", "GH_TOKEN")}
    saved_home = os.environ.get("HERMES_HOME")
    try:
        with tempfile.TemporaryDirectory() as td:
            os.environ["HERMES_HOME"] = td
            token, source = ghstore.resolve_token()
            check("reports missing token instead of inventing one",
                  token is None and source == "missing")
            (Path(td) / ".env").write_text("OPENROUTER_API_KEY=zzz\nGITHUB_TOKEN=from-file\n")
            token, source = ghstore.resolve_token()
            check("reads token from credential store", token == "from-file",
                  f"got {token!r}")
            os.environ["GITHUB_TOKEN"] = "from-env"
            token, source = ghstore.resolve_token()
            check("environment wins over file", token == "from-env", f"got {token!r}")
            # The sidecar exists because the container entrypoint REWRITES .env on
            # every boot, dropping a hand-appended GITHUB_TOKEN. It must outrank .env
            # or a restarted container silently loses its credential.
            os.environ.pop("GITHUB_TOKEN", None)
            sidecar = Path(td) / ".ghfirst" / "token"
            sidecar.parent.mkdir(parents=True, exist_ok=True)
            sidecar.write_text("from-sidecar\n")
            token, source = ghstore.resolve_token()
            check("sidecar outranks .env (survives an entrypoint rewrite)",
                  token == "from-sidecar", f"got {token!r}")
            os.environ["GITHUB_TOKEN"] = "from-env"
            token, source = ghstore.resolve_token()
            check("environment still wins over sidecar", token == "from-env", f"got {token!r}")
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        if saved_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = saved_home


# --- tree construction (offline, fake client) ------------------------------

class _FakeTreeGh:
    """Records tree calls; can fail the first N with a chosen 422 wording."""

    def __init__(self, fail_first: int = 0, body: str = "", max_entries: int = 10_000):
        self.calls: list[int] = []
        self.ok: list[int] = []          # payload sizes that SUCCEEDED
        self.fail_first = fail_first
        self.body = body
        self.max_entries = max_entries

    def create_tree(self, entries, base_tree):
        self.calls.append(len(entries))
        if len(self.calls) <= self.fail_first:
            raise ghstore.GhError("HTTP 422", 422, self.body)
        if len(entries) > self.max_entries:
            # Mirrors the real API: an oversized body is refused, not truncated.
            raise ghstore.GhError("HTTP 422", 422,
                                  '{"message":"Sorry, your input was too large to process."}')
        self.ok.append(len(entries))
        return f"tree-{len(self.calls)}-{len(entries)}"


def test_incremental_tree() -> None:
    print("\ntree construction (the live 422 failure):")
    entries = [{"path": f"state/f{i}.txt", "mode": "100644", "type": "blob", "sha": "a" * 40}
               for i in range(250)]
    fake = _FakeTreeGh(max_entries=120)
    first = ghstore.build_tree_incrementally(fake, entries, "base")
    check("chunks a 250-entry tree into bounded calls",
          all(n <= ghstore.TREE_CHUNK for n in fake.calls) and first.startswith("tree-"),
          f"calls={fake.calls}")
    check("covers every entry exactly once", sum(fake.ok) == len(entries), f"ok={fake.ok}")
    check("chunk count matches the chunk size",
          len(fake.ok) == -(-len(entries) // ghstore.TREE_CHUNK), f"ok={fake.ok}")

    # A transient "timed out" 422 must be RETRIED, not split: splitting a tiny tree
    # on a server-side timeout would have doubled the API calls for nothing.
    retry_fake = _FakeTreeGh(fail_first=1,
                             body='{"message":"Sorry, your request timed out."}')
    ghstore.build_tree_incrementally(retry_fake, entries[:20], "base")
    check("retries a server-side timeout instead of splitting", len(retry_fake.calls) == 2,
          f"calls={retry_fake.calls}")

    # A genuine oversize 422 that survives chunking must bisect, not abort.
    split_fake = _FakeTreeGh(max_entries=40)
    ghstore.build_tree_incrementally(split_fake, entries[:100], "base")
    check("bisects when a chunk is still too large", sum(split_fake.ok) == 100,
          f"ok={split_fake.ok}")

    empty = _FakeTreeGh()
    ghstore.build_tree_incrementally(empty, [], "base")
    check("empty change set still posts one (empty) tree", empty.calls == [0], f"calls={empty.calls}")


# --- live API (only with a real token) ------------------------------------

def test_live_api() -> None:
    token, source = ghstore.resolve_token()
    if not token:
        print("\nlive API: SKIPPED (no credential in this environment)")
        return
    print(f"\nlive API (credential via {source}):")
    gh = ghstore.GitHub(token, ghstore.DEFAULT_REPO)
    user = gh.get_user()
    check("authenticates", bool(user.get("login")), str(user)[:120])
    repo = gh.get_repo()
    check("repo reachable", repo.get("full_name") == ghstore.DEFAULT_REPO)
    check("repo is private", repo.get("private") is True)
    check("push permission present", bool(repo.get("permissions", {}).get("push")))
    ref = gh.get_ref("main")
    if ref:
        commit_sha, tree_sha, blobs, parents = ghstore.fetch_remote_state(gh, "main")
        check("head commit resolves", bool(commit_sha))
        manifest = ghstore.remote_manifest(gh, blobs)
        check("manifest readable from repo", manifest is not None)
        if manifest:
            check("manifest file_count positive", manifest["file_count"] > 0)
            first = sorted(manifest["files"])[0]
            blob = gh.get_blob(blobs[first])
            raw = base64.b64decode(blob["content"])
            check("blob content hashes as manifest claims",
                  ghstore.sha256_hex(raw) == manifest["files"][first]["sha256"],
                  first)
        else:
            check("manifest file_count positive", False, "manifest unreadable")
            check("blob content hashes as manifest claims", False, "manifest unreadable")
    else:
        check("head commit resolves", False, "branch main has no commit yet")
        check("manifest readable from repo", False, "no commit")
        check("manifest file_count positive", False, "no commit")
        check("blob content hashes as manifest claims", False, "no commit")


def main() -> int:
    print(f"ghstore {ghstore.TOOL_VERSION} — {TOOL}")
    test_true_positives()
    test_false_positives()
    test_exclusions()
    test_collection_and_manifest()
    test_credential_resolution()
    test_incremental_tree()
    test_live_api()
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        for name in FAIL:
            print(f"  FAILED: {name}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
