/* world.js — the map: rooms, tile collision, and what sits in each one.
   Built as data, not code, so the level can be validated without rendering it.

   Coordinates are in TILES. The renderer scales; nothing here knows about
   pixels, which is what lets the headless validator replay the level without a
   browser.

   LAYOUT RULE — rooms are placed so that adjacent rooms touch, which means their
   perimeter walls land on DIFFERENT tiles (e.g. the hall's right wall is x=11 and
   the living room's left wall is x=12). A doorway therefore has to be 2 tiles
   thick on its axis to punch through BOTH walls. Every door below is 2x2. A 1-tile
   door would open only one side and the rooms would stay sealed — that exact bug
   is why `tools/validate-world.js` runs a flood fill on every boot. */
'use strict';

const TILE = 16;

/* Room rectangles, in tile bands that never overlap:
     band 1  y 0..11   |  band 2  y 12..25  |  band 3  y 26..39  */
const ROOMS = {
  hall:      { name: 'راهرو ورودی',  x: 0,  y: 0,  w: 12, h: 12, ambient: 'ambientWind',     floor: 'wood',     dark: 0.86 },
  living:    { name: 'اتاق نشیمن',   x: 12, y: 0,  w: 20, h: 12, ambient: 'ambientDrone',    floor: 'wood',     dark: 0.80 },
  kitchen:   { name: 'آشپزخانه',     x: 32, y: 0,  w: 16, h: 12, ambient: 'ambientWind',     floor: 'tile',     dark: 0.78 },
  bedroom:   { name: 'اتاق خواب',    x: 0,  y: 12, w: 14, h: 14, ambient: 'ambientDrone',    floor: 'wood',     dark: 0.88 },
  bathroom:  { name: 'حمام',         x: 14, y: 12, w: 12, h: 14, ambient: 'ambientBasement', floor: 'tile',     dark: 0.92 },
  childroom: { name: 'اتاق کودک',    x: 26, y: 12, w: 14, h: 12, ambient: 'ambientDrone',    floor: 'wood',     dark: 0.90 },
  study:     { name: 'اتاق کار',     x: 40, y: 12, w: 16, h: 14, ambient: 'ambientDrone',    floor: 'wood',     dark: 0.84 },
  corridor2: { name: 'راهرو پشتی',   x: 0,  y: 26, w: 28, h: 14, ambient: 'ambientWind',     floor: 'wood',     dark: 0.94 },
  basement:  { name: 'زیرزمین',      x: 28, y: 26, w: 18, h: 14, ambient: 'ambientBasement', floor: 'concrete', dark: 0.97 },
  crypt:     { name: 'اتاق آخر',     x: 46, y: 26, w: 14, h: 14, ambient: 'ambientBasement', floor: 'concrete', dark: 0.99 },
};

/* Doors. Every one is 2 tiles on each axis: `w:2` cuts a horizontal connection
   (side-by-side rooms, two vertical walls) and `h:2` cuts a vertical one
   (stacked rooms, two horizontal walls). */
const DOORS = [
  { id: 'hall_living',    x: 11, y: 5,  w: 2, h: 2, lock: null,       open: true,  label: 'در اتاق نشیمن' },
  { id: 'living_kitchen', x: 31, y: 4,  w: 2, h: 2, lock: null,       open: true,  label: 'در آشپزخانه' },
  { id: 'hall_bedroom',   x: 4,  y: 11, w: 2, h: 2, lock: null,       open: true,  label: 'در اتاق خواب' },
  { id: 'bedroom_bath',   x: 13, y: 17, w: 2, h: 2, lock: null,       open: true,  label: 'در حمام' },
  { id: 'bath_child',     x: 25, y: 17, w: 2, h: 2, lock: null,       open: true,  label: 'در اتاق کودک' },
  { id: 'living_child',   x: 28, y: 11, w: 2, h: 2, lock: null,       open: true,  label: 'در اتاق کودک' },
  { id: 'kitchen_study',  x: 43, y: 11, w: 2, h: 2, lock: null,       open: true,  label: 'در اتاق کار' },
  { id: 'bedroom_corr2',  x: 5,  y: 25, w: 2, h: 2, lock: null,       open: true,  label: 'پله‌های راهرو پشتی' },
  { id: 'corr2_basement', x: 27, y: 30, w: 2, h: 2, lock: 'key_iron', open: false, label: 'در آهنی زیرزمین' },
  { id: 'basement_crypt', x: 45, y: 32, w: 2, h: 2, lock: 'key_bone', open: false, label: 'در استخوانی' },
  { id: 'study_crypt',    x: 49, y: 25, w: 2, h: 2, lock: 'key_bone', open: false, label: 'راه مخفی کتابخانه' },
];

