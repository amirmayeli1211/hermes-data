#!/usr/bin/env python3
"""ci_android_build.py — build NetCheck in the cloud and fetch the APK.

One command for the whole loop, because the Hermes host cannot run an Android
build itself:

    python3 ~/.hermes/scripts/ci_android_build.py            # dispatch + wait + fetch
    python3 ~/.hermes/scripts/ci_android_build.py --status   # latest run only

Writes the APK to $HERMES_OFFLOAD_ROOT/downloads (the real disk, never tmpfs)
and prints its path and sha256, which is what makes it safe to install.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
import zipfile

REPO = os.environ.get("GHSTORE_REPO", "amirmayeli1211/hermes-data")
WORKFLOW = "android.yml"
HERMES_HOME = pathlib.Path(os.environ.get("HERMES_HOME", "/home/user/.hermes"))
OUT_DIR = pathlib.Path(os.environ.get("HERMES_OFFLOAD_ROOT", "/home/user/hermes-offload")) / "downloads"
STEP_TIMEOUT_S = 60 * 25
POLL_EVERY_S = 20


def token() -> str:
    for name in ("GHSTORE_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"):
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()
    sidecar = HERMES_HOME / ".ghfirst" / "token"
    if sidecar.exists():
        value = sidecar.read_text(encoding="utf-8", errors="replace").strip()
        if value:
            return value
    raise SystemExit("no GitHub credential found (see ghstore resolve_token)")


def api(path: str, method: str = "GET", payload: dict | None = None, raw: bool = False):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"https://api.github.com{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {token()}", "Accept": "application/vnd.github+json",
                 "User-Agent": "netcheck-ci", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            body = resp.read()
            return body if raw else json.loads(body or b"null")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise SystemExit(f"GitHub API {method} {path} -> HTTP {exc.code}: {detail}")


def latest_run(branch: str | None = None) -> dict | None:
    query = f"/repos/{REPO}/actions/workflows/{WORKFLOW}/runs?per_page=1"
    if branch:
        query += f"&branch={branch}"
    runs = api(query).get("workflow_runs", [])
    return runs[0] if runs else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--branch", default="main")
    ap.add_argument("--status", action="store_true", help="only report the latest run")
    ap.add_argument("--no-wait", action="store_true", help="dispatch and exit immediately")
    args = ap.parse_args()

    if args.status:
        run = latest_run(args.branch)
        if not run:
            print("no runs yet")
            return 0
        print(f"run {run['id']} {run['status']}/{run['conclusion']} {run['head_sha'][:8]} {run['html_url']}")
        return 0

    api(f"/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches", "POST", {"ref": args.branch})
    print(f"dispatched {WORKFLOW} on {args.branch}")
    if args.no_wait:
        return 0

    started = time.time()
    run = None
    while time.time() - started < STEP_TIMEOUT_S:
        run = latest_run(args.branch)
        if run and run["status"] in ("queued", "in_progress"):
            print(f"  {run['status']}… ({int(time.time() - started)}s)")
        elif run and run["status"] == "completed":
            break
        time.sleep(POLL_EVERY_S)

    if not run or run["status"] != "completed":
        print("timed out waiting for the run; check the Actions page")
        return 1

    print(f"run {run['id']} {run['conclusion']} in {int(time.time() - started)}s: {run['html_url']}")
    if run["conclusion"] != "success":
        jobs = api(f"/repos/{REPO}/actions/runs/{run['id']}/jobs")
        for job in jobs.get("jobs", []):
            print(f"job {job['name']}: {job['conclusion']}")
            for step in job.get("steps", []):
                if step["conclusion"] not in ("success", "skipped"):
                    print(f"   FAILED step: {step['name']}")
        logs = api(f"/repos/{REPO}/actions/runs/{run['id']}/logs", raw=True)
        with zipfile.ZipFile(io.BytesIO(logs)) as zf:
            for name in zf.namelist():
                text = zf.read(name).decode("utf-8", "replace")
                keep = [ln for ln in text.splitlines()
                        if "OutOfMemory" in ln or "error:" in ln or "FAILED" in ln or "What went wrong" in ln]
                if keep:
                    print(f"--- {name} ---")
                    for line in keep[-15:]:
                        print("   ", line[:200])
        return 1

    artifacts = api(f"/repos/{REPO}/actions/runs/{run['id']}/artifacts").get("artifacts", [])
    apk_art = next((a for a in artifacts if a["name"] == "netcheck-debug-apk"), None)
    if not apk_art:
        print("run succeeded but the APK artifact is missing")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    blob = api(f"/repos/{REPO}/actions/artifacts/{apk_art['id']}/zip", raw=True)
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        for member in zf.namelist():
            if member.endswith(".apk"):
                target = OUT_DIR / pathlib.Path(member).name
                target.write_bytes(zf.read(member))
                digest = hashlib.sha256(target.read_bytes()).hexdigest()
                print(f"APK: {target}")
                print(f"sha256: {digest}")
                print(f"size: {target.stat().st_size} bytes")
                return 0
    print("no .apk inside the artifact zip")
    return 1


if __name__ == "__main__":
    sys.exit(main())
