#!/usr/bin/env python3
"""ghstore_safety_branch.py — point a second ref at this instance's newest commit.

WHY
    The hermes-data repository is shared: a second Hermes instance (host
    ddab4be9dacf) pushes to `main` on its own ~31-minute schedule. Whichever
    instance pushes last owns the branch tip, so this instance's tree can
    disappear from `main` without anything being broken or deleted locally.

    This helper keeps an independent ref — `sandbox-b1e0eab0` by default —
    pointing at the newest commit whose message names this host. It only ever
    moves that ref forward to a commit this instance produced, so the other
    instance's pushes cannot pull it somewhere else. One API call, no blobs
    re-uploaded: the commit already exists, only the pointer moves.

Silence is the contract: it prints nothing on the normal path, and never fails
a caller (the sync script treats it as best-effort protection).

Usage:
    ghstore_safety_branch.py [--repo owner/name] [--branch main]
                             [--safety-branch sandbox-b1e0eab0]
                             [--host-marker sandbox-b1e0eab0] [--verbose]
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"
HERMES_HOME = pathlib.Path(os.environ.get("HERMES_HOME", "/home/user/.hermes"))


def resolve_token() -> str | None:
    for name in ("GHSTORE_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"):
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()
    for candidate in (HERMES_HOME / ".ghfirst" / "token", HERMES_HOME / ".env"):
        try:
            text = candidate.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                if key.strip() in ("GITHUB_TOKEN", "GHSTORE_TOKEN", "GH_TOKEN"):
                    value = value.strip().strip('"').strip("'")
                    if value:
                        return value
            elif candidate.name == "token":
                return line
    return None


def call(method: str, path: str, token: str, payload: dict | None = None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"{API}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "User-Agent": "ghstore-safety-branch", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body or "null")
        except json.JSONDecodeError:
            return exc.code, {"message": body[:200]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=os.environ.get("GHSTORE_REPO", "amirmayeli1211/hermes-data"))
    ap.add_argument("--branch", default="main")
    ap.add_argument("--safety-branch", default="sandbox-b1e0eab0")
    ap.add_argument("--host-marker", default="sandbox-b1e0eab0")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    token = resolve_token()
    if not token:
        return 0  # nothing to do, and not worth failing a sync over

    status, head = call("GET", f"/repos/{args.repo}/commits/{args.branch}", token)
    if status != 200 or not isinstance(head, dict):
        if args.verbose:
            print(f"safety-branch: cannot read {args.branch} (HTTP {status})", file=sys.stderr)
        return 0

    sha = head.get("sha")
    message = (head.get("commit", {}).get("message") or "")
    if not sha or args.host_marker not in message:
        if args.verbose:
            print(f"safety-branch: {args.branch} tip is not this host's commit; left alone")
        return 0

    status, current = call("GET", f"/repos/{args.repo}/git/ref/heads/{args.safety_branch}", token)
    if status == 200 and isinstance(current, dict) and current.get("object", {}).get("sha") == sha:
        return 0  # already current

    if status == 404:
        status, body = call("POST", f"/repos/{args.repo}/git/refs", token,
                            {"ref": f"refs/heads/{args.safety_branch}", "sha": sha})
    else:
        status, body = call("PATCH", f"/repos/{args.repo}/git/refs/heads/{args.safety_branch}",
                            token, {"sha": sha, "force": False})

    if args.verbose:
        print(f"safety-branch: {args.safety_branch} -> {sha[:10]} (HTTP {status})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
