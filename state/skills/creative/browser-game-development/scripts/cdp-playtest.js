#!/usr/bin/env node
/* cdp-playtest.js — drive a browser game in real headless Chromium and assert on
 * behaviour. Zero npm dependencies: a static server, a minimal CDP WebSocket
 * client, and the assertions.
 *
 * Adapt the ROUTE and the assertion block to the game at hand; the harness
 * machinery below is what is worth reusing verbatim.
 *
 * Run:  node tools/playtest.js
 * Env:  CHROME_BIN, PORT, CDP_PORT
 * Exit: 0 all assertions passed, 1 one or more failed.
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_BIN || 'chromium';
const PORT = Number(process.env.PORT || 8781);
const CDP_PORT = Number(process.env.CDP_PORT || 9333);

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

/* ---------------------------------------------------------------- server --
 * Serve over HTTP, not file://. It makes a bad asset path a visible 404 instead
 * of a silent no-load, and avoids file:// origin quirks with audio. */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.mp3': 'audio/mpeg', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp',
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

/* ------------------------------------------------------------ CDP client --
 * Chrome's devtools protocol is a small WebSocket framing job. Speaking it
 * directly avoids needing puppeteer/playwright in an image that has neither. */
function cdpConnect(wsUrl) {
  const u = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on('error', reject);

    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    const handlers = new Map();
    let nextId = 1;

    /* sessionId is a TOP-LEVEL field of the CDP message. Putting it inside
     * `params` is silently ignored and every call returns
     * -32601 "'X' wasn't found", which reads like a protocol mismatch. */
    function send(method, params, sessionId) {
      const id = nextId++;
      const payload = JSON.stringify(
        sessionId ? { id, method, params: params || {}, sessionId }
                  : { id, method, params: params || {} });
      const data = Buffer.from(payload);
      const len = data.length;
      const mask = crypto.randomBytes(4);
      let header;
      if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
      else if (len < 65536) {
        header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
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
        resolve({ send, close: () => sock.destroy() });
      }
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        let len = b1 & 0x7f, off = 2;
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
          } catch (e) { /* event frame */ }
        }
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ main -- */
async function main() {
  const srv = await serve();
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);

  const profile = path.join(process.env.TMPDIR || '/tmp', `cdp-profile-${process.pid}`);
  fs.rmSync(profile, { recursive: true, force: true });

  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--window-size=320,180', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      wsUrl = (await res.json()).webSocketDebuggerUrl;
      break;
    } catch (e) { await sleep(250); }
  }
  if (!wsUrl) {
    console.error('could not reach Chromium CDP\n' + chromeErr.slice(0, 2000));
    chrome.kill(); srv.close(); process.exit(1);
  }

  const cdp = await cdpConnect(wsUrl);
  const page = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const sessionId = attached.sessionId;
  const send = (method, params) => cdp.send(method, params || {}, sessionId);

  await send('Runtime.enable', {});
  await send('Log.enable', {});
  await send('Page.enable', {});

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('page exception: ' +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  const nav = async (url) => {
    await send('Page.navigate', { url });
    for (let i = 0; i < 80; i++) {
      if ((await evalJs('document.readyState').catch(() => 'x')) === 'complete') break;
      await sleep(100);
    }
  };

  const keyHold = async (key, ms) => {
    const ev = JSON.stringify(key);
    await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', {key: ${ev}, bubbles: true})); true`);
    await sleep(ms);
    await evalJs(`window.dispatchEvent(new KeyboardEvent('keyup', {key: ${ev}, bubbles: true})); true`);
    await sleep(60);
  };

  await nav(`http://127.0.0.1:${PORT}/index.html`);
  await sleep(400);

  /* Error collectors go in BEFORE interacting, or an exception during play is
   * lost and the run reports success. */
  await evalJs(`
    window.__errs = [];
    window.addEventListener('error', e => window.__errs.push(String(e.message || e.error)));
    window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason)));
    true;
  `);

  /* ------------------------- adapt the assertions below ------------------ */
  console.log('\n=== load ===');

  const hasGame = await evalJs('typeof Game !== "undefined" && typeof WORLD !== "undefined"');
  check('game objects loaded', hasGame);
  if (!hasGame) { finish(cdp, chrome, srv, profile); return; }

  const painted = await evalJs(`(() => {
    const c = document.getElementById('game'), g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 8 || d[i+1] > 8 || d[i+2] > 8) n++;
    return n;
  })()`);
  // Assert the POSITIVE space: a blank canvas with a clean console would pass a
  // purely negative test.
  check('canvas actually rendered something', painted > 500, `non-black px=${painted}`);

  console.log('\n=== movement + collision ===');
  const b = JSON.parse(await evalJs('JSON.stringify({x:Game.player.x,y:Game.player.y})'));
  await keyHold('ArrowRight', 600);
  const a = JSON.parse(await evalJs('JSON.stringify({x:Game.player.x,y:Game.player.y})'));
  check('player moved', a.x > b.x + 4, `x ${b.x} -> ${a.x}`);
  await keyHold('ArrowUp', 900);
  check('player blocked by the wall', (await evalJs('Game.player.y')) > 8);

  console.log('\n=== long run ===');
  const bt = await evalJs('Game.time');
  await evalJs('for (let i = 0; i < 400; i++) update(1/60); true');
  check('400 update steps ran', (await evalJs('Game.time')) > bt);

  const errs = JSON.parse(await evalJs('JSON.stringify(window.__errs || [])'));
  check('no uncaught page errors', errs.length === 0, JSON.stringify(errs).slice(0, 400));

  finish(cdp, chrome, srv, profile);
}

function finish(cdp, chrome, srv, profile) {
  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  cdp.close(); chrome.kill(); srv.close();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('PLAYTEST CRASHED:', e.stack || e.message);
  process.exit(1);
});