/* Objects: everything interactable. `kind` drives both the sprite and what the
   interact action does; `hidden` means it sits inside a container and only
   becomes visible once that container has been opened. */
const OBJECTS = [
  // --- hall
  { id: 'lamp_hall',      room: 'hall',      x: 2.2,  y: 2.2,  spr: 'lamp',    kind: 'lamp',   story: null,
    name: 'لامپ سوخته' },
  { id: 'note_intro',     room: 'hall',      x: 5.5,  y: 3.5,  spr: 'note',    kind: 'note',   story: 'note_intro',
    name: 'یادداشت روی زمین' },
  { id: 'radio_hall',     room: 'hall',      x: 8.5,  y: 7.5,  spr: 'radio',   kind: 'radio',  story: 'radio_1',
    name: 'رادیوی قدیمی' },
  { id: 'door_hall_liv',  room: 'hall',      x: 11.0, y: 5.3,  spr: 'door',    kind: 'door',   story: null,
    name: 'در اتاق نشیمن', door: 'hall_living' },
  { id: 'door_hall_bed',  room: 'hall',      x: 4.4,  y: 11.2, spr: 'door',    kind: 'door',   story: null,
    name: 'در اتاق خواب', door: 'hall_bedroom' },

  // --- living
  { id: 'mirror_liv',     room: 'living',    x: 14.2, y: 1.5,  spr: 'mirror',  kind: 'mirror', story: 'mirror',
    name: 'آینه' },
  { id: 'shelf_liv',      room: 'living',    x: 20.0, y: 1.3,  spr: 'shelf',   kind: 'shelf',  story: 'shelf',
    name: 'قفسه کتاب' },
  { id: 'note_liv',       room: 'living',    x: 27.5, y: 8.5,  spr: 'note',    kind: 'note',   story: 'note_mother',
    name: 'یادداشت مادر' },
  { id: 'battery_liv',    room: 'living',    x: 29.2, y: 3.5,  spr: 'battery', kind: 'item',   item: 'battery',
    name: 'باتری چراغ‌قوه' },
  { id: 'door_liv_kit',   room: 'living',    x: 31.0, y: 4.3,  spr: 'door',    kind: 'door',   story: null,
    name: 'در آشپزخانه', door: 'living_kitchen' },
  { id: 'door_liv_child', room: 'living',    x: 28.4, y: 11.2, spr: 'door',    kind: 'door',   story: null,
    name: 'در اتاق کودک', door: 'living_child' },

  // --- kitchen
  { id: 'sink_kit',       room: 'kitchen',   x: 40.0, y: 1.5,  spr: 'sink',    kind: 'sink',   story: 'sink' },
  { id: 'note_kit',       room: 'kitchen',   x: 35.0, y: 2.5,  spr: 'note',    kind: 'note',   story: 'note_kitchen',
    name: 'لیست خرید' },
  { id: 'radio_kit',      room: 'kitchen',   x: 44.0, y: 7.5,  spr: 'radio',   kind: 'radio',  story: 'radio_2',
    name: 'رادیو' },
  { id: 'door_kit_study', room: 'kitchen',   x: 43.4, y: 11.2, spr: 'door',    kind: 'door',   story: null,
    name: 'در اتاق کار', door: 'kitchen_study' },

  // --- bedroom
  { id: 'bed_bed',        room: 'bedroom',   x: 1.5,  y: 14.0, spr: 'bed',     kind: 'bed',    story: 'bed' },
  { id: 'desk_bed',       room: 'bedroom',   x: 11.3, y: 22.5, spr: 'desk',    kind: 'desk',   story: 'desk_bedroom' },
  { id: 'key_iron',       room: 'bedroom',   x: 11.3, y: 22.3, spr: 'key',     kind: 'item',   item: 'key_iron',
    name: 'کلید آهنی', hidden: 'desk_bed' },
  { id: 'note_bed',       room: 'bedroom',   x: 3.0,  y: 23.5, spr: 'note',    kind: 'note',   story: 'note_diary',
    name: 'دفتر خاطرات' },
  { id: 'door_bed_bath',  room: 'bedroom',   x: 13.2, y: 17.6, spr: 'door',    kind: 'door',   story: null,
    name: 'در حمام', door: 'bedroom_bath' },
  { id: 'stairs_corr2',   room: 'bedroom',   x: 5.4,  y: 25.2, spr: 'stairs',  kind: 'stairs', story: null,
    name: 'پله‌های پشتی', door: 'bedroom_corr2' },

  // --- bathroom
  { id: 'tub_bath',       room: 'bathroom',  x: 16.0, y: 14.0, spr: 'bathtub', kind: 'tub',    story: 'tub' },
  { id: 'battery_bath',   room: 'bathroom',  x: 23.0, y: 13.5, spr: 'battery', kind: 'item',   item: 'battery',
    name: 'باتری' },
  { id: 'blood_bath',     room: 'bathroom',  x: 20.0, y: 21.0, spr: 'blood',   kind: 'look',   story: 'blood_bath',
    name: 'لکه روی کف' },

  // --- childroom
  { id: 'bed_child',      room: 'childroom', x: 27.5, y: 14.0, spr: 'bed',     kind: 'bed',    story: 'bed_child' },
  { id: 'crate_child',    room: 'childroom', x: 37.0, y: 20.5, spr: 'crate',   kind: 'crate',  story: 'crate_child' },
  { id: 'tape_child',     room: 'childroom', x: 37.0, y: 20.3, spr: 'tape',    kind: 'item',   item: 'tape',
    name: 'نوار کاست', hidden: 'crate_child' },
  { id: 'flesh_child',    room: 'childroom', x: 31.0, y: 21.0, spr: 'flesh',   kind: 'look',   story: 'flesh_child',
    name: 'چیزی روی زمین' },

  // --- study
  { id: 'shelf_study',    room: 'study',     x: 41.0, y: 13.5, spr: 'shelf',   kind: 'shelf',  story: 'shelf_study' },
  { id: 'desk_study',     room: 'study',     x: 46.0, y: 20.0, spr: 'desk',    kind: 'desk',   story: 'desk_study' },
  { id: 'key_bone',       room: 'study',     x: 46.0, y: 19.8, spr: 'key',     kind: 'item',   item: 'key_bone',
    name: 'کلید استخوانی', hidden: 'desk_study' },
  { id: 'note_study',     room: 'study',     x: 53.0, y: 23.0, spr: 'note',    kind: 'note',   story: 'note_study',
    name: 'صفحه‌های آخر' },

  // --- corridor2
  { id: 'door_corr2_base',room: 'corridor2', x: 27.0, y: 30.4, spr: 'door',    kind: 'door',   story: null,
    name: 'در آهنی', door: 'corr2_basement' },

  // --- basement
  { id: 'blood_base',     room: 'basement',  x: 30.0, y: 28.0, spr: 'blood',   kind: 'look',   story: 'blood_basement',
    name: 'نشانه روی دیوار' },
  { id: 'crate_base',     room: 'basement',  x: 42.0, y: 28.0, spr: 'crate',   kind: 'crate',  story: 'crate_base' },
  { id: 'altar',          room: 'basement',  x: 36.0, y: 33.0, spr: 'altar',   kind: 'altar',  story: 'altar' },
  { id: 'door_base_crypt',room: 'basement',  x: 45.2, y: 32.4, spr: 'door',    kind: 'door',   story: null,
    name: 'در استخوانی', door: 'basement_crypt' },

  // --- crypt
  { id: 'altar_crypt',    room: 'crypt',     x: 52.0, y: 31.0, spr: 'altar',   kind: 'finale', story: 'finale' },
  { id: 'flesh_crypt',    room: 'crypt',     x: 55.0, y: 35.0, spr: 'flesh',   kind: 'look',   story: 'flesh_crypt',
    name: 'چیزی که تکان می‌خورد' },
];

