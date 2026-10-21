---
name: browser-game-development
description: "Build and verify a browser game with no dependencies."
version: 1.0.0
author: Reza + Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [game, canvas, html5, pixel-art, cdp, headless, playtest, apk]
---

# Browser Game Development

Build a complete, playable game that runs from a single `index.html` with zero
npm dependencies, then verify it in a real browser rather than describing it as
working. This shape is chosen deliberately: it runs from `file://`, so it packages
into an APK later without a bundler, and it needs no build step to stay playable.

## When to use

- The user asks for a game, a playable prototype, or anything interactive.
- A game must run on a phone with no toolchain (the APK path).
- You need to prove a game works, not just that it renders.

**When not to use:** if an engine is genuinely available and the user named it
(Godot, Unity), use the engine — see `godot-*` skills. This skill is for the
zero-dependency case.

## Procedure

### 1. Lock scope before writing code

Decide and state: the genre, the win/lose condition, the number of rooms or
levels, and what is deliberately excluded. A game is the easiest kind of project
to let grow past what can be finished and tested. Write the exclusions down.

### 2. Build the data layer first, and validate it headlessly

Split the game so that **content is data** and the engine only interprets it:
`world.js` (rooms, doors, objects), `story.js` (narrative graph), `sprites.js`
(pixel grids), `game.js` (loop and rules). Data-first pays off because the
expensive bugs — an unreachable room, a key behind its own lock, a dead-end
dialogue node — are provable without a browser.

Write the validators BEFORE the art. Required checks:

- **Flood-fill the map from the spawn** and assert every room centre and every
  interactable is reachable. This catches the single worst class of level bug:
  an unfinishable game.
- **Flood-fill a second time with locks treated as walls**, then assert every key
  sits in the region reachable WITHOUT the door it opens. Two floods separate
  "unreachable" from "correctly locked" — one flood cannot tell them apart.
- **Assert every door connects two different rooms**; a door that touches one is
  decorative and hiding a broken connection.
- **Walk the narrative graph** from every entry point, asserting each node ends,
  continues, or branches; every branch target exists; nothing is unreachable.
- **Assert each ending is reachable by a real walked path**, and that the final
  choice node's options lead to distinct endings.

Expose these as `validateWorld()` / `validateStory()` returning problem arrays,
and call them from `boot()` too — a warning in the console for the developer,
without ever blocking the player.

### 3. Then build the engine

Non-negotiables, each of which fixes a specific bug class:

- **Fixed timestep with a clamped delta.** Accumulate and step at 1/60; clamp the
  frame delta (~0.1s). An unclamped delta lets the player step through a wall
  after a backgrounded tab.
- **Axis-separated collision: move X, resolve, then move Y, resolve.** Resolving
  both at once produces sticking in corners.
- **Collide a small footprint box, not the sprite.** Sample all four corners of a
  body smaller than the art (e.g. 10x8 for 12x16 art) so the head can overlap a
  wall without feeling clipped.
- **Normalise diagonal input** by `1/sqrt(2)`, or diagonals are ~41% faster and
  every optimal route becomes diagonal.
- **Bake sprites once** into offscreen canvases at load; never `fillRect` per
  pixel per frame. Per-pixel drawing on a full tile screen dominates the frame
  budget.
- **For a first-person 3D game, use a DDA raycaster** instead of a full 3D
  engine — see `references/raycasting-fps.md` for the column loop, fisheye
  correction, sprite billboards, and z-buffer rules. Raycasting is the right
  tool when the deliverable must stay a single dependency-free HTML file.
- **"Real 3D" means real WebGL, not a raycaster.** When the user explicitly
  asks for real movement/quality ("واقعاً 3D", "واقعی"), drop the raycaster and
  use **Three.js from a CDN** with a perspective camera, real meshes, shadow
  maps (PCFSoft, 2048), ACES tone mapping, and a pixelRatio of 2. Keep it a
  single HTML file (inline everything except the Three.js import map) so it
  still opens by double-click. Do not ship a raycaster and call it 3D.
- **Draw at integer coordinates** with `image-rendering: pixelated`, and letterbox
  the canvas with `object-fit: contain` so it scales on a phone.
- **Darkness via one opaque overlay with `destination-out` holes**, not additive
  light. Additive light leaves distant rooms grey instead of genuinely black, and
  in a horror game the black is the mechanic.

### 4. Audio that cannot break the game

- **Wrap every `play()`** and swallow failures. A missing or blocked file must
  degrade to silence, never throw into the update loop.
- **For a single-file game, prefer procedural Web Audio over embedded mp3.**
  Synthesize shots, hits, and deaths with `OscillatorNode` + an `AudioBuffer`
  noise source and a `GainNode` envelope; `resume()` the `AudioContext` on the
  first user gesture. Zero bytes, no packaging step, no licence question, and it
  cannot 404. Reserve embedded mp3 for music and long ambient beds, where
  synthesis gets expensive.
