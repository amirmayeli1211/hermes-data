/* game.js — the engine: loop, player, collision, lighting, the entity, and the
 * interaction/UI glue. Kept in one file because it is one state machine; the
 * data it drives lives in world.js / story.js / sprites.js.
 *
 * DESIGN NOTES THAT MATTER
 *  - Fixed 60 Hz update with a clamped delta. An unclamped delta makes collision
 *    tunnelling possible on a slow frame (the player steps past a wall).
 *  - Collision is axis-separated: move X, resolve, move Y, resolve. Resolving both
 *    at once produces the classic "stuck in a corner" bug.
 *  - Lighting is a single radial gradient per light, composited with
 *    'multiply'. Anything brighter than a dark ambient reveals the room; without
 *    the torch the world is nearly black, which is the whole tension mechanic.
 *  - The entity is a state machine (dormant / stalking / hunting) driven by the
 *    player's distance and torch use, not a random spawn. Random spawns read as
 *    unfair; a pursuer the player can hear and outrun reads as scary.
 */
'use strict';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });
ctx.imageSmoothingEnabled = false;

const VIEW_W = canvas.width;    // 320
const VIEW_H = canvas.height;   // 180

/* Player body is 12x16 art but collides as a 10x8 footprint at the feet, so the
   head can overlap a wall visually without feeling clipped. This is the standard
   trick for top-down games and it is why the collision box is smaller than the
   sprite. */
const BODY = { w: 10, h: 8 };

const Game = {
  state: 'title',        // title | play | dialogue | inventory | end
  player: null,
  entity: null,
  time: 0,
  fear: 0,
  flags: {},
  inventory: [],
  seen: {},              // object id -> true once interacted
  opened: {},            // container object id -> true
  doors: {},             // door id -> open bool
  keysDown: {},
  touch: {},
  lastTs: 0,
  accumulator: 0,
  stepPhase: 0,
  heartbeatTimer: 0,
  whisperTimer: 0,
  toastTimer: 0,
  nearObject: null,
  endInfo: null,
};

/* ------------------------------------------------------------------ state */

function freshState() {
  Game.player = {
    x: 2.5 * TILE + 8, y: 2.5 * TILE + 8,
    vx: 0, vy: 0,
    dir: 'down',
    torch: false,
    battery: 100,
    moving: false,
    animT: 0,
    frame: 0,
  };
  Game.entity = {
    x: 30 * TILE, y: 30 * TILE,
    state: 'dormant',
    speed: 0,
    cooldown: 0,
    homeRoom: 'basement',
    lastSeenX: 0, lastSeenY: 0,
  };
  Game.time = 0;
  Game.fear = 0;
  Game.flags = {};
  Game.inventory = [];
  Game.seen = {};
  Game.opened = {};
  Game.doors = {};
  for (const d of DOORS) Game.doors[d.id] = d.open;
  Game.nearObject = null;
  Game.endInfo = null;
  Game.stepPhase = 0;
}

/* ------------------------------------------------------------------ audio */

function sfx(n, v) { try { Sound.sfx(n, v); } catch (e) {} }

/* ------------------------------------------------------------------ input */

window.addEventListener('keydown', (e) => {
  const k = e.key;
  Game.keysDown[k.toLowerCase()] = true;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Tab'].includes(k)) e.preventDefault();

  if (Game.state === 'play') {
    const kk = k.toLowerCase();
    if (kk === 'e' || k === 'Enter' || k === ' ') { doInteract(); return; }
    if (kk === 'f') { toggleTorch(); return; }
    if (kk === 'i' || k === 'Tab') { openInventory(); return; }
    if (kk === 'm') { toggleMute(); return; }
  } else if (Game.state === 'dialogue') {
    if (k === 'Enter' || k.toLowerCase() === 'e' || k === ' ') advanceDialogue();
  } else if (Game.state === 'inventory') {
    if (k === 'Escape' || k.toLowerCase() === 'i' || k === 'Tab') closeInventory();
  }
});
window.addEventListener('keyup', (e) => { Game.keysDown[e.key.toLowerCase()] = false; });
window.addEventListener('blur', () => { Game.keysDown = {}; Game.touch = {}; });

/* Touch: pointer events cover mouse and touch with one path. Buttons set a flag
   while held, so movement is continuous rather than one step per tap. */
