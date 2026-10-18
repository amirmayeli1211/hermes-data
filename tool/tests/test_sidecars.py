#!/usr/bin/env python3
"""Regression tests for the sidecar/backup exclusion gap.

A `cp auth.json auth.json.bak` produces a file that holds live tokens but whose
name is not itself on the deny list. Before the `.bak`-family patterns existed,
such a file WAS collected and pushed. This suite pins that shut, and also pins
the false-positive side: real content with dots in the name must still sync.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent / "ghstore.py"
spec = importlib.util.spec_from_file_location("ghstore", TOOL)
ghstore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ghstore)

PASS, FAIL = [], []


def check(name: str, condition: bool, detail: str = "") -> None:
    (PASS if condition else FAIL).append(name)
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}"
          + (f" — {detail}" if detail and not condition else ""))


def main() -> int:
    print("sidecar exclusion — must be refused (they copy credential files):")
    for rel in [
        ".env.pre-rotate.20261018T045629Z",
        ".env.bak",
        ".env.old",
        ".env.orig",
        ".env.save",
        "auth.json.bak",
        "auth.json.bak.1",
        "credentials.json.bak",
        "state.db.bak",
        "config.yaml.orig",
        "config.yaml.swp",
        "SOUL.md~",
        "memories/MEMORY.md.bak",
    ]:
        check(f"refuses {rel}", ghstore.is_excluded(rel))

    print("\nreal content with dots/versions — must still sync:")
    for rel in [
        "config.yaml",
        "SOUL.md",
        "memories/MEMORY.md",
        "skills/apple/apple-notes/SKILL.md",
        "skills/web/blocked-page-recovery/scripts/recover_page.py",
        "cron/jobs.json",
        "workspace/main.py",
        "skills/software-development/github/references/github-api-cheatsheet.md",
    ]:
        check(f"keeps {rel}", not ghstore.is_excluded(rel))

    print("\nthe .gitignore must cover the same sidecars (a manual `git add -A`):")
    gi = ghstore.GITIGNORE
    for pattern in ("*.bak", "*.old", "*.orig", "*.save", "*.swp", "*~"):
        check(f"gitignore has {pattern}", pattern in gi)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    for name in FAIL:
        print(f"  FAILED: {name}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
