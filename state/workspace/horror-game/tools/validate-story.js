/* validate-story.js — checks the narrative graph.
 *
 * THE GRAPH IS NOT LINEAR. Each interactable object in world.js names a story
 * node as its entry point (`story:`), so the script is a set of small graphs
 * rooted at those objects rather than one chain from a single start. Validating
 * only from STORY.start therefore reports ~30 false "unreachable" failures — the
 * first version of this file did exactly that.
 *
 * The real checks, in order of what actually breaks a shipped game:
 *   1. every object's `story:` id exists            (else interacting crashes)
 *   2. every node terminates, continues, or branches (else the game stalls)
 *   3. every branch target exists                   (else a choice crashes)
 *   4. every node is reachable from SOME root       (else it is dead content)
 *   5. every ending is producible by a real path
 *
 * Run: node tools/validate-story.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

const sandbox = {
  console, Math, JSON, Array, Object, Set, Map, String, Number, Boolean, Error,
  document: {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, fillStyle: '', drawImage() {} }) }),
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['js/sprites.js', 'js/world.js', 'js/story.js']) {
  try {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  } catch (e) {
    console.error(`FAILED to load ${f}: ${e.message}`);
    process.exit(1);
  }
}

const { STORY, ENDINGS, OBJECTS, validateStory } = vm.runInContext(
  '({ STORY, ENDINGS, OBJECTS, validateStory })', sandbox, { filename: 'exports' });

let failures = 0;
const fail = (m) => { console.log(`  FAIL  ${m}`); failures++; };
const ok = (m) => console.log(`  ok    ${m}`);

console.log('=== integration: objects -> story nodes ===');
const roots = new Set();
for (const o of OBJECTS) {
  if (!o.story) continue;
  if (!STORY.nodes[o.story]) {
    fail(`object '${o.id}' points at story node '${o.story}' which does not exist — interacting would crash`);
  } else {
    roots.add(o.story);
  }
}
if (!failures) ok(`every object's story node exists (${roots.size} distinct entry point(s))`);

console.log('\n=== story graph ===');
const problems = validateStory();
// The structural half of validateStory is reliable; its single-root reachability
// check is not (see the file header), so it is re-derived below from all roots.
const STRUCTURAL = problems.filter((p) => !p.includes('is unreachable from start'));
for (const p of STRUCTURAL) fail(p);
if (!STRUCTURAL.length) {
  ok('every node terminates, continues, or branches');
  ok('every branch target exists');
  ok('every declared ending is reachable');
}

// Reachability from every root, including STORY.start.
const seen = new Set();
const stack = [STORY.start, ...roots];
while (stack.length) {
  const id = stack.pop();
  if (!id || seen.has(id)) continue;
  seen.add(id);
  const n = STORY.nodes[id];
  if (!n) continue;
  if (n.next) stack.push(n.next);
  if (n.choices) for (const c of n.choices) if (c.to) stack.push(c.to);
}
const unreachable = Object.keys(STORY.nodes).filter((i) => !seen.has(i));
if (unreachable.length) for (const u of unreachable) fail(`node '${u}' is unreachable from every entry point — dead content`);
else ok('every node is reachable from some entry point');

const ids = Object.keys(STORY.nodes);
let lines = 0;
for (const id of ids) lines += STORY.nodes[id].lines.length;

console.log(`\n  nodes        ${ids.length}`);
console.log(`  lines        ${lines}`);
console.log(`  choices      ${ids.reduce((a, i) => a + ((STORY.nodes[i].choices || []).length), 0)}`);
console.log(`  entry points ${roots.size}`);
console.log(`  endings      ${Object.keys(ENDINGS).length}`);

console.log('\n=== endings ===');
for (const k in ENDINGS) {
  const src = ids.filter((i) => STORY.nodes[i].ending === k);
  console.log(`  ${k.padEnd(6)} ${ENDINGS[k].title.padEnd(12)} via ${src.join(', ') || '(none)'}`);
}

/* Recursive walk of every choice path from every root, so a stalled branch or a
   cycle shows up as a real failure rather than a silent hang in play. */
console.log('\n=== playthroughs ===');
const paths = [];
function walk(id, trail, depth, origin) {
  if (depth > 80) { fail(`path from '${origin}' exceeded depth 80 — cycle through '${id}'`); return; }
  const n = STORY.nodes[id];
  if (!n) { fail(`path from '${origin}' hit missing node '${id}'`); return; }
  const t = trail.concat(id);
  if (n.ending) { paths.push({ ending: n.ending, trail: t, origin }); return; }
  if (n.next) { walk(n.next, t, depth + 1, origin); return; }
  if (n.choices) { for (const c of n.choices) walk(c.to, t, depth + 1, origin); return; }
  if (n.end) { paths.push({ ending: null, trail: t, origin }); return; }
  fail(`path from '${origin}' stuck at '${id}' — no end, next, or choices`);
}

for (const r of new Set([STORY.start, ...roots])) walk(r, [], 0, r);

const byEnding = {};
for (const p of paths) {
  const k = p.ending || '(info node)';
  byEnding[k] = (byEnding[k] || 0) + 1;
}
for (const k in byEnding) console.log(`  ${k.padEnd(12)} ${byEnding[k]} path(s)`);

for (const e of ['best', 'bad', 'flee']) {
  if (!paths.some((p) => p.ending === e)) fail(`ending '${e}' is not reachable by any path`);
}
if (!failures) ok('all three endings are reachable by real paths');

/* The finale is the only multi-ending node; confirm each of its choices leads to
   a DIFFERENT ending. Three choices that all land on one ending is a common
   authoring slip and reads as a broken choice system. */
console.log('\n=== finale branching ===');
const fin = STORY.nodes.finale;
if (!fin || !fin.choices) {
  fail('finale node is missing or has no choices');
} else {
  const ends = fin.choices.map((c) => {
    let id = c.to, guard = 0, e = null;
    while (id && guard++ < 40) {
      const n = STORY.nodes[id];
      if (!n) break;
      if (n.ending) { e = n.ending; break; }
      if (n.next) { id = n.next; continue; }
      if (n.choices) { e = '(branches further)'; break; }
      break;
    }
    return e;
  });
  console.log(`  choices -> endings: ${ends.join(', ')}`);
  const real = ends.filter((e) => e && e !== '(branches further)');
  if (new Set(real).size !== real.length) fail('two finale choices lead to the same ending');
  else ok('each finale choice leads to a distinct ending');
}

console.log(`\n${failures === 0 ? 'STORY VALIDATION PASSED' : `STORY VALIDATION FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