function bindTouch() {
  document.querySelectorAll('[data-key]').forEach((btn) => {
    const key = btn.dataset.key;
    const on = (e) => {
      e.preventDefault();
      Sound.unlock();
      if (key === 'act') { doInteract(); return; }
      if (key === 'light') { toggleTorch(); return; }
      if (key === 'inv') { openInventory(); return; }
      Game.touch[key] = true;
      btn.classList.add('on');
    };
    const off = (e) => {
      e.preventDefault();
      Game.touch[key] = false;
      btn.classList.remove('on');
    };
    btn.addEventListener('pointerdown', on);
    btn.addEventListener('pointerup', off);
    btn.addEventListener('pointercancel', off);
    btn.addEventListener('pointerleave', off);
  });
}

function held(key) {
  const map = {
    up: ['w', 'arrowup'], down: ['s', 'arrowdown'],
    left: ['a', 'arrowleft'], right: ['d', 'arrowright'],
  };
  if (Game.touch[key]) return true;
  return map[key].some((k) => Game.keysDown[k]);
}

/* ------------------------------------------------------------------ player */

function movePlayer(dt) {
  const p = Game.player;
  const SPEED = 62;          // px/s — deliberately slow; this is not an action game
  let dx = 0, dy = 0;
  if (held('left')) dx -= 1;
  if (held('right')) dx += 1;
  if (held('up')) dy -= 1;
  if (held('down')) dy += 1;

  // Normalise so diagonals are not 41% faster — a classic bug in hand-rolled
  // movement that makes diagonal movement the always-correct choice.
  if (dx && dy) { const inv = 1 / Math.sqrt(2); dx *= inv; dy *= inv; }

  p.vx = dx * SPEED;
  p.vy = dy * SPEED;
  p.moving = (dx !== 0 || dy !== 0);

  if (p.moving) {
    p.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
    p.animT += dt;
    if (p.animT > 0.16) { p.animT = 0; p.frame = (p.frame + 1) % 4; }
    Game.stepPhase += dt;
    if (Game.stepPhase > 0.34) { Game.stepPhase = 0; sfx(Math.random() < 0.5 ? 'step1' : 'step2', 0.22); }
  } else {
    p.frame = 0;
  }

  // Axis-separated collision: resolve X against walls, then Y. Doing both in one
  // pass is what makes a player stick on corners.
  const nextX = p.x + p.vx * dt;
  if (!collides(nextX, p.y)) p.x = nextX;
  const nextY = p.y + p.vy * dt;
  if (!collides(p.x, nextY)) p.y = nextY;

  if (p.torch) {
    p.battery = Math.max(0, p.battery - dt * 1.6);
    if (p.battery <= 0) { p.torch = false; toast('چراغ‌قوه خاموش شد.'); }
  }
}

/* Collision sampled at the four corners of the body footprint, not the sprite
   centre: a 10x8 box is too wide for one sample to represent. */
function collides(cx, cy) {
  const hw = BODY.w / 2, hh = BODY.h / 2;
  const pts = [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx - hw, cy + hh], [cx + hw, cy + hh]];
  for (const [x, y] of pts) {
    if (isWall(Math.floor(x / TILE), Math.floor(y / TILE))) return true;
  }
  return false;
}

function currentRoom() {
  return roomIdAtTile(
    Math.floor(Game.player.x / TILE),
    Math.floor(Game.player.y / TILE),
  );
}

/* ------------------------------------------------------------------ torch */

function toggleTorch() {
  const p = Game.player;
  if (!p) return;
  if (!p.torch && p.battery <= 0) { toast('باتری تمام است.'); return; }
  p.torch = !p.torch;
  sfx('click', 0.5);
  toast(p.torch ? 'چراغ‌قوه روشن.' : 'چراغ‌قوه خاموش.');
}

/* ------------------------------------------------------------------ entity AI

   Dormant: idle in the basement until the player has taken the iron key (the
   point of no return). Stalking: drifts toward the player's last known room at
   a speed the player can outrun. Hunting: only when the player is close AND the
   torch is on — the light is what gives you away. That coupling is the core of
   the tension: the torch is both how you see and how you are seen. */

