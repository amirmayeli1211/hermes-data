/* validate-world.js — headless check of the level's geometry and key ordering.
 *
 * Runs the SAME world.js the game runs, with a stubbed DOM, so the check cannot
 * drift from the real level data. Anything it reports is a genuine defect in the
 * shipped level, not a duplicate definition.
 *
 * Run: node tools/validate-world.js
 * Exit: 0 clean, 1 problems found.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

// Minimal stubs: world.js touches no DOM, but sprites.js does at load time.
const sandbox = {
  console,
  document: {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ fillRect() {}, fillStyle: '', drawImage() {} }),
    }),
  },
  Math, JSON, Array, Object, Set, Map, String, Number, Boolean, Error,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['js/sprites.js', 'js/world.js']) {
  const code = fs.readFileSync(path.join(root, f), 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: f });
  } catch (e) {
    console.error(`FAILED to load ${f}: ${e.message}`);
    process.exit(1);
  }
}

/* world.js declares ROOMS/DOORS/WORLD with `const`, which creates bindings in the
 * context's global LEXICAL scope — visible to later scripts in the same context,
 * but NOT as properties of the sandbox object. So they must be read by evaluating
 * an expression, not by destructuring the sandbox (which yields undefined). */
const exported = (() => {
  try {
    return vm.runInContext(
      '({ ROOMS, DOORS, OBJECTS, WORLD, validateWorld, isWall, roomIdAtTile, TILE })',
      sandbox, { filename: 'world-exports' });
  } catch (e) {
    console.error(`FAILED to read world exports: ${e.message}`);
    process.exit(1);
  }
})();

const { ROOMS, DOORS, OBJECTS, WORLD, validateWorld, isWall, roomIdAtTile } = exported;

if (!WORLD || !WORLD.grid) {
  console.error('FAILED: WORLD is undefined — check that world.js loaded without error');
  process.exit(1);
}

let failures = 0;
const fail = (m) => { console.log(`  FAIL  ${m}`); failures++; };
const ok = (m) => console.log(`  ok    ${m}`);

console.log('=== world integrity ===');

const problems = validateWorld();
if (problems.length) {
  for (const p of problems) fail(p);
} else {
  ok('every object is inside its declared room');
  ok('every room centre is reachable from spawn');
  ok('every object stands on a reachable tile');
  ok('every locked door has a key obtainable outside the lock');
}

console.log('\n=== tiles ===');
const { grid, W, H } = WORLD;
let walls = 0, floors = 0, doors = 0, locked = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const t = grid[y][x];
    if (t === '#') walls++;
    else if (t === '.') floors++;
    else if (t === 'd') doors++;
    else if (t === 'D') locked++;
  }
}
console.log(`  grid        ${W}x${H}`);
console.log(`  walls       ${walls}`);
console.log(`  floor       ${floors}`);
console.log(`  open doors  ${doors}`);
console.log(`  locked      ${locked}`);

console.log('\n=== rooms ===');
for (const id in ROOMS) {
  const r = ROOMS[id];
  const objs = OBJECTS.filter((o) => o.room === id).length;
  console.log(`  ${id.padEnd(12)} ${String(r.w).padStart(2)}x${String(r.h).padStart(2)} @ (${String(r.x).padStart(2)},${String(r.y).padStart(2)})  ${objs} object(s)  dark=${r.dark}`);
}

console.log('\n=== doors ===');
for (const d of DOORS) {
  const state = d.open ? 'open  ' : `LOCKED(${d.lock})`;
  console.log(`  ${d.id.padEnd(18)} ${state}  ${d.label}`);
}

console.log('\n=== spawn and key path sanity ===');
const spawn = { x: 2.5 * 16, y: 2.5 * 16 };
console.log(`  spawn tile   (2,2) -> room '${roomIdAtTile(2, 2)}'`);
if (roomIdAtTile(2, 2) !== 'hall') fail('spawn is not in the hall');
else ok('spawn is in the hall');

// Movement sanity: the player is 12x16 px, so a 16px corridor leaves 4px of slack.
// Confirm every door opening is at least 2 tiles tall/wide so the body fits.
for (const d of DOORS) {
  const span = d.w > d.h ? d.w : d.h;
  if (span < 2) fail(`door ${d.id} opening is only ${span} tile(s) — a 12x16 player will clip`);
}
if (!failures) ok('every door opening fits the player body');

console.log('\n=== object reachability spot-check ===');
for (const o of OBJECTS) {
  const tx = Math.floor(o.x), ty = Math.floor(o.y);
  const t = (ty >= 0 && ty < H && tx >= 0 && tx < W) ? grid[ty][tx] : '?';
  if (t === '#' || t === 'D') {
    // Objects ON a door tile are the door markers themselves; anything else is wrong.
    if (o.kind !== 'door') fail(`object ${o.id} is embedded in a wall tile (${tx},${ty}) type '${t}'`);
  }
}
if (!failures) ok('no interactable is embedded in a wall');

console.log(`\n${failures === 0 ? 'VALIDATION PASSED' : `VALIDATION FAILED (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