- **Autoplay policy needs a gesture.** Queue requested sounds until the first
  user interaction, then flush the queue. The start button is the natural unlock.
- **Crossfade ambient beds** on an interval rather than setting volume once, or
  the transition clicks. Make re-requesting the current bed a no-op so callers can
  fire it every frame from a room check.
- Synthesize effects with `ffmpeg` (noise colours, oscillators, tremolo, `aeval`
  envelopes) rather than downloading assets: no licence question, a few hundred
  KB, and reproducible from a checked-in script. Keep effects mono and low-rate —
  the harshness reads as "old recording", which suits horror.
- **Encode to mp3**, not ogg, for maximum Android WebView compatibility when this
  ships inside an APK.

### 5. Verify in a real browser, not a stub

A stubbed canvas accepts any draw call, so it cannot catch a script that fails to
parse, a sprite-name typo that draws nothing, or a null dereference inside the
update loop. Two layers, both in `references/headless-verification.md`:

1. **Data validation in `node` with `vm`** — load the real `world.js`/`story.js`
   with a stubbed `document`, run the validators, print the tables.
2. **Real-browser playtest over CDP** — launch headless Chromium, load the game
   over HTTP, dispatch real keyboard events, and read the game's own state back
   out of the page. Assert on behaviour: movement changes position, a wall stops
   it, a locked door refuses without the key, a save/load round-trips, every
   ending is reachable, and no uncaught error fired.

`scripts/cdp-playtest.js` is a working dependency-free harness for layer 2.

### 6. Work to the end of the agreed scope, then report once

A game build is a long chain of tool calls. **Do not yield the turn between tool
batches to deliver a fragment of narration.** The user cannot act on "I am
building now", so a mid-task pause reads as the work stalling and they interrupt
to ask what happened — which costs more turns than continuing would have. Batch
many tool calls into one turn and keep going.

Two things genuinely warrant ending a turn early, and only these:

- **A decision only the user can make** (scope, tone, which engine).
- **A blocker that ends the work** — say plainly that it failed, what the output
  said, and what you need. Never dress a failed step as done.

When the user asks for the artifact at any point, produce and attach it in that
same turn instead of finishing the remaining polish first — but otherwise finish,
then report.

When a test fails, establish which side is wrong before fixing it: a failing
assertion is frequently a bug in the TEST, not the game. Say plainly which one it
turned out to be rather than silently patching both.

## Pitfalls

- **`pkill -f <pattern>` matches your own command line and kills your own
  shell.** A cleanup such as `pkill -f chrome-test` run from a shell whose command
  string itself contains `chrome-test` terminates that shell mid-script: the call
  returns `SIGTERM`, and every later step in the same block is silently skipped —
  which looks like the harness hanging rather than like a kill. Kill by PID, or
  bracket one character (`pkill -f "[c]hrome-test"`), which the regex still
  matches while the literal command line no longer self-matches. Chain a
  terminating `pkill -f "remote-debugging"` into a test command and the same
  thing happens to the test.
- **Adjacent rooms put their perimeter walls on DIFFERENT tiles.** A 1-tile door
  opens one side only and the rooms stay sealed; every door needs to be 2 tiles on
  each axis to cut through both walls. Symptom: flood-fill reports every room
except the spawn as unreachable.
- **Only cut a door hole where a wall exists.** Writing a door over floor carves a
  silent passage through a room interior.
- **A restored unlocked door must also re-open its grid hole.** Loading a save that
  says a door is open while leaving the tile as `D` blocks the player in a room a
  save-file says they can leave.
- **Top-level `const` in a `vm` context is NOT a property of the sandbox object.**
  Destructuring the sandbox yields `undefined`; read the bindings by evaluating an
  expression (`vm.runInContext('({ROOMS, WORLD})', sb)`) instead.
- **In CDP, `sessionId` goes at the TOP LEVEL of the message**, not inside
  `params`. Putting it in `params` makes every call fail with `-32601 "'X' wasn't
  found"`.
- **`Runtime.evaluate` needs `awaitPromise: true` for any promise-returning
  expression**, or the result serialises as a Promise object and you get the
  string `"[object Object]"` instead of the value. This hides real assertions:
  an audio-decode check reported failure only because the flag was missing.
- **Extract a full data URI when testing an inlined asset, not a prefix.** A
  200-char slice of an embedded mp3 is a truncated file that decodes as `error`.
  Scan to the closing quote (`while (!/['"\s]/.test(t[j])) j++`) and take the
  whole thing.