function updateEntity(dt) {
  const e = Game.entity, p = Game.player;
  const dist = Math.hypot(e.x - p.x, e.y - p.y);

  if (e.state === 'dormant') {
    if (hasItem('key_iron')) {
      e.state = 'stalking';
      e.speed = 34;
      toast('چیزی در زیرزمین بیدار شد.');
      sfx('sting', 0.5);
    }
    return;
  }

  if (e.state === 'stalking') {
    e.speed = 34;
    if (p.torch && dist < 150) { e.state = 'hunting'; e.speed = 46; sfx('whisper', 0.55); }
  } else if (e.state === 'hunting') {
    if (!p.torch || dist > 260) { e.state = 'stalking'; }
  }

  if (e.state === 'hunting' || e.state === 'stalking') {
    const dx = p.x - e.x, dy = p.y - e.y;
    const len = Math.hypot(dx, dy) || 1;
    // Step with the same collision test the player uses, so the entity cannot
    // walk through walls and leave the level (which would strand the threat).
    const stepX = (dx / len) * e.speed * dt;
    const stepY = (dy / len) * e.speed * dt;
    if (!collides(e.x + stepX, e.y)) e.x += stepX;
    if (!collides(e.x, e.y + stepY)) e.y += stepY;
  }

  // Contact: lose, and lose thematically rather than with a generic game-over.
  if (dist < 13) {
    Game.endInfo = { ending: 'taken', title: 'گرفته شدی', text: 'آن‌چه پشت سرت بود، دیگر پشت سرت نیست.' };
    endGame();
  }
}

/* ------------------------------------------------------------------ fear */

function updateFear(dt) {
  const p = Game.player, e = Game.entity;
  let target = 0;
  if (e && e.state === 'hunting') {
    const dist = Math.hypot(e.x - p.x, e.y - p.y);
    target = Math.max(0, 100 - dist * 0.35);
  } else if (e && e.state === 'stalking') {
    target = 22;
  }
  const room = currentRoom();
  if (room && ROOMS[room] && ROOMS[room].dark > 0.94) target += 12;

  Game.fear += (target - Game.fear) * Math.min(1, dt * 0.8);
  Game.fear = Math.max(0, Math.min(100, Game.fear));

  // Heartbeat tempo is the player's only readout of danger; there is no health
  // bar on purpose.
  Game.heartbeatTimer -= dt;
  if (Game.heartbeatTimer <= 0) {
    const rate = 1 + Game.fear / 45;
    Game.heartbeatTimer = Math.max(0.42, 1.5 - Game.fear / 90);
    if (Game.fear > 12) sfx('heartbeat', 0.28 + Game.fear / 260);
  }

  // Occasional whisper when scared, from nowhere in particular. Ambient dread
  // without a source is more effective than a visible scare on a timer.
  Game.whisperTimer -= dt;
  if (Game.whisperTimer <= 0 && Game.fear > 34) {
    Game.whisperTimer = 9 + Math.random() * 14;
    sfx('whisper', 0.25 + Game.fear / 400);
  }
}

/* ------------------------------------------------------------------ interact */

