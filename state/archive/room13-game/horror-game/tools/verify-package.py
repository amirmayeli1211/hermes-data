#!/usr/bin/env python3
"""verify-package.py — prove the shipped artifacts are complete and self-contained.

Checks, against dist/room13.html and dist/room13.zip:
  1. every embedded data: URI decodes to bytes IDENTICAL to its source mp3
  2. no relative file-path reference to any asset survives in the single file
  3. no external <script src> or <link href> remains
  4. the zip opens, is not corrupt, and contains every source file
  5. the zip's copy of each file matches the file on disk
  6. the single file contains the whole game (world, story, all five JS modules)
"""
import base64
import hashlib
import json
import os
import re
import sys
import zipfile

ROOT = "/data/.hermes/workspace/horror-game"
HTML = os.path.join(ROOT, "dist", "room13.html")
ZIP = os.path.join(ROOT, "dist", "room13.zip")

fails = []
def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        fails.append(name)

print("=== single file: dist/room13.html ===")
html = open(HTML, encoding="utf-8").read()

# --- 1. audio embedded and byte-exact -------------------------------------
audio_dir = os.path.join(ROOT, "assets", "audio")
originals = {}
for f in sorted(os.listdir(audio_dir)):
    if f.endswith(".mp3"):
        originals[f] = open(os.path.join(audio_dir, f), "rb").read()

found = []
i = 0
needle = "data:audio/mpeg;base64,"
while True:
    i = html.find(needle, i)
    if i < 0:
        break
    j = i
    while j < len(html) and html[j] not in "'\"\n\r\t ":
        j += 1
    found.append(html[i:j])
    i = j

check(f"all {len(originals)} mp3 files are embedded", len(found) == len(originals),
      f"embedded={len(found)} on-disk={len(originals)}")

matched, unmatched = 0, []
for uri in found:
    raw = base64.b64decode(uri[len(needle):])
    hit = next((n for n, o in originals.items() if len(o) == len(raw) and o == raw), None)
    if hit:
        matched += 1
    else:
        unmatched.append(len(raw))
check("every embedded track is byte-identical to its source file",
      matched == len(found) and len(found) > 0,
      f"matched={matched}/{len(found)} unmatched_sizes={unmatched}")

# --- 2/3. nothing external ------------------------------------------------
leftover_paths = re.findall(r"assets/audio/[a-z0-9_]+\.mp3", html)
check("no file-path reference to any audio file remains", not leftover_paths,
      str(leftover_paths[:5]))

script_src = re.findall(r"<script[^>]+src=", html)
link_href = re.findall(r"<link[^>]+href=", html)
check("no external <script src> tag", not script_src, str(script_src[:3]))
check("no external <link href> stylesheet", not link_href, str(link_href[:3]))

# --- 6. the whole game is present ----------------------------------------
for marker, label in [
    ("const SPR = {}", "sprite data"),
    ("const Sound =", "audio engine"),
    ("const ROOMS =", "world definition"),
    ("const DOORS =", "door graph"),
    ("const OBJECTS =", "interactables"),
    ("const STORY =", "narrative graph"),
    ("const Game =", "game engine"),
    ("function validateWorld", "world validator"),
    ("function validateStory", "story validator"),
]:
    check(f"contains {label}", marker in html, marker)

for nid in ("note_intro", "ending_ritual", "ending_answer", "ending_flee", "finale"):
    check(f"contains story node {nid}", f"{nid}:" in html)

# --- 4/5. the zip ---------------------------------------------------------
print("\n=== project archive: dist/room13.zip ===")
check("zip exists", os.path.exists(ZIP))
try:
    z = zipfile.ZipFile(ZIP)
    bad = z.testzip()
    check("zip is not corrupt", bad is None, str(bad))
    names = z.namelist()
    check("zip is not empty", len(names) > 10, f"entries={len(names)}")

    expected = ["index.html", "style.css", "README.md", "APK.md",
                "js/game.js", "js/world.js", "js/story.js", "js/audio.js", "js/sprites.js",
                "tools/generate-audio.sh", "tools/validate-world.js",
                "tools/validate-story.js", "tools/playtest.js", "tools/package.js"]
    for e in expected:
        check(f"zip contains {e}", e in names)

    n_audio = len([n for n in names if n.startswith("assets/audio/") and n.endswith(".mp3")])
    check(f"zip contains all {len(originals)} audio files", n_audio == len(originals),
          f"found={n_audio}")

    mism = []
    for n in names:
        if n.endswith("/"):
            continue
        disk = os.path.join(ROOT, n)
        if not os.path.exists(disk):
            mism.append(f"{n} (not on disk)")
            continue
        if z.read(n) != open(disk, "rb").read():
            mism.append(f"{n} (content differs)")
    check("every archived file matches the working copy", not mism, str(mism[:4]))
    z.close()
except zipfile.BadZipFile as e:
    check("zip opens", False, str(e))

# --- report ---------------------------------------------------------------
print("\n=== summary ===")
h = os.path.getsize(HTML)
zsz = os.path.getsize(ZIP)
print(f"  room13.html   {h/1024:.0f} KB   single self-contained file")
print(f"  room13.zip    {zsz/1024:.0f} KB   full editable project")
print(f"\n{'PACKAGE VERIFIED' if not fails else f'PACKAGE PROBLEMS ({len(fails)})'}")
for f in fails:
    print(f"  FAILED: {f}")
sys.exit(0 if not fails else 1)
