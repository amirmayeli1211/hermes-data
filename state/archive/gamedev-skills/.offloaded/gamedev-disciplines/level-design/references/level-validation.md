# Executable level validation

A level is data. If the data can be loaded without a renderer, it can be checked
by a script — and a script catches the class of defect that makes a game
unfinishable, which is invisible in an editor because a broken doorway still
looks like a doorway.

Run this on every build, not once. It costs milliseconds and it is the cheapest
guard against shipping a level nobody can complete.

## What to assert

| Check | Failure it catches |
| --- | --- |
| Object sits inside the room it declares | Data drift after moving a room's rect |
| Every room centre is reachable from spawn | Sealed room — usually a doorway too thin for the wall |
| Every interactable is on a reachable tile | An item walled in past a geometry change |
| Every locked door has a key reachable with locks CLOSED | Soft-lock: key behind its own door |
| Every doorway spans the full wall thickness | The one-tile-door bug below |
| Every doorway is bigger than the player's collision box | Invisible clipping on corner rounding |
| Every door touches two different rooms | Decorative door that connects nothing |
| No interactable is embedded in a wall tile | Placement rounding onto a wall |

## The two flood fills

Change only the passability predicate between runs; that single difference is
what separates "sealed" from "soft-locked".

```js
const PASSABLE = (t) => t === '.' || t === 'd';   // 'd' open, 'D' locked

function flood(passable) {
  const seen = new Set(['2,2']);                   // spawn tile
  const q = [[2, 2]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
      if (seen.has(k)) continue;
      if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
      if (!passable(grid[ny][nx])) continue;
      seen.add(k);
      q.push([nx, ny]);
    }
  }
  return seen;
}

const reachAll  = flood((t) => PASSABLE(t) || t === 'D');  // connectivity
const reachOpen = flood(PASSABLE);                          // progression order
```

- **`reachAll` failing** → the geometry itself is severed. A doorway is not
  cutting through; nothing about keys is involved.
- **`reachOpen` failing for a key's container** → progression is broken. The key
  exists and the room exists, but getting to the key requires passing the door it
  opens.

Resolve a key's position through its container when items are hidden inside
openable objects, and check the CONTAINER's tile — checking the item's own tile
reports a false pass for anything spawned inside furniture.

## The door-thickness bug

Drawing each room as an independent hollow box is the natural way to author a
tile map, and it silently gives every room its own perimeter wall:

```
  room A                     room B
  x=0..11                    x=12..23
  perimeter: x=11 is '#'     perimeter: x=12 is '#'
                 ↑ two solid tiles between the rooms
```

A doorway authored as one tile wide opens `x=11` and leaves `x=12` solid. Rooms
stay sealed, the map looks correct, and only a flood fill notices.

Two ways to prevent it, and the second is better:

1. Size doorways to span the full thickness on their axis — 2x2 rather than 2x1
   or 1x2 when rooms abut.
2. **Carve doors only over wall tiles**, and never over floor:

```js
// Only open a hole where there is actually a wall to open. Writing
// unconditionally also cuts passages through room INTERIORS, creating routes the
// design never intended.
if (grid[y][x] === '#') grid[y][x] = d.open ? 'd' : 'D';
```

Assert the thickness in the validator too, so a future edit that narrows a door
fails loudly rather than re-sealing a room.

## Running the level data headlessly

Load the game's own level module in a VM with a stubbed DOM, so the check cannot
drift from shipped data. There is no second copy of the map to keep in sync.

```js
const vm = require('vm');
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
for (const f of ['js/sprites.js', 'js/world.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
```

### Getting the values back out of the VM

`const` declarations at the top level of a script create bindings in the
context's **global lexical scope**. They are visible to every later script in the
same context, but they are NOT properties of the sandbox object:

```js
// WRONG — all undefined. The bindings are lexical, not properties of the object.
const { ROOMS, WORLD } = sandbox;
```

```js
// RIGHT — evaluate an expression in the context and take the values from that.
const exported = vm.runInContext(
  '({ ROOMS, DOORS, OBJECTS, WORLD, validateWorld, TILE })',
  sandbox, { filename: 'level-exports' });
const { ROOMS, WORLD } = exported;
```

Guard the destructure immediately: a load error inside `runInContext` leaves the
binding absent, and an unguarded `WORLD.grid` then throws a `TypeError` that
buries the real cause under a stack trace.

## Reporting

Print the geometry counts (walls / floor / open doors / locked doors), each room
with its size, position, object count and darkness, and every door with its lock
state. Two reasons: a surprising count is itself a signal (a room with zero
objects is usually a placement mistake), and the dump is the readable artifact to
paste into a review.

Exit non-zero on any failure so the check can gate a build.