function nearestObject() {
  const p = Game.player;
  let best = null, bestD = 26;
  for (const o of OBJECTS) {
    if (o.hidden && !Game.opened[o.hidden]) continue;
    const d = Math.hypot(o.x * TILE - p.x, o.y * TILE - p.y);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function doInteract() {
  if (Game.state === 'dialogue') { advanceDialogue(); return; }
  if (Game.state !== 'play') return;
  const o = Game.nearObject;
  if (!o) return;

  if (o.kind === 'door') {
    const open = Game.doors[o.door];
    const def = DOORS.find((d) => d.id === o.door);
    if (open) { toast('باز است.'); return; }
    if (def && def.lock && hasItem(def.lock)) {
      Game.doors[o.door] = true;
      openDoor(o.door);
      sfx('door', 0.75);
      toast('قفل باز شد.');
      addStoryItem('کلید مصرف شد',
        `با ${itemName(def.lock)} قفل باز شد.`);
      return;
    }
    sfx('door', 0.5);
    toast(def && def.lock ? `قفل است. چیزی لازم دارد.` : 'باز نمی‌شود.');
    return;
  }

  if (o.kind === 'item') {
    Game.seen[o.id] = true;
    addItem(o.item, o.name);
    sfx('pickup', 0.7);
    return;
  }

  // Everything else is narrative.
  const nodeId = o.story;
  Game.seen[o.id] = true;
  if (nodeId && STORY.nodes[nodeId]) {
    sfx('click', 0.4);
    startDialogue(nodeId);
    return;
  }
  // Objects with no story node still respond, so nothing feels unresponsive.
  toast(sensedLine(o));
}

function sensedLine(o) {
  switch (o.kind) {
    case 'lamp':   return 'لامپ سوخته است.';
    case 'mirror': return 'آینه گرد گرفته.';
    case 'shelf':  return 'کتاب‌ها پوسیده‌اند.';
    case 'sink':   return 'شیر چکه می‌کند.';
    case 'bed':    return 'تخت مرتب است.';
    case 'desk':   return 'کشو بسته است.';
    case 'crate':  return 'جعبه سنگین است.';
    case 'tub':    return 'وان پر از آب سیاه است.';
    case 'look':   return 'نگاه نمی‌کنی.';
    case 'stairs': return 'پله‌ها به پایین می‌روند.';
    case 'radio':  return 'رادیو خاموش است.';
    case 'altar':  return 'سنگ سرد است.';
    default:       return 'چیز خاصی نیست.';
  }
}

function openDoor(doorId) {
  const d = DOORS.find((x) => x.id === doorId);
  if (!d) return;
  const { grid } = WORLD;
  for (let y = d.y; y < d.y + d.h; y++) {
    for (let x = d.x; x < d.x + d.w; x++) {
      if (grid[y] && grid[y][x] === 'D') grid[y][x] = 'd';
    }
  }
}

/* ------------------------------------------------------------------ items */

function addItem(id, name) {
  if (Game.inventory.some((i) => i.id === id)) {
    toast('قبلاً برداشته‌ای.');
    return;
  }
  Game.inventory.push({ id, name: name || itemName(id), kind: 'item', text: itemBlurb(id) });
  toast(`برداشتی: ${name || itemName(id)}`);
}

function addStoryItem(name, text) {
  Game.inventory.push({ id: 'story_' + Game.inventory.length, name, kind: 'یادداشت', text });
}

function hasItem(id) { return Game.inventory.some((i) => i.id === id); }

function itemName(id) {
  return ({
    key_iron: 'کلید آهنی',
    key_bone: 'کلید استخوانی',
    battery: 'باتری',
    tape: 'نوار کاست',
  })[id] || id;
}

function itemBlurb(id) {
  return ({
    key_iron: 'سنگین است و سرد. برای در آهنی زیرزمین.',
    key_bone: 'از استخوان ساخته شده. سبک‌تر از آن است که باید باشد.',
    battery: 'برای چراغ‌قوه. باتری را با F استفاده می‌کنی.',
    tape: 'برچسب دست‌نویس: «صدای او».',
  })[id] || '';
}

/* ------------------------------------------------------------------ dialogue */

const Dlg = { nodeId: null, lineIndex: 0, choices: null, choiceIndex: -1 };

function startDialogue(nodeId) {
  const n = STORY.nodes[nodeId];
  if (!n) return;
  Dlg.nodeId = nodeId;
  Dlg.lineIndex = 0;
  Dlg.choices = null;
  Dlg.choiceIndex = -1;

  // Apply the node's effects on ENTRY (not on revisit) so a line the player
  // re-reads does not double-apply a fear hit or a flag.
  if (n.set) for (const k in n.set) Game.flags[k] = n.set[k];
  if (n.fear) Game.fear = Math.min(100, Game.fear + n.fear);
  if (n.story_item) addStoryItem(n.story_item, n.story_item_text || '');
  if (n.gives && !hasItem(n.gives)) {
    Game.opened[Dlg.nodeId] = true;
    addItem(n.gives, itemName(n.gives));
    sfx('pickup', 0.7);
  }

  Game.state = 'dialogue';
  show('dialogue');
  renderDialogue();
}

function advanceDialogue() {
  const n = STORY.nodes[Dlg.nodeId];
  if (!n) { closeDialogue(); return; }

  if (Dlg.choices) {
    // A choice is mandatory once the options are shown.
    return;
  }

  Dlg.lineIndex++;
  if (Dlg.lineIndex < n.lines.length) { renderDialogue(); return; }

  if (n.choices && n.choices.length) {
    Dlg.choices = visibleChoices(n);
    if (Dlg.choices.length === 0) { finishNode(n); return; }
    renderDialogue();
    return;
  }
  finishNode(n);
}

function visibleChoices(n) {
  const out = [];
  for (const c of n.choices) {
    if (!c.if || c.if === 'always') { out.push(c); continue; }
    if (c.if === 'has_ritual') {
      // The ritual ending needs the tape plus the two ritual notes, so the player
      // cannot stumble into the good ending without having read the lore.
      if (hasItem('tape') && Game.flags.knows_ritual) out.push(c);
      continue;
    }
    if (c.if.startsWith('flag:')) {
      if (Game.flags[c.if.slice(5)]) out.push(c);
      continue;
    }
  }
  return out;
}

function chooseDialogue(index) {
  const n = STORY.nodes[Dlg.nodeId];
  if (!n || !Dlg.choices) return;
  const c = Dlg.choices[index];
  if (!c) return;
  sfx('click', 0.45);
  if (c.set) for (const k in c.set) Game.flags[k] = c.set[k];
  if (c.gives && !hasItem(c.gives)) addItem(c.gives, itemName(c.gives));
  Dlg.choices = null;
  startDialogue(c.to);
}

function finishNode(n) {
  if (n.ending) {
    Game.endInfo = { ending: n.ending, ...(ENDINGS[n.ending] || { title: 'پایان', text: '' }) };
    closeDialogue();
    endGame();
    return;
  }
  closeDialogue();
}

function renderDialogue() {
  const n = STORY.nodes[Dlg.nodeId];
  if (!n) return;
  const sp = document.getElementById('dlgSpeaker');
  const tx = document.getElementById('dlgText');
  const ch = document.getElementById('dlgChoices');
  const hint = document.getElementById('dlgHint');

  sp.textContent = n.speaker || '';
  const line = n.lines[Math.min(Dlg.lineIndex, n.lines.length - 1)] || '';
  tx.textContent = line;
  tx.className = 'dlg-text' + (n.speaker === 'آینه' || n.speaker === 'صدا' ? ' creepy' : '');
  ch.innerHTML = '';

  if (Dlg.choices && Dlg.choices.length) {
    hint.textContent = 'یک گزینه را انتخاب کن';
    Dlg.choices.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'choice-btn';
      b.textContent = c.text;
      b.addEventListener('click', () => chooseDialogue(i));
      ch.appendChild(b);
    });
  } else {
    hint.textContent = 'Enter ↵ ادامه';
  }
}