/* Build the static collision grid once.
   Every room contributes a hollow box, then each door punches a hole through
   every wall tile it covers. */
function buildGrid() {
  const W = 64, H = 40;
  const grid = [];
  for (let y = 0; y < H; y++) grid.push(new Array(W).fill('#'));

  for (const id in ROOMS) {
    const r = ROOMS[id];
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (y < 0 || y >= H || x < 0 || x >= W) continue;
        const edge = (x === r.x || x === r.x + r.w - 1 || y === r.y || y === r.y + r.h - 1);
        grid[y][x] = edge ? '#' : '.';
      }
    }
  }
  for (const d of DOORS) {
    for (let y = d.y; y < d.y + d.h; y++) {
      for (let x = d.x; x < d.x + d.w; x++) {
        if (y < 0 || y >= H || x < 0 || x >= W) continue;
        // Only open a hole where there is actually a wall to open. Writing over
        // floor would silently carve a passage through a room interior.
        if (grid[y][x] === '#') grid[y][x] = d.open ? 'd' : 'D';
      }
    }
  }
  return { grid, W, H };
}

const WORLD = buildGrid();

function roomIdAtTile(tx, ty) {
  for (const id in ROOMS) {
    const r = ROOMS[id];
    if (tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) return id;
  }
  return null;
}

