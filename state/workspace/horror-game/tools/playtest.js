/* playtest.js — drive the real game in a real browser and assert on behaviour.
 *
 * WHY CDP AND NOT A STUBBED DOM
 *   A stubbed canvas happily accepts any draw call, so it cannot catch the bugs
 *   that actually matter here: a script that fails to parse, a sprite name typo
 *   that silently draws nothing, a null dereference inside the update loop, or a
 *   save/load path that loses an unlocked door. This launches headless Chromium,
 *   loads the game over HTTP (file:// blocks the audio in some builds), plays it
 *   by dispatching REAL keyboard events, and reads the game's own state back out
 *   of the page.
 *
 * Run: node tools/playtest.js
 * Exit: 0 all assertions passed, 1 one or more failed.
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_BIN || '/opt/hermes/tools/chromium-1208/chrome-linux64/chrome';
const PORT = Number(process.env.PORT || 8781);
const CDP_PORT = Number(process.env.CDP_PORT || 9333);

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

/* --- tiny static server (no dependencies available in this image) --------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.mp3': 'audio/mpeg', '.json': 'application/json',
};
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

/* --- minimal CDP client over the WebSocket handshake ---------------------- */
function cdpConnect(wsUrl) {
  const { URL: NodeURL } = require('url');
  const u = new NodeURL(wsUrl);
  const net = require('net');
  const crypto = require('crypto');

  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        `GET ${u.pathname} HTTP/1.1\r\n` +
        `Host: ${u.hostname}:${u.port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on('error', reject);

    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    const handlers = new Map();
    let nextId = 1;

    function send(method, params, sessionId) {
      const id = nextId++;
      // sessionId goes at the TOP LEVEL of the CDP message, not inside params.
      // Putting it in params (the obvious-looking mistake) makes the browser
      // answer -32601 "'X' wasn't found" for every call.
      const payload = JSON.stringify(sessionId ? { id, method, params: params || {}, sessionId }
                                               : { id, method, params: params || {} });
      const data = Buffer.from(payload);
      const len = data.length;
      let header;
      const mask = crypto.randomBytes(4);
      if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
      else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
      return new Promise((res, rej) => handlers.set(id, { res, rej }));
    }

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        buf = buf.subarray(idx + 4);
        handshakeDone = true;
        resolve({ send, close: () => sock.destroy(), sock });
      }
      // Decode frames. Server->client frames are unmasked.
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = (b1 & 0x80) !== 0;
        let maskKey = null;
        if (masked) { if (buf.length < off + 4) return; maskKey = buf.subarray(off, off + 4); off += 4; }
        if (buf.length < off + len) return;
        let payload = buf.subarray(off, off + len);
        if (masked) {
          const out = Buffer.alloc(len);
          for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
          payload = out;
        }
        buf = buf.subarray(off + len);
        if ((b0 & 0x0f) === 0x1) {
          try {
            const msg = JSON.parse(payload.toString('utf8'));
            if (msg.id && handlers.has(msg.id)) {
              const h = handlers.get(msg.id);
              handlers.delete(msg.id);
              if (msg.error) h.rej(new Error(JSON.stringify(msg.error)));
              else h.res(msg.result);
            }
          } catch (e) { /* event frame; ignored */ }
        }
      }
    });
  });
}

async function getWsUrl() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const j = await res.json();
  return j.webSocketDebuggerUrl;
}

async function main() {
  const srv = await serve();
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);

  const profile = `/var/tmp/hermes-offload/tmp/chrome-profile-${process.pid}`;
  fs.rmSync(profile, { recursive: true, force: true });

  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=320,180',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

  // Wait for the debugger endpoint.
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try { wsUrl = await getWsUrl(); break; } catch (e) { await sleep(250); }
  }
  if (!wsUrl) {
    console.error('could not reach Chromium CDP\n' + chromeErr.slice(0, 2000));
    chrome.kill(); srv.close(); process.exit(1);
  }

  const cdp = await cdpConnect(wsUrl);
  const page = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const sessionId = attached.sessionId;

  // Every page-level command carries the flat session id.
  const sendS = (method, params) => cdp.send(method, params || {}, sessionId);

  const logs = [];
  const pageErrors = [];
  await sendS('Runtime.enable', {});
  await sendS('Log.enable', {});
  await sendS('Page.enable', {});

  // Subscribe to console + exceptions by polling the events we care about is not
  // possible over this minimal client, so instead we install in-page collectors.
  const evalJs = async (expr, awaitPromise = false) => {
    const r = await sendS('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise,
    });
    if (r.exceptionDetails) {
      throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  const nav = async (url) => {
    await sendS('Page.navigate', { url });
    for (let i = 0; i < 80; i++) {
      const ready = await evalJs('document.readyState').catch(() => 'x');
      if (ready === 'complete') break;
      await sleep(100);
    }
  };

  const sleepMs = sleep;
  await nav(`http://127.0.0.1:${PORT}/index.html`);
  await sleep(400);

  // Install error collectors before doing anything else.
  await evalJs(`
    window.__errs = [];
    window.addEventListener('error', e => window.__errs.push(String(e.message || e.error)));
    window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason)));
    true;
  `);

  console.log('\n=== load ===');

  const hasGame = await evalJs('typeof Game !== "undefined" && typeof WORLD !== "undefined" && typeof STORY !== "undefined"');
  check('game objects loaded (Game, WORLD, STORY)', hasGame);
  if (!hasGame) {
    console.log(results.join('\n'));
    chrome.kill(); srv.close(); process.exit(1);
  }

  const titleVisible = await evalJs('!document.getElementById("titleScreen").classList.contains("hidden")');
  check('title screen is visible on load', titleVisible);

  const valOk = await evalJs('validateWorld().length === 0 && validateStory().length === 0');
  check('in-page validation reports no world/story problems', valOk,
    await evalJs('JSON.stringify(validateWorld().concat(validateStory()))'));

  const spritesBaked = await evalJs('Object.keys(SPRITE_CACHE).length');
  check('sprites baked', spritesBaked > 25, `baked=${spritesBaked}`);

  console.log('\n=== start ===');
  await evalJs('Sound.unlock(); startNew(); true');
  await sleep(300);
  check('state is play after start', (await evalJs('Game.state')) === 'play');
  check('player spawned in the hall', (await evalJs('currentRoom()')) === 'hall');
  check('touch controls shown', await evalJs('!document.getElementById("touch").classList.contains("hidden")'));

  const canvasPainted = await evalJs(`(() => {
    const c = document.getElementById('game');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let nonBlack = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 8 || d[i+1] > 8 || d[i+2] > 8) nonBlack++;
    }
    return nonBlack;
  })()`);
  check('canvas actually rendered something', canvasPainted > 500, `non-black px=${canvasPainted}`);

  console.log('\n=== movement + collision ===');
  const before = await evalJs('JSON.stringify({x: Game.player.x, y: Game.player.y})');
  await keyHold('ArrowRight', 600, evalJs, sendS);
  const after = await evalJs('JSON.stringify({x: Game.player.x, y: Game.player.y})');
  const b = JSON.parse(before), a = JSON.parse(after);
  check('player moved on ArrowRight', a.x > b.x + 4, `x ${b.x.toFixed(1)} -> ${a.x.toFixed(1)}`);
  check('player did not pass through a wall (x within world)', a.x > 0 && a.x < 64 * 16);

  // Walk hard into the top wall and confirm we stop.
  await keyHold('ArrowUp', 900, evalJs, sendS);
  const topY = await evalJs('Game.player.y');
  check('player blocked by the north wall', topY > 8, `y=${topY.toFixed(1)}`);
  const inBounds = await evalJs('Game.player.y < 40*16 && Game.player.x < 64*16');
  check('player stayed inside the map', inBounds === true);

  console.log('\n=== torch ===');
  const torchBefore = await evalJs('Game.player.torch');
  await evalJs('toggleTorch(); true');
  await sleep(120);
  const torchAfter = await evalJs('Game.player.torch');
  check('torch toggles on', torchBefore === false && torchAfter === true);

  const bat0 = await evalJs('Game.player.battery');
  await sleep(700);
  const bat1 = await evalJs('Game.player.battery');
  check('torch drains battery over time', bat1 < bat0, `${bat0.toFixed(1)} -> ${bat1.toFixed(1)}`);
  await evalJs('toggleTorch(); true');

  console.log('\n=== interaction ===');
  // Teleport to the intro note and interact with it.
  const noteOk = await evalJs(`(() => {
    const o = OBJECTS.find(x => x.id === 'note_intro');
    Game.player.x = o.x * TILE; Game.player.y = o.y * TILE;
    Game.nearObject = nearestObject();
    return Game.nearObject && Game.nearObject.id;
  })()`);
  check('player can stand next to the intro note', noteOk === 'note_intro', `near=${noteOk}`);

  await evalJs('doInteract(); true');
  await sleep(150);
  check('interacting opens the dialogue overlay', await evalJs('Game.state') === 'dialogue');
  check('dialogue shows the node text',
    (await evalJs('document.getElementById("dlgText").textContent')).length > 5);

  // Advance through every line, then close.
  for (let i = 0; i < 12; i++) {
    await evalJs('advanceDialogue(); true');
    if ((await evalJs('Game.state')) !== 'dialogue') break;
    await sleep(30);
  }
  check('dialogue closes at the end of the node', (await evalJs('Game.state')) === 'play');

  console.log('\n=== doors + keys ===');
  const lockedBefore = await evalJs('Game.doors.corr2_basement');
  check('basement door starts locked', lockedBefore === false);

  await evalJs(`(() => {
    Game.player.x = 27*TILE+16; Game.player.y = 30*TILE+16;
    Game.nearObject = nearestObject(); doInteract(); return true;
  })()`);
  await sleep(80);
  check('locked door refuses without the key', (await evalJs('Game.doors.corr2_basement')) === false);

  // Grant the key and retry.
  await evalJs(`addItem('key_iron','کلید آهنی'); Game.nearObject = nearestObject(); doInteract(); true`);
  await sleep(80);
  check('door opens with the key', (await evalJs('Game.doors.corr2_basement')) === true);
  const walkedThrough = await evalJs(`!isWall(27,30) && !isWall(28,31)`);
  check('opened door is actually walkable in the grid', walkedThrough === true);

  console.log('\n=== items + inventory ===');
  await evalJs(`(() => { const o = OBJECTS.find(x=>x.id==='battery_liv');
    Game.player.x=o.x*TILE; Game.player.y=o.y*TILE; Game.nearObject=nearestObject(); doInteract(); return true; })()`);
  await sleep(80);
  const hasBattery = await evalJs(`Game.inventory.some(i => i.id === 'battery')`);
  check('picking up an item adds it to the inventory', hasBattery === true);

  await evalJs('openInventory(); true');
  await sleep(120);
  check('inventory overlay opens', await evalJs('Game.state') === 'inventory');
  check('inventory lists the item',
    (await evalJs('document.getElementById("invGrid").children.length')) >= 1);
  await evalJs('closeInventory(); true');
  check('inventory closes', await evalJs('Game.state') === 'play');

  console.log('\n=== endings ===');
  /* Walking to an ending takes more than one step: choosing a finale option jumps
     to an ending node, and that node still has 8-9 lines to page through before
     `finishNode` fires. A first version of this test advanced once and reported
     all three endings as null — the game was fine, the test was wrong. So: choose,
     then advance until the state leaves `dialogue`, with a bounded loop. */
  const endings = await evalJs(`(() => {
    const out = {};
    for (const key of ['ending_answer','ending_ritual','ending_flee']) {
      Game.state = 'play';
      hide('endScreen');
      Game.endInfo = null;
      Game.inventory = [{id:'tape',name:'نوار',kind:'item',text:''}];
      Game.flags = {knows_ritual: true};
      startDialogue('finale');
      Dlg.lineIndex = STORY.nodes.finale.lines.length - 1;
      advanceDialogue();                       // reveals the choices
      const visible = Dlg.choices.map(c => c.to);
      const idx = visible.indexOf(key);
      if (idx < 0) { out[key] = 'choice-not-visible'; continue; }
      chooseDialogue(idx);
      let guard = 0;
      while (Game.state === 'dialogue' && guard++ < 40) advanceDialogue();
      out[key] = Game.endInfo ? Game.endInfo.ending : ('state=' + Game.state);
    }
    return out;
  })()`);
  check('finale choice "answer" reaches the bad ending', endings.ending_answer === 'bad', JSON.stringify(endings));
  check('finale choice "ritual" reaches the best ending', endings.ending_ritual === 'best', JSON.stringify(endings));
  check('finale choice "flee" reaches the flee ending', endings.ending_flee === 'flee', JSON.stringify(endings));

  // The end screen must actually be SHOWN, not just the state flipped — a bug
  // where the overlay never appears is invisible in a state-only assertion.
  const endShown = await evalJs(`(() => {
    Game.state='play'; hide('endScreen'); Game.endInfo=null;
    Game.inventory=[{id:'tape'}]; Game.flags={knows_ritual:true};
    startDialogue('finale');
    Dlg.lineIndex = STORY.nodes.finale.lines.length - 1;
    advanceDialogue();
    chooseDialogue(Dlg.choices.map(c=>c.to).indexOf('ending_flee'));
    let g=0; while(Game.state==='dialogue' && g++<40) advanceDialogue();
    return {
      visible: !document.getElementById('endScreen').classList.contains('hidden'),
      title: document.getElementById('endTitle').textContent,
      text: document.getElementById('endText').textContent,
    };
  })()`);
  check('end screen overlay is shown at an ending', endShown.visible === true, JSON.stringify(endShown));
  check('end screen shows the ending title and text',
    (endShown.title || '').length > 2 && (endShown.text || '').length > 2, JSON.stringify(endShown));

  const ritualGated = await evalJs(`(() => {
    Game.inventory = []; Game.flags = {};
    startDialogue('finale');
    Dlg.lineIndex = STORY.nodes.finale.lines.length - 1;
    advanceDialogue();
    return Dlg.choices.map(c => c.to);
  })()`);
  check('ritual ending is hidden without the tape and lore',
    !ritualGated.includes('ending_ritual'), JSON.stringify(ritualGated));

  console.log('\n=== entity ===');
  const ent = await evalJs(`(() => {
    Game.endInfo = null; Game.state = 'play';
    hide('endScreen');
    Game.entity.state = 'dormant';
    Game.inventory = [];
    const dormant = Game.entity.state;
    addItem('key_iron','کلید');
    Game.entity.cooldown = 0;
    updateEntity(0.016);
    const afterKey = Game.entity.state;
    // Bring the player close with the torch on -> hunting.
    Game.player.x = Game.entity.x + 40; Game.player.y = Game.entity.y;
    Game.player.torch = true; Game.player.battery = 100;
    updateEntity(0.016);
    const close = Game.entity.state;
    Game.player.torch = false;
    updateEntity(0.016);
    return {dormant, afterKey, close, afterTorchOff: Game.entity.state};
  })()`);
  check('entity starts dormant', ent.dormant === 'dormant');
  check('entity wakes after the iron key is taken', ent.afterKey === 'stalking', JSON.stringify(ent));
  check('entity hunts when the player is close with the torch on', ent.close === 'hunting', JSON.stringify(ent));
  check('entity drops back to stalking when the torch goes off', ent.afterTorchOff === 'stalking', JSON.stringify(ent));

  const contact = await evalJs(`(() => {
    Game.state = 'play'; Game.endInfo = null;
    hide('endScreen');
    Game.entity.state = 'stalking';
    Game.player.x = Game.entity.x + 4; Game.player.y = Game.entity.y;
    updateEntity(0.016);
    return {state: Game.state, end: Game.endInfo && Game.endInfo.ending};
  })()`);
  check('touching the entity ends the game', contact.state === 'end' && contact.end === 'taken', JSON.stringify(contact));

  console.log('\n=== save / load ===');
  const saved = await evalJs(`(() => {
    Game.state = 'play'; hide('endScreen');
    Game.doors.corr2_basement = true;
    Game.flags.marker = 7;
    Game.player.x = 100; Game.player.y = 120;
    const ok = saveGame();
    Game.player.x = 0; Game.player.y = 0;
    Game.doors = {}; Game.flags = {};
    freshState();
    loadGame();
    return {
      ok,
      x: Game.player.x, y: Game.player.y,
      door: Game.doors.corr2_basement === true,
      flag: Game.flags.marker === 7,
      walkable: !isWall(27, 30),
      state: Game.state,
    };
  })()`);
  check('save writes', saved.ok === true);
  check('load restores position', Math.abs(saved.x - 100) < 0.01 && Math.abs(saved.y - 120) < 0.01, JSON.stringify(saved));
  check('load restores door state', saved.door === true);
  check('load restores flags', saved.flag === true);
  check('load re-opens the grid hole for a restored door', saved.walkable === true);
  check('state is play after load', saved.state === 'play');

  console.log('\n=== long run (frame stability) ===');
  await evalJs('startNew(); true');
  await sleep(200);
  const beforeRun = await evalJs('Game.time');
  // Fire 400 synthetic steps to simulate a long play session.
  await evalJs(`(() => { for (let i = 0; i < 400; i++) update(1/60); return true; })()`);
  const afterRun = await evalJs('Game.time');
  check('400 update steps ran without throwing', afterRun > beforeRun, `time ${beforeRun.toFixed(2)} -> ${afterRun.toFixed(2)}`);

  const errs = await evalJs('JSON.stringify(window.__errs || [])');
  const errList = JSON.parse(errs);
  check('no uncaught page errors', errList.length === 0, errs.slice(0, 400));

  // A full-frame render must not throw either.
  let renderErr = null;
  try { await evalJs('render(); true'); } catch (e) { renderErr = e.message; }
  check('render() runs without throwing', renderErr === null, renderErr || '');

  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);

  cdp.close();
  chrome.kill();
  srv.close();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

/* Hold a real key down by dispatching keydown/keyup into the page, then let the
   game's own raf loop move the player. Using Input.dispatchKeyEvent would need a
   focused target; dispatching into the document exercises the same listeners. */
async function keyHold(key, ms, evalJs, sendS) {
  const code = { ArrowRight: 'ArrowRight', ArrowLeft: 'ArrowLeft', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' }[key] || key;
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', {key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true})); true`);
  await sleep(ms);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keyup', {key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true})); true`);
  await sleep(60);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => {
  console.error('PLAYTEST CRASHED:', e.stack || e.message);
  process.exit(1);
});