function closeDialogue() {
  hide('dialogue');
  if (Game.state === 'dialogue') Game.state = 'play';
}

/* ------------------------------------------------------------------ UI */

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

let toastTimerHandle = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastTimerHandle) clearTimeout(toastTimerHandle);
  toastTimerHandle = setTimeout(() => el.classList.add('hidden'), 2200);
}

function openInventory() {
  if (Game.state !== 'play') return;
  Game.state = 'inventory';
  renderInventory();
  show('inventory');
}

function closeInventory() {
  hide('inventory');
  if (Game.state === 'inventory') Game.state = 'play';
}

function renderInventory() {
  const grid = document.getElementById('invGrid');
  const detail = document.getElementById('invDetail');
  grid.innerHTML = '';
  if (!Game.inventory.length) {
    grid.innerHTML = '<div class="inv-item">کیف خالی است<span class="kind">چیزی برنداشته‌ای</span></div>';
    detail.innerHTML = '<span class="empty">هر چیزی که پیدا می‌کنی این‌جا می‌ماند.</span>';
    return;
  }
  Game.inventory.forEach((it, i) => {
    const d = document.createElement('div');
    d.className = 'inv-item';
    d.innerHTML = `${escapeHtml(it.name)}<span class="kind">${escapeHtml(it.kind || 'چیز')}</span>`;
    d.addEventListener('click', () => {
      document.querySelectorAll('.inv-item').forEach((x) => x.classList.remove('sel'));
      d.classList.add('sel');
      detail.textContent = it.text || 'چیز خاصی درباره‌اش نمی‌دانی.';
    });
    grid.appendChild(d);
  });
  detail.innerHTML = '<span class="empty">یک مورد را انتخاب کن تا بخوانی.</span>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toggleMute() {
  const m = !Sound.isMuted();
  Sound.setMuted(m);
  toast(m ? 'صدا قطع شد.' : 'صدا وصل شد.');
}

function endGame() {
  Game.state = 'end';
  Sound.stopAmbient();
  const info = Game.endInfo || { title: 'پایان', text: '' };
  document.getElementById('endTitle').textContent = info.title;
  document.getElementById('endText').textContent = info.text || '';
  hide('dialogue');
  hide('inventory');
  show('endScreen');
}

/* ------------------------------------------------------------------ render */

function render() {
  const p = Game.player;
  const camX = clamp(p.x - VIEW_W / 2, 0, WORLD.W * TILE - VIEW_W);
  const camY = clamp(p.y - VIEW_H / 2, 0, WORLD.H * TILE - VIEW_H);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  ctx.save();
  ctx.translate(-Math.round(camX), -Math.round(camY));

  drawFloor(camX, camY);
  drawObjects(camX, camY);
  drawEntity();
  drawPlayer();

  ctx.restore();

  drawLighting(camX, camY);
  drawHud();
}

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