function isWall(tx, ty) {
  const { grid, W, H } = WORLD;
  if (ty < 0 || ty >= H || tx < 0 || tx >= W) return true;
  const t = grid[ty][tx];
  return t === '#' || t === 'D';   // locked doors block until unlocked
}

/* Soft-lock guard. Flood-fills from the spawn. This is the single most valuable
   automated check on a level: an unreachable room or a key stored behind its own
   lock makes the game unfinishable, which is the worst class of bug to ship. */
function validateWorld() {
  const problems = [];
  const { grid, W, H } = WORLD;
  const PASSABLE = (t) => t === '.' || t === 'd';

  // 1. Objects must sit inside the room they declare.
  for (const o of OBJECTS) {
    const rid = roomIdAtTile(Math.floor(o.x), Math.floor(o.y));
    if (!rid) problems.push(`object ${o.id} at (${o.x},${o.y}) is not inside any room`);
    else if (rid !== o.room) problems.push(`object ${o.id} declares room '${o.room}' but sits in '${rid}'`);
  }

  const flood = (passable) => {
    const seen = new Set(['2,2']);
    const q = [[2, 2]];
    while (q.length) {
      const [x, y] = q.shift();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
        if (seen.has(k)) continue;
        if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
        if (!passable(grid[ny][nx])) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    return seen;
  };

  // 2. Geometry connectivity: treat locked doors as passable, so this proves the
  //    map is one connected body and separates "unreachable" from "locked".
  const reachAll = flood((t) => PASSABLE(t) || t === 'D');
  for (const id in ROOMS) {
    const r = ROOMS[id];
    const cx = Math.floor(r.x + r.w / 2), cy = Math.floor(r.y + r.h / 2);
    if (!reachAll.has(cx + ',' + cy)) problems.push(`room '${id}' centre (${cx},${cy}) is unreachable — a doorway is not cutting through both walls`);
  }
  for (const o of OBJECTS) {
    const k = Math.floor(o.x) + ',' + Math.floor(o.y);
    if (!reachAll.has(k)) problems.push(`object ${o.id} stands on an unreachable tile (${k})`);
  }

  // 3. Progression: with locked doors CLOSED, every key must be obtainable.
  //    This is what catches "the key is behind the door it opens".
  const reachOpen = flood(PASSABLE);
  for (const d of DOORS) {
    if (d.open || !d.lock) continue;
    const keyObj = OBJECTS.find((o) => o.item === d.lock);
    if (!keyObj) { problems.push(`door ${d.id} needs '${d.lock}' but no such item exists`); continue; }
    let host = keyObj;
    if (keyObj.hidden) {
      const c = OBJECTS.find((o) => o.id === keyObj.hidden);
      if (!c) problems.push(`item ${keyObj.id} claims container '${keyObj.hidden}' which does not exist`);
      else host = c;
    }
    const hk = Math.floor(host.x) + ',' + Math.floor(host.y);
    if (!reachOpen.has(hk)) {
      problems.push(`key '${d.lock}' for door ${d.id} is behind a locked door (${hk}) — soft-lock`);
    }
  }

  // 4. Every door must actually connect two different rooms, or it is decorative
  //    and the level has a dead connection.
  for (const d of DOORS) {
    const touches = new Set();
    for (let y = d.y - 1; y <= d.y + d.h; y++) {
      for (let x = d.x - 1; x <= d.x + d.w; x++) {
        const rid = roomIdAtTile(x, y);
        if (rid) touches.add(rid);
      }
    }
    if (touches.size < 2) {
      problems.push(`door ${d.id} touches ${touches.size} room(s) (${[...touches].join(',') || 'none'}) — it connects nothing`);
    }
  }

  return problems;
}
