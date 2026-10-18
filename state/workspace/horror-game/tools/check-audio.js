#!/usr/bin/env node
/* check-audio.js — does the audio in the built game actually decode in a browser?
 *
 * The earlier attempts at this check were wrong twice:
 *   1. the CDP evaluate wrapper did not pass awaitPromise, so it returned a
 *      Promise object and printed "[object Object]";
 *   2. the data URI was sliced to 200 chars, producing a truncated mp3 that
 *      failed with 'error' — a broken TEST, not a broken game.
 *
 * This version decodes the FULL embedded track through WebAudio, which is the
 * same path the game uses at runtime, and it also decodes a data URI built fresh
 * from the source file. If the fresh one decodes and the embedded one does not,
 * the packaging is at fault. If neither decodes, the browser lacks the codec.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_BIN || '/opt/hermes/tools/chromium-1208/chrome-linux64/chrome';
const PORT = 9488;

function connect(wsUrl) {
  const u = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      const k = crypto.randomBytes(16).toString('base64');
      sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${k}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on('error', reject);
    let hs = false, buf = Buffer.alloc(0);
    const h = new Map();
    let id = 1;
    function send(m, p, s) {
      const mid = id++;
      const pl = JSON.stringify(s ? { id: mid, method: m, params: p || {}, sessionId: s }
                                  : { id: mid, method: m, params: p || {} });
      const d = Buffer.from(pl), L = d.length, mask = crypto.randomBytes(4);
      let hd;
      if (L < 126) hd = Buffer.from([0x81, 0x80 | L]);
      else if (L < 65536) { hd = Buffer.alloc(4); hd[0] = 0x81; hd[1] = 0x80 | 126; hd.writeUInt16BE(L, 2); }
      else { hd = Buffer.alloc(10); hd[0] = 0x81; hd[1] = 0x80 | 127; hd.writeBigUInt64BE(BigInt(L), 2); }
      const mk = Buffer.alloc(L);
      for (let i = 0; i < L; i++) mk[i] = d[i] ^ mask[i % 4];
      sock.write(Buffer.concat([hd, mask, mk]));
      return new Promise((r, j) => h.set(mid, { r, j }));
    }
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (!hs) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        buf = buf.subarray(i + 4); hs = true;
        resolve({ send, close: () => sock.destroy() });
      }
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        let L = b1 & 0x7f, o = 2;
        if (L === 126) { if (buf.length < 4) return; L = buf.readUInt16BE(2); o = 4; }
        else if (L === 127) { if (buf.length < 10) return; L = Number(buf.readBigUInt64BE(2)); o = 10; }
        const m = (b1 & 0x80) !== 0;
        let mk = null;
        if (m) { if (buf.length < o + 4) return; mk = buf.subarray(o, o + 4); o += 4; }
        if (buf.length < o + L) return;
        let pl = buf.subarray(o, o + L);
        if (m) { const out = Buffer.alloc(L); for (let i = 0; i < L; i++) out[i] = pl[i] ^ mk[i % 4]; pl = out; }
        buf = buf.subarray(o + L);
        if ((b0 & 0x0f) === 0x1) {
          try {
            const msg = JSON.parse(pl.toString('utf8'));
            if (msg.id && h.has(msg.id)) {
              const hh = h.get(msg.id); h.delete(msg.id);
              if (msg.error) hh.j(new Error(JSON.stringify(msg.error)));
              else hh.r(msg.result);
            }
          } catch (e) { /* event */ }
        }
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const prof = `/var/tmp/hermes-offload/tmp/cp-audio-${process.pid}`;
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${prof}`, '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); ws = (await r.json()).webSocketDebuggerUrl; break; }
    catch (e) { await sleep(250); }
  }
  if (!ws) { console.error('no CDP endpoint'); chrome.kill(); process.exit(1); }

  const cdp = await connect(ws);
  const t = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const a = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const S = a.sessionId;

  // awaitPromise MUST be set for any expression returning a Promise, or the
  // result is a Promise object serialised as "[object Object]".
  const E = async (expr, awaitPromise) => {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  let fails = 0;
  const check = (n, c, d) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && d ? ' — ' + d : ''}`); if (!c) fails++; };

  console.log('=== codec support in this browser ===');
  const canMp3 = await E(`document.createElement('audio').canPlayType('audio/mpeg')`);
  console.log(`  canPlayType('audio/mpeg') = ${JSON.stringify(canMp3)}`);

  // Control: build a data URI fresh from the source file and decode it.
  const src = path.join(ROOT, 'assets', 'audio', 'door.mp3');
  const freshUri = 'data:audio/mpeg;base64,' + fs.readFileSync(src).toString('base64');
  const control = await E(`(async()=>{
    const bin = atob(${JSON.stringify(freshUri.split(',')[1])});
    const u8 = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
    try {
      const ctx = new (window.AudioContext||window.webkitAudioContext)();
      const b = await ctx.decodeAudioData(u8.buffer);
      return 'OK ' + b.duration.toFixed(2) + 's ' + b.numberOfChannels + 'ch ' + b.sampleRate + 'Hz';
    } catch (e) { return 'FAILED: ' + (e && e.message); }
  })()`, true);
  check('WebAudio decodes a fresh data URI from the source file',
    String(control).startsWith('OK'), String(control));

  // Now the embedded one, taken in FULL from the built single file.
  const html = fs.readFileSync(path.join(ROOT, 'dist', 'room13.html'), 'utf8');
  const at = html.indexOf('data:audio/mpeg;base64,');
  let end = at;
  while (end < html.length && !/['"\s]/.test(html[end])) end++;
  const embedded = html.slice(at, end);
  console.log(`  embedded URI length: ${embedded.length} chars (${(embedded.length/1024).toFixed(0)} KB)`);

  const embedOk = await E(`(async()=>{
    const bin = atob(${JSON.stringify(embedded.split(',')[1])});
    const u8 = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
    try {
      const ctx = new (window.AudioContext||window.webkitAudioContext)();
      const b = await ctx.decodeAudioData(u8.buffer);
      return 'OK ' + b.duration.toFixed(2) + 's';
    } catch (e) { return 'FAILED: ' + (e && e.message); }
  })()`, true);
  check('WebAudio decodes the track embedded in the built game',
    String(embedOk).startsWith('OK'), String(embedOk));

  // And the game's own <audio> element path, which is what actually plays.
  const elOk = await E(`(async()=>{
    const uri = ${JSON.stringify(embedded)};
    const el = new Audio(uri);
    return await new Promise(r=>{
      el.addEventListener('loadedmetadata',()=>r('OK duration='+el.duration.toFixed(2)));
      el.addEventListener('error',()=>r('ERROR code='+(el.error&&el.error.code)+' '+((el.error&&el.error.message)||'')));
      setTimeout(()=>r('TIMEOUT'),5000);
    });
  })()`, true);
  check('an <audio> element accepts the embedded track', String(elOk).startsWith('OK'), String(elOk));

  console.log(`\n${fails === 0 ? 'AUDIO OK' : 'AUDIO PROBLEMS: ' + fails}`);
  cdp.close(); chrome.kill();
  fs.rmSync(prof, { recursive: true, force: true });
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('CRASH:', e.message); process.exit(1); });