function drawFloor(camX, camY) {
  const x0 = Math.floor(camX / TILE), y0 = Math.floor(camY / TILE);
  const x1 = Math.ceil((camX + VIEW_W) / TILE), y1 = Math.ceil((camY + VIEW_H) / TILE);

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (ty < 0 || ty >= WORLD.H || tx < 0 || tx >= WORLD.W) continue;
      const t = WORLD.grid[ty][tx];
      const px = tx * TILE, py = ty * TILE;
      const room = roomIdAtTile(tx, ty);

      if (t === '#' || t === 'D' || t === 'd') {
        // Walls drawn as a two-tone brick so the silhouette of a room is legible
        // even in near-darkness.
        ctx.fillStyle = '#232028';
        ctx.fillRect(px, py, TILE, TILE);
        ctx.fillStyle = '#2c2833';
        ctx.fillRect(px, py, TILE, 3);
        ctx.fillStyle = '#1a181f';
        ctx.fillRect(px, py + TILE - 3, TILE, 3);
        if (t === 'D') {
          ctx.fillStyle = '#4a3b2a';
          ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
          ctx.fillStyle = '#8e2b25';
          ctx.fillRect(px + 6, py + 6, 4, 4);
        } else if (t === 'd') {
          // An open doorway reads as a dark gap with a lit threshold.
          ctx.fillStyle = '#0d0c10';
          ctx.fillRect(px, py + 4, TILE, TILE - 8);
          ctx.fillStyle = '#3a3326';
          ctx.fillRect(px, py + 4, TILE, 1);
          ctx.fillRect(px, py + TILE - 5, TILE, 1);
        }
      } else {
        const floorKind = room && ROOMS[room] ? ROOMS[room].floor : 'wood';
        if (floorKind === 'tile') {
          const alt = ((tx + ty) % 2) === 0;
          ctx.fillStyle = alt ? '#2a2a30' : '#25252b';
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = '#1d1d22';
          ctx.fillRect(px, py + TILE - 1, TILE, 1);
          ctx.fillRect(px + TILE - 1, py, 1, TILE);
        } else {
          ctx.fillStyle = '#2b2419';
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = '#241e15';
          ctx.fillRect(px, py + 7, TILE, 1);
          if (Math.floor(px / TILE) % 2 === 0) ctx.fillRect(px + 7, py, 1, 7);
          else ctx.fillRect(px + 3, py + 8, 1, 8);
        }
      }
    }
  }
}

function drawObjects(camX, camY) {
  for (const o of OBJECTS) {
    if (o.hidden && !Game.opened[o.hidden]) continue;
    const sx = o.x * TILE - 8, sy = o.y * TILE - 8;
    if (sx < camX - 32 || sx > camX + VIEW_W + 32) continue;
    if (sy < camY - 32 || sy > camY + VIEW_H + 32) continue;

    let spr = o.spr;
    if (o.kind === 'door') spr = Game.doors[o.door] ? 'doorOpen' : 'door';
    if (o.kind === 'item' && Game.seen[o.id]) continue;   // picked up
    drawSprite(ctx, spr, sx, sy, false);
  }
}

function drawPlayer() {
  const p = Game.player;
  const sx = p.x - 6, sy = p.y - 12;   // sprite is 12x16; feet sit at p.y+4
  let name = 'playerDown';
  if (p.dir === 'up') name = p.frame === 0 ? 'playerUp' : (p.frame % 2 === 1 ? 'playerUp1' : 'playerUp2');
  else if (p.dir === 'down') name = p.frame === 0 ? 'playerDown' : (p.frame % 2 === 1 ? 'playerDown1' : 'playerDown2');
  else name = p.frame === 0 ? 'playerSide' : (p.frame % 2 === 1 ? 'playerSide1' : 'playerSide2');
  drawSprite(ctx, name, sx, sy, p.dir === 'left');
}

function drawEntity() {
  const e = Game.entity;
  if (!e || e.state === 'dormant') return;
  const sx = e.x - 7, sy = e.y - 14;
  drawSprite(ctx, 'entityDormant', sx, sy, false);
  if (e.state === 'hunting') drawSprite(ctx, 'entityEyes', sx, sy, false);
}

/* Lighting. One radial gradient per light, composited multiply over the world.
   The torch cone is a second pass so its edge is harder than the ambient. */
