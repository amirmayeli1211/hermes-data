# Headless verification of a browser game

Two layers. Use both: the data layer catches content bugs cheaply and in a second;
the browser layer catches everything a stub cannot.

## Why a stub is not enough

A stubbed `document.createElement('canvas')` returns an object whose `getContext()`
accepts any call and returns `{}`. Every draw silently no-ops. So a stub will pass
while the real page throws on the first frame or draws nothing at all. Use the stub
for DATA, and a real browser for BEHAVIOUR.

---

## Layer 1 — data validation in `node` with `vm`

Load the real content files with a minimal `document` stub, so the validator cannot
drift from what ships.

```js
const fs = require('fs'), path = require('path'), vm = require('vm');

const sandbox = {
  console, Math, JSON, Array, Object, Set, Map, String, Number, Boolean, Error,
  document: {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ fillRect() {}, fillStyle: '', drawImage() {} }),
    }),
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['js/sprites.js', 'js/world.js', 'js/story.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}

// IMPORTANT: top-level `const` in a context is a LEXICAL binding, not a property
// of the sandbox object. Destructuring the sandbox yields undefined.
const { ROOMS, DOORS, OBJECTS, WORLD, validateWorld } = vm.runInContext(
  '({ ROOMS, DOORS, OBJECTS, WORLD, validateWorld })', sandbox, { filename: 'exports' });

if (!WORLD || !WORLD.grid) { console.error('WORLD undefined — load failed'); process.exit(1); }
```

### Flood-fill, twice

One flood cannot distinguish "unreachable" from "locked but correct".

```js
const flood = (passable) => {
  const seen = new Set(['2,2']), q = [[2, 2]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
      if (seen.has(k)) continue;
      if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
      if (!passable(grid[ny][nx])) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  return seen;
};

// 1. geometry: locked doors passable -> proves the map is ONE connected body
const reachAll = flood((t) => t === '.' || t === 'd' || t === 'D');
for (const id in ROOMS) {
  const r = ROOMS[id], cx = Math.floor(r.x + r.w/2), cy = Math.floor(r.y + r.h/2);
  if (!reachAll.has(cx + ',' + cy)) fail(`room '${id}' centre unreachable — a doorway is not cutting through both walls`);
}

// 2. progression: locked doors are walls -> every key must be obtainable
const reachOpen = flood((t) => t === '.' || t === 'd');
for (const d of DOORS) {
  if (d.open || !d.lock) continue;
  const key = OBJECTS.find((o) => o.item === d.lock);
  // the key may live inside a container, so locate the CONTAINER's tile
  const host = key.hidden ? OBJECTS.find((o) => o.id === key.hidden) : key;
  const k = Math.floor(host.x) + ',' + Math.floor(host.y);
  if (!reachOpen.has(k)) fail(`key '${d.lock}' for door ${d.id} is behind its own lock — soft-lock`);
}
```

The message matters: the FIRST check firing for every non-spawn room means a
doorway is one tile thick and sealed. The SECOND firing means a key ordering bug.
They have different fixes, so keep them separate.

### Graph walking with a cycle guard

```js
let guard = 0;
while (state === 'dialogue' && guard++ < 40) advance();
```

Every walk needs a depth or iteration cap. A cycle in authoring data otherwise
hangs the test instead of failing it — and a hang looks like an infrastructure
problem, so it gets retried rather than investigated.

---

## Layer 2 — real browser over CDP, with no dependencies

`puppeteer` and `playwright` are usually absent from a minimal image, and Chrome's
WebSocket protocol is small enough to speak directly. Full working harness:
`scripts/cdp-playtest.js`. The essentials:

1. **Serve over HTTP.** `file://` blocks audio in some builds and gives odd
   origin behaviour. A 20-line static server with a MIME map is enough; without
   one, a typo in an asset path becomes a mystery instead of a 404.
2. **Launch Chromium headless** with `--remote-debugging-port`, `--no-sandbox`,
   `--disable-dev-shm-usage`, `--mute-audio`, and a throwaway `--user-data-dir`
   under the offload/temp dir. Remove the profile after the run.
3. **Discover the socket** from `http://127.0.0.1:<port>/json/version` →
   `webSocketDebuggerUrl`. Create a page with `Target.createTarget`, attach with
   `Target.attachToTarget { flatten: true }`, and use the returned `sessionId`.
4. **`sessionId` is a TOP-LEVEL field of the CDP message.** `{id, method, params,
   sessionId}`. Nested inside `params` it is ignored and every call returns
   `-32601 "'X' wasn't found"` — which reads like a protocol-version problem and
   sends you chasing the wrong thing.
5. **Read game state out of the page** with `Runtime.evaluate`,
   `returnByValue: true`. Assert on the game's own variables; do not scrape pixels
   for logic assertions.
6. **Dispatch real key events** into `window` (`new KeyboardEvent('keydown', ...)`)
   and let the game's own rAF loop move the player, then read the position back.
   `Input.dispatchKeyEvent` needs a focused target and is more fragile.
7. **Install error collectors before interacting**, so an exception during play is
   captured rather than lost:

```js
window.__errs = [];
window.addEventListener('error', e => window.__errs.push(String(e.message || e.error)));
window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason)));
```

Also subscribe to `Runtime.enable` / `Log.enable` / `Page.enable` and wait for
`document.readyState === 'complete'` before touching the game — polling the
readiness flag is more reliable than a fixed sleep.

### What to assert

Behaviour, in this order — each maps to a bug class that a screenshot cannot show:

| assertion | catches |
| --- | --- |
| objects loaded (`Game`, `WORLD`, `STORY` defined) | a script that failed to parse |
| sprites baked > expected count | a name typo producing blank art |
| canvas has non-black pixels | a clean console with nothing drawn |
| key press moves the player | input wiring, or a stuck loop |
| pressing into a wall does not pass through | collision, or an unclamped delta |
| a locked door refuses, then opens with the key | gating logic |
| the grid tile is actually walkable after unlocking | a flag flipped without the collision map updated |
| item pickup appears in the inventory | the item → UI path |
| every ending is reached by choosing through to it | a stalled dialogue graph |
| the end overlay is VISIBLE, not just the state | a flag with no DOM change |
| save → mutate → load restores position, doors, flags | serialisation gaps |
| 400 synthetic `update()` steps do not throw | slow leaks and one-shot crashes |
| `window.__errs` is empty | anything the above missed |

### Proving a headless run actually exercised the game

A test that silently does nothing passes. Guard against it by asserting the
positive space too: `nonBlack > 500`, `baked > 25`, `afterRun > beforeRun`. A
test whose expectations are all negative ("no error") can pass on a totally blank
page.