- **Distinguish the codec question from the packaging question.** When an
  embedded asset fails to decode, decode a data URI built *fresh* from the source
  file in the same browser. If the fresh one decodes and the embedded one does
  not, packaging is at fault; if neither decodes, the browser build lacks the
  codec — do not "fix" the game for a codec problem.
- **An ending is not one step away.** Choosing a finale option jumps to an ending
  node that still has many lines to page through. A test that advances once and
  reads the ending reports `null` — the game is fine, the test is wrong. Loop
  `while (state === 'dialogue')` with a bounded guard.
- **Assert the overlay is visible, not just the state variable.** A flipped flag
  with no DOM change is invisible to a state-only check.
- **Keep the canvas resolution low and fixed** (e.g. 320x180) and scale up. Drawing
  at device resolution defeats pixel art and costs frames for nothing.
- **Text inside the canvas needs explicit RTL placement.** `ctx.textAlign='right'`
  with an RTL font stack; do not assume the DOM `dir` attribute reaches canvas.

## Packaging the deliverable

Produce two artifacts when the user asks for "the game":

1. **One self-contained `.html`** — inline the CSS, every JS module, and each
   audio file as a `data:audio/mpeg;base64,` URI. It then plays by double-clicking
   with no server, no sibling folder, and no network. This is what people actually
   open.
2. **A `.zip` of the source tree** — the editable project plus tools and README.

**Keep generated artifacts out of the state-sync snapshot only if they are cheap to
regenerate — otherwise ship them.** A `dist/` directory is a build product, but it
is also the thing the user opens; commit it alongside the source rather than
excluding it, and make the packaging step reproducible so a rebuild matches.

**For a single-file game, the `.html` IS the deliverable.** Do not split it into
modules or a build pipeline unless the user asks — the point of the zero-dependency
shape is that it opens by double-click with no server, no bundler, and no sibling
files. Inline CSS, JS, and (if any) audio as data URIs.

Then **verify the artifacts programmatically**, because an inlining script fails
quietly. Required checks:

- Every embedded data URI decodes to bytes **identical** to its source file
  (compare by length then equality, not by trusting the script).
- No relative asset path survives, and no external `<script src>` / `<link href>`
  remains.
- The single file contains every module and every story node (assert on marker
  strings such as `const STORY =` and each ending node id).
- The zip opens, is not corrupt, contains every expected file, and each archived
  entry matches the file on disk.

Zip can be written with `zlib.deflateRawSync` and a local header + central
 directory by hand; there is no `zip` binary in a minimal image. Fix the DOS date
 field so repeated builds are byte-identical.

**Ship the archive from disk, never from a string in the build script.** An
inline `README = \`...\`` and the real `README.md` drifted apart, and the verifier
caught the zip containing a document that existed nowhere in the project.

**Then send the files to the user — do not only report that they exist.** Run the
packaging step and attach the artifacts in the SAME turn that reports the tests
passing. A turn that describes a finished game, prints a green test summary, and
attaches nothing reads to the user as "no game" and they have to ask again. This
is the deliverable; a status report is not. Attach with the platform's file
mechanism (e.g. `MEDIA:/abs/path` on its own line) for both artifacts at once.

The same applies mid-build: when the user asks for the file at any point, produce
and attach it then rather than finishing the remaining polish first.

Confirm the single file works over `file://` with `--allow-file-access-from-files`
and no sibling files available, then play it: start, move, reach an ending.

## Packaging as an APK

What this architecture already guarantees, so the packaging step is mechanical:

- **Classic `<script src>` tags, never ES modules.** `type="module"` is blocked by
  CORS on `file://`, which is how a WebView loads bundled assets.
- **All asset paths relative**, so the same tree works from `file://` and a server.
- **mp3 audio, localStorage saves** — both work offline in a WebView with no
  plugins.
- Add `viewport-fit=cover` and safe-area padding, or a notch clips the UI.

Do not present specific wrapper commands as verified unless you actually ran them.

The wrapper (Capacitor or Cordova) is a Node toolchain that packages this same
directory into a WebView shell, so nothing in `js/` needs to change.

## Verification checklist

- Run `node --check` on the extracted script block before declaring it done. A
  single syntax error makes the whole game a blank page, and it is the cheapest
  check available.
- Confirm the file opens over `file://` (or `--allow-file-access-from-files`) with
  no sibling files and no console errors, then play it: start, move, shoot, die,
  and reach the win state.

- `node tools/validate-world.js` — geometry, reachability, key ordering.
- `node tools/validate-story.js` — graph integrity, all endings reachable.
- `node tools/playtest.js` — real browser; assert movement, collision, doors,
  inventory, every ending, save/load, and zero uncaught errors.
- Load the page and confirm the canvas has actually painted (count non-black
  pixels) — a blank canvas with a clean console is the failure this catches.
- Confirm the total size and that every referenced asset resolves.