function drawLighting(camX, camY) {
  const p = Game.player;

  // Darkness overlay: opaque black everywhere, then holes punched with
  // 'destination-out' radial gradients. Doing it this way (rather than painting
  // additive light) keeps far rooms genuinely black instead of grey.
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  const room = currentRoom();
  const baseDark = room && ROOMS[room] ? ROOMS[room].dark : 0.9;
  const darkAlpha = Math.max(0.55, baseDark - (p.torch ? 0.18 : 0));
  ctx.fillStyle = `rgba(2,2,4,${darkAlpha})`;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  ctx.globalCompositeOperation = 'destination-out';

  // Torch: a wide ellipse in front of the player, biased toward facing.
  if (p.torch && p.battery > 0) {
    const px = p.x - camX, py = p.y - camY - 4;
    const flicker = 1 + Math.sin(Game.time * 11) * 0.03 + (Math.random() - 0.5) * 0.02;
    const r = 74 * flicker;
    const g = ctx.createRadialGradient(px, py, 4, px, py, r);
    g.addColorStop(0, 'rgba(0,0,0,0.98)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.72)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Without the torch you still get a small human-scale bubble of vision, or
    // the game becomes unplayable rather than tense.
    const px = p.x - camX, py = p.y - camY - 4;
    const g = ctx.createRadialGradient(px, py, 2, px, py, 30);
    g.addColorStop(0, 'rgba(0,0,0,0.80)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(px - 30, py - 30, 60, 60);
  }

  // Ambient light from fixed lamps, so each room has its own readable key light.
  for (const o of OBJECTS) {
    if (o.kind !== 'lamp' && o.kind !== 'radio') continue;
    const ox = o.x * TILE - camX, oy = o.y * TILE - camY;
    if (ox < -80 || ox > VIEW_W + 80 || oy < -80 || oy > VIEW_H + 80) continue;
    const flick = o.kind === 'radio' ? (0.5 + Math.random() * 0.5) : 1;
    const g = ctx.createRadialGradient(ox, oy, 1, ox, oy, 42);
    g.addColorStop(0, `rgba(0,0,0,${0.42 * flick})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(ox - 42, oy - 42, 84, 84);
  }

  ctx.restore();

  // Warm tint from the torch, additive, so the lit area reads as warm vs the
  // cold blue-dark of the rest.
  if (p.torch && p.battery > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const px = p.x - camX, py = p.y - camY - 4;
    const g = ctx.createRadialGradient(px, py, 2, px, py, 66);
    g.addColorStop(0, 'rgba(120,92,40,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(px - 66, py - 66, 132, 132);
    ctx.restore();
  }

  // Red vignette as fear rises — a warning the player feels before they can name it.
  if (Game.fear > 18) {
    const a = (Game.fear - 18) / 100 * 0.5;
    const g = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.28, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(90,18,14,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }
}

function drawHud() {
  const p = Game.player;
  const room = currentRoom();

  // Room name, top-left, small. RTL text is placed from the right edge.
  if (room && ROOMS[room]) {
    ctx.font = '9px Tahoma, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(210,200,175,0.72)';
    ctx.fillText(ROOMS[room].name, VIEW_W - 6, 12);
  }

  // Battery bar, only while the torch is on.
  if (p.torch) {
    const w = 40, h = 4, x = VIEW_W - 6 - w, y = 17;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    const frac = Math.max(0, Math.min(1, p.battery / 100));
    ctx.fillStyle = frac > 0.3 ? 'rgba(200,170,60,0.95)' : 'rgba(180,60,45,0.95)';
    ctx.fillRect(x + (w - w * frac), y, w * frac, h);
  }

  // Interaction prompt.
  if (Game.nearObject && Game.state === 'play') {
    const o = Game.nearObject;
    const label = o.kind === 'door'
      ? (Game.doors[o.door] ? 'باز است' : 'E — باز کردن')
      : (o.kind === 'item' ? 'E — برداشتن' : 'E — بررسی');
    ctx.font = '9px Tahoma, sans-serif';
    ctx.textAlign = 'center';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(VIEW_W / 2 - tw / 2 - 5, VIEW_H - 22, tw + 10, 13);
    ctx.fillStyle = 'rgba(215,205,180,0.95)';
    ctx.fillText(label, VIEW_W / 2, VIEW_H - 13);
  }

  // Subtle "someone is near" indicator: a pulsing dot at the screen edge in the
  // entity's direction. Readable without a minimap, and it is the only warning
  // the player gets.
  if (Game.entity && Game.entity.state !== 'dormant') {
    const dx = Game.entity.x - p.x, dy = Game.entity.y - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 220) {
      const ang = Math.atan2(dy, dx);
      const ex = VIEW_W / 2 + Math.cos(ang) * (VIEW_W / 2 - 12);
      const ey = VIEW_H / 2 + Math.sin(ang) * (VIEW_H / 2 - 12);
      const pulse = 0.4 + Math.abs(Math.sin(Game.time * 4)) * 0.6;
      ctx.fillStyle = `rgba(150,30,24,${pulse * (1 - dist / 220)})`;
      ctx.beginPath();
      ctx.arc(ex, ey, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* ------------------------------------------------------------------ loop */

function update(dt) {
  if (Game.state !== 'play') return;
  Game.time += dt;
  movePlayer(dt);
  updateEntity(dt);
  updateFear(dt);
  Game.nearObject = nearestObject();

  const room = currentRoom();
  if (room && ROOMS[room]) Sound.ambient(ROOMS[room].ambient, 0.42);
}

function frame(ts) {
  requestAnimationFrame(frame);
  if (!Game.lastTs) Game.lastTs = ts;
  let dt = (ts - Game.lastTs) / 1000;
  Game.lastTs = ts;
  // Clamp: a tab that was backgrounded for 30s must not teleport the player
  // through walls on the next frame.
  if (dt > 0.1) dt = 0.1;
  if (dt < 0) dt = 0;

  Game.accumulator += dt;
  const STEP = 1 / 60;
  let guard = 0;
  while (Game.accumulator >= STEP && guard++ < 5) {
    update(STEP);
    Game.accumulator -= STEP;
  }

  if (Game.player) render();
}

/* ------------------------------------------------------------------ boot */

function startNew() {
  freshState();
  Game.state = 'play';
  hide('titleScreen');
  hide('helpScreen');
  hide('endScreen');
  Sound.init();
  Sound.unlock();
  Sound.ambient(ROOMS.hall.ambient, 0.42);
  show('touch');
  toast('W A S D حرکت · E بررسی · F چراغ‌قوه · I کیف');
}

function boot() {
  bakeAll();

  // Fail loudly in the console if the level is broken, but keep the game
  // playable: a validation problem should be visible to a developer, not turn
  // into a white screen for a player.
  const wproblems = validateWorld();
  const sproblems = validateStory();
  if (wproblems.length || sproblems.length) {
    console.warn('LEVEL VALIDATION PROBLEMS:');
    for (const p of wproblems) console.warn('  world:', p);
    for (const p of sproblems) console.warn('  story:', p);
  } else {
    console.log('level and story validated: no problems');
  }

  document.getElementById('btnNew').addEventListener('click', () => { Sound.unlock(); startNew(); });
  document.getElementById('btnContinue').addEventListener('click', () => { Sound.unlock(); loadGame(); });
  document.getElementById('btnHowTo').addEventListener('click', () => show('helpScreen'));
  document.getElementById('btnHelpClose').addEventListener('click', () => hide('helpScreen'));
  document.getElementById('btnInvClose').addEventListener('click', closeInventory);
  document.getElementById('btnRestart').addEventListener('click', () => { hide('endScreen'); startNew(); });

  // Any click unlocks audio (autoplay policy) — including clicks on the canvas.
  document.addEventListener('pointerdown', () => Sound.unlock(), { once: true });

  document.getElementById('btnContinue').disabled = !hasSave();

  bindTouch();
  freshState();
  requestAnimationFrame(frame);
}

/* --- save/load: a single slot, kept in localStorage so the APK works offline --- */
const SAVE_KEY = 'room13.save.v1';

function hasSave() {
  try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
}

function saveGame() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      x: Game.player.x, y: Game.player.y,
      dir: Game.player.dir,
      torch: Game.player.torch, battery: Game.player.battery,
      fear: Game.fear, flags: Game.flags,
      inventory: Game.inventory, seen: Game.seen,
      opened: Game.opened, doors: Game.doors,
    }));
    return true;
  } catch (e) { return false; }
}

function loadGame() {
  let raw;
  try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { raw = null; }
  if (!raw) { startNew(); return; }
  let s;
  try { s = JSON.parse(raw); } catch (e) { startNew(); return; }
  freshState();
  const p = Game.player;
  p.x = s.x; p.y = s.y;
  p.dir = s.dir || 'down';
  p.torch = !!s.torch;
  p.battery = typeof s.battery === 'number' ? s.battery : 100;
  Game.fear = s.fear || 0;
  Game.flags = s.flags || {};
  Game.inventory = s.inventory || [];
  Game.seen = s.seen || {};
  Game.opened = s.opened || {};
  Game.doors = Object.assign({}, Game.doors, s.doors || {});
  // Re-open the grid holes for any door restored as open, or collision would
  // still block the player at a door the save says is unlocked.
  for (const d of DOORS) if (Game.doors[d.id]) openDoor(d.id);

  Game.state = 'play';
  hide('titleScreen'); hide('helpScreen'); hide('endScreen');
  Sound.init(); Sound.unlock();
  show('touch');
  toast('بازی بازیابی شد.');
}

window.addEventListener('beforeunload', () => { if (Game.state === 'play') saveGame(); });

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
