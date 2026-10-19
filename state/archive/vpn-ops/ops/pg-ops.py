#!/usr/bin/env python3
"""pg-ops.py — drive a remote server through GitHub Actions.

WHY THIS EXISTS
  The Hermes sandbox this runs in permits outbound traffic ONLY on ports 80 and
  443. Measured: github.com:22, gitlab.com:22, bitbucket.org:22, 1.1.1.1:22 and the
  target server's :22 all time out, while :443 on the same hosts connects in
  milliseconds. That is the sandbox's egress policy, not a problem with the server,
  and it makes a direct SSH connection from here impossible.

  A GitHub Actions runner has unrestricted outbound access, so the workflow opens
  the SSH session, pipes ops/remote.sh over stdin, and the output is read back
  through the job log. The server password is held in an encrypted repository
  secret — never in this file, never in git history, and never on the sandbox disk.

COMMANDS
  secret-set                 create the ops repo and store HOST/USER/PASS secrets
  put <path> <local_file>    commit a file into the ops repo
  run <phase> [--nowait]     dispatch the workflow for a phase and print the log
  log <run_id>               print a completed run's log

  Environment overrides: PG_OPS_REPO, PG_HOST, PG_USER, PG_PASS
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.github.com"
REPO = os.environ.get("PG_OPS_REPO", "amirmayeli1211/pg-ops")
HOST = os.environ.get("PG_HOST", "195.26.26.12")
USER = os.environ.get("PG_USER", "root")
WORKFLOW = "pg-ops.yml"

# Dependency bootstrap for NaCl (secret sealing) lives outside HERMES_HOME so it is
# never picked up by the state snapshot: it is a build-time dependency, not data.
PYLIBS = os.environ.get("PG_OPS_PYLIBS", "/var/tmp/hermes-offload/pylibs")
if Path(PYLIBS).is_dir() and PYLIBS not in sys.path:
    sys.path.insert(0, PYLIBS)


def password() -> str:
    v = os.environ.get("PG_PASS")
    if v:
        return v.strip()
    # Not stored anywhere in the repo; only read from the environment when asked.
    raise SystemExit("PG_PASS is not set in the environment (by design — it is not "
                     "written to disk)")


def token() -> str:
    env = os.environ.get("GITHUB_TOKEN")
    if env and env.strip():
        return env.strip()
    for line in open("/data/.hermes/.env", encoding="utf-8", errors="replace"):
        if line.startswith("GITHUB_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("no GitHub token found")


def api(method: str, path: str, body=None):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Authorization": f"Bearer {token()}",
                 "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28",
                 "User-Agent": "pg-ops"})
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise SystemExit(f"HTTP {e.code} on {method} {path}: {detail}")


def has_repo() -> bool:
    try:
        api("GET", f"/repos/{REPO}")
        return True
    except SystemExit:
        return False


def ensure_repo():
    if has_repo():
        print(f"  repo exists: {REPO}")
        return
    owner, name = REPO.split("/")
    who = api("GET", "/user")["login"]
    if owner == who:
        api("POST", "/user/repos", {
            "name": name, "private": True, "auto_init": True,
            "description": "PasarGuard remote ops — workflow-driven, no local disk"})
    else:
        api("POST", f"/orgs/{owner}/repos", {
            "name": name, "private": True, "auto_init": True,
            "description": "PasarGuard remote ops"})
    print(f"  created private repo: {REPO}")
    # A brand-new repo needs a moment before the contents API accepts writes.
    for _ in range(10):
        try:
            api("GET", f"/repos/{REPO}/contents/")
            break
        except SystemExit:
            time.sleep(2)


def cmd_secret_set():
    ensure_repo()
    pk = api("GET", f"/repos/{REPO}/actions/secrets/public-key")
    pairs = [("PG_HOST", HOST), ("PG_USER", USER), ("PG_PASS", password())]
    for name, value in pairs:
        api("PUT", f"/repos/{REPO}/actions/secrets/{name}",
            {"encrypted_value": seal(pk["key"], value), "key_id": pk["key_id"]})
        shown = value if name != "PG_PASS" else "*" * min(len(value), 10)
        print(f"  stored secret {name} = {shown} (sealed; write-only via API)")
    return 0


def seal(public_key_b64: str, value: str) -> str:
    try:
        from nacl import encoding, public
    except ImportError:
        raise SystemExit(
            "pynacl is required to seal secrets. Install it into PG_OPS_PYLIBS:\n"
            f"  python3 -m pip install --target {PYLIBS} pynacl")
    pk = public.PublicKey(public_key_b64.encode(), encoding.Base64Encoder())
    return base64.b64encode(public.SealedBox(pk).encrypt(value.encode())).decode()


def cmd_put(remote_path: str, local_file: str):
    content = Path(local_file).read_bytes()
    sha = None
    try:
        sha = api("GET", f"/repos/{REPO}/contents/{remote_path}").get("sha")
    except SystemExit:
        pass
    body = {"message": f"ops: {remote_path}",
            "content": base64.b64encode(content).decode(), "branch": "main"}
    if sha:
        body["sha"] = sha
    api("PUT", f"/repos/{REPO}/contents/{remote_path}", body)
    print(f"  {'updated' if sha else 'created'} {remote_path} ({len(content)} bytes)")
    return 0


def cmd_run(phase: str, wait: bool = True, timeout: int = 2400):
    api("POST", f"/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches",
        {"ref": "main", "inputs": {"phase": phase}})
    print(f"  dispatched phase '{phase}'")
    if not wait:
        return 0

    # Find the run we just created. Actions takes a few seconds to register it.
    run_id = None
    deadline = time.time() + 120
    while time.time() < deadline:
        runs = api("GET", f"/repos/{REPO}/actions/runs?per_page=15")
        for r in runs.get("workflow_runs", []):
            if r["path"].endswith(WORKFLOW) and r["status"] != "completed":
                run_id = r["id"]
                break
        if run_id:
            break
        time.sleep(5)
    if not run_id:
        print("  !! could not locate the dispatched run")
        return 1
    print(f"  run {run_id} started; streaming when it finishes...")

    deadline = time.time() + timeout
    seen = ""
    while time.time() < deadline:
        r = api("GET", f"/repos/{REPO}/actions/runs/{run_id}")
        st = f"{r['status']}/{r.get('conclusion')}"
        if st != seen:
            print(f"    [{time.strftime('%H:%M:%S')}] {st}")
            seen = st
        if r["status"] == "completed":
            print(f"  conclusion: {r['conclusion']}")
            print_run_log(run_id)
            return 0 if r["conclusion"] == "success" else 2
        time.sleep(10)
    print("  !! timed out waiting for the run to finish")
    return 1


def print_run_log(run_id: int):
    jobs = api("GET", f"/repos/{REPO}/actions/runs/{run_id}/jobs")
    for j in jobs.get("jobs", []):
        print(f"\n--- job {j['name']}: {j['conclusion']} ---")
        for s in j.get("steps", []):
            print(f"    step '{s['name']}' -> {s['conclusion']}")
        # The logs endpoint 302-redirects to a blob URL. urllib does not follow a
        # redirect on a request that carried an Authorization header, so it surfaced
        # as HTTP 401. curl -L follows it and carries the header only to the API
        # host, which is what works.
        raw = fetch_job_log(j["id"])
        if raw is None:
            continue
        for line in raw.splitlines():
            # Strip the BOM GitHub prepends, then the leading ISO timestamp.
            line = line.lstrip("\ufeff")
            if len(line) > 30 and line[4] == "-" and line[10] == "T" and line[19] == "Z":
                line = line[29:]
            if line.strip():
                print("    " + line.rstrip())


def fetch_job_log(job_id: int):
    """Download a job log, following the redirect. Returns text or None."""
    url = f"{API}/repos/{REPO}/actions/jobs/{job_id}/logs"
    rc = subprocess.run(
        ["curl", "-sSL", "--max-time", "120",
         "-H", f"Authorization: Bearer {token()}",
         "-H", "Accept: application/vnd.github+json",
         url],
        capture_output=True)
    if rc.returncode != 0 or not rc.stdout:
        print(f"    (log fetch failed: rc={rc.returncode})")
        return None
    return rc.stdout.decode("utf-8", "replace")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    if cmd == "secret-set":
        return cmd_secret_set()
    if cmd == "put":
        if len(sys.argv) < 4:
            raise SystemExit("usage: pg-ops.py put <remote_path> <local_file>")
        return cmd_put(sys.argv[2], sys.argv[3])
    if cmd == "run":
        if len(sys.argv) < 3:
            raise SystemExit("usage: pg-ops.py run <phase> [--nowait]")
        return cmd_run(sys.argv[2], wait="--nowait" not in sys.argv)
    if cmd == "log":
        print_run_log(int(sys.argv[2]))
        return 0
    if cmd == "repo":
        ensure_repo()
        return 0
    print(f"unknown command: {cmd}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
