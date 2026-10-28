#!/usr/bin/env python3
"""Dispatch the RIX Android build, wait for it, and pull the APK down.

Usage:
    python3 ci_rix_build.py                      # arm64-v8a (default)
    python3 ci_rix_build.py arm64-v8a,armeabi-v7a,x86_64
    python3 ci_rix_build.py --status             # just report the last runs

Exits non-zero on a failed run, so it is safe to chain.
"""
from __future__ import annotations

import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
import hashlib
import zipfile

REPO = "amirmayeli1211/hermes-data"
WORKFLOW = "android-rix.yml"
OUT_DIR = "/home/user/hermes-offload/downloads"
API = "https://api.github.com"


def token() -> str:
    for path in ("/root/.hermes/.ghfirst/token", "/home/user/.hermes/.ghfirst/token"):
        if os.path.exists(path):
            value = open(path).read().strip()
            if value:
                return value
    for name in ("GHSTORE_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"):
        value = os.environ.get(name)
        if value:
            return value.strip()
    raise SystemExit("no GitHub token found")


TOKEN = token()


def api(url: str, method: str = "GET", payload: dict | None = None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        url, method=method, data=data,
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Accept": "application/vnd.github+json",
            "User-Agent": "rix-ci",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read()
            if not body:
                return response.status, {}
            try:
                return response.status, json.loads(body)
            except json.JSONDecodeError:
                return response.status, {"raw": body.decode("utf-8", "replace")}
    except urllib.error.HTTPError as error:
        return error.code, {"error": error.read().decode("utf-8", "replace")[:500]}


def download(url: str, destination: str) -> None:
    """Follow the redirect by hand.

    GitHub answers artifact downloads with a 302 to a signed blob URL, and the
    blob host rejects a request that still carries the Authorization header, so
    the token must be dropped on the second hop.
    """
    request = urllib.request.Request(
        url, headers={"Authorization": "Bearer " + TOKEN,
                      "User-Agent": "rix-ci",
                      "Accept": "application/vnd.github+json"})
    opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler())

    class NoAuthOnRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            new = super().redirect_request(req, fp, code, msg, headers, newurl)
            if new is not None:
                new.remove_header("Authorization")
            return new

    opener = urllib.request.build_opener(NoAuthOnRedirect())
    with opener.open(request, timeout=180) as response, open(destination, "wb") as handle:
        while chunk := response.read(1 << 20):
            handle.write(chunk)


def latest_run() -> dict | None:
    status, data = api(f"{API}/repos/{REPO}/actions/workflows/{WORKFLOW}/runs?per_page=1")
    if status != 200:
        print("cannot list runs:", status, data)
        return None
    runs = data.get("workflow_runs", [])
    return runs[0] if runs else None


def show_status() -> None:
    status, data = api(f"{API}/repos/{REPO}/actions/workflows/{WORKFLOW}/runs?per_page=5")
    if status != 200:
        print("cannot list runs:", status, data)
        return
    for run in data.get("workflow_runs", []):
        print(f"{run['id']} {run['status']}/{run['conclusion']} "
              f"sha={run['head_sha'][:10]} {run['created_at']}")


def main() -> int:
    if "--status" in sys.argv:
        show_status()
        return 0

    abis = "arm64-v8a"
    for arg in sys.argv[1:]:
        if not arg.startswith("-"):
            abis = arg

    print(f"dispatching {WORKFLOW} with abis={abis}")
    status, data = api(
        f"{API}/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches",
        "POST", {"ref": "main", "inputs": {"abis": abis}},
    )
    if status not in (201, 204):
        print("dispatch failed:", status, data)
        return 1

    # Give GitHub a moment to register the run, then find it.
    run = None
    for _ in range(20):
        time.sleep(4)
        candidate = latest_run()
        if candidate and candidate["status"] != "completed":
            run = candidate
            break
    if run is None:
        run = latest_run()
    if run is None:
        print("no run appeared")
        return 1

    run_id = run["id"]
    print(f"run {run_id} -> {run['html_url']}")

    started = time.time()
    while True:
        time.sleep(20)
        status, data = api(f"{API}/repos/{REPO}/actions/runs/{run_id}")
        if status != 200:
            print("poll failed:", status, data)
            return 1
        state = data.get("status")
        conclusion = data.get("conclusion")
        print(f"  [{int(time.time() - started):>4}s] {state}/{conclusion}")
        if state == "completed":
            break
        if time.time() - started > 3 * 3600:
            print("timed out waiting")
            return 1

    if conclusion != "success":
        print(f"run failed: {conclusion}")
        print(f"logs: https://github.com/{REPO}/actions/runs/{run_id}")
        status, jobs = api(f"{API}/repos/{REPO}/actions/runs/{run_id}/jobs")
        for job in jobs.get("jobs", []):
            print(f"  job {job['name']}: {job['conclusion']}")
            for step in job.get("steps", []):
                if step.get("conclusion") not in ("success", "skipped", None):
                    print(f"    FAILED STEP: {step['name']} ({step['conclusion']})")
        return 1

    status, data = api(f"{API}/repos/{REPO}/actions/runs/{run_id}/artifacts")
    artifact = next((a for a in data.get("artifacts", []) if a["name"] == "rix-apk"), None)
    if artifact is None:
        print("no rix-apk artifact; artifacts were:",
              [a["name"] for a in data.get("artifacts", [])])
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    archive = os.path.join(OUT_DIR, "rix-apk.zip")
    download(artifact["archive_download_url"], archive)
    print(f"downloaded {os.path.getsize(archive)} bytes -> {archive}")

    with zipfile.ZipFile(archive) as bundle:
        names = [n for n in bundle.namelist() if n.endswith(".apk")]
        if not names:
            print("zip holds no apk:", bundle.namelist())
            return 1
        target = os.path.join(OUT_DIR, "RIX.apk")
        with bundle.open(names[0]) as source, open(target, "wb") as handle:
            while chunk := source.read(1 << 20):
                handle.write(chunk)
    os.remove(archive)

    digest = hashlib.sha256(open(target, "rb").read()).hexdigest()
    print(f"APK: {target}")
    print(f"SIZE: {os.path.getsize(target)} bytes")
    print(f"SHA256: {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())