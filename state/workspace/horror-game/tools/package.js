/* package.js — build the two deliverables a player actually wants.
 *
 *  1. room13.html      ONE self-contained file. JS, CSS and all 13 audio files
 *                      are inlined as base64, so it plays by double-clicking with
 *                      no server, no folder, no internet. This is the "just send
 *                      me the game" artifact.
 *  2. room13.zip       the full editable project (source, tools, README) for
 *                      anyone who wants to change the level or rebuild the audio.
 *
 * Run: node tools/package.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
fs.mkdirSync(DIST, { recursive: true });

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* --- 1. self-contained HTML ---------------------------------------------- */

let html = read('index.html');
const css = read('style.css');
const js = ['sprites', 'audio', 'world', 'story', 'game']
  .map((n) => read(`js/${n}.js`)).join('\n\n');

// Inline the stylesheet.
html = html.replace(
  /<link rel="stylesheet" href="style\.css">/,
  `<style>\n${css}\n</style>`);

// Inline every script in the order the original loaded them.
html = html.replace(
  /<script src="js\/[a-z]+\.js"><\/script>(\s*)/g, '');
html = html.replace(
  /<script src="js\/sprites\.js"><\/script>/,
  `<script>\n${js}\n</script>`);

// The script tags were removed by the loop above, so re-add one block where the
// first tag used to be. (Doing it in one pass keeps ordering obvious.)
if (!/<script>\s*\/\* sprites\.js/.test(html) && !html.includes('const SPR = {}')) {
  html = html.replace('</body>', `<script>\n${js}\n</script>\n</body>`);
}

// Audio: replace every 'assets/audio/x.mp3' string with a data: URI so the
// single file needs nothing beside it.
const AUDIO = 'assets/audio';
let inlined = 0;
for (const f of fs.readdirSync(path.join(ROOT, AUDIO))) {
  if (!f.endsWith('.mp3')) continue;
  const b64 = fs.readFileSync(path.join(ROOT, AUDIO, f)).toString('base64');
  const uri = `data:audio/mpeg;base64,${b64}`;
  const needle = `'${AUDIO}/${f}'`;
  if (html.includes(needle)) {
    html = html.split(needle).join(`'${uri}'`);
    inlined++;
  }
}

const outHtml = path.join(DIST, 'room13.html');
fs.writeFileSync(outHtml, html);

/* --- 2. project zip (stored, no external zip binary in this image) -------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zipFiles(files, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    // Only use deflate when it actually helps; stored otherwise.
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0x21, 12);       // date (fixed, so builds are reproducible)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(outPath, Buffer.concat([...chunks, centralBuf, end]));
}

function collect(dir, prefix) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...collect(full, rel));
    else out.push({ name: rel, data: fs.readFileSync(full) });
  }
  return out;
}


const files = [
  ...collect(path.join(ROOT, 'js'), 'js'),
  ...collect(path.join(ROOT, 'assets'), 'assets'),
  ...collect(path.join(ROOT, 'tools'), 'tools'),
  { name: 'index.html', data: Buffer.from(read('index.html')) },
  { name: 'style.css', data: Buffer.from(css) },
  // README.md ships from disk, not from a string built here: an inline copy and
  // the real file drifted apart, and verify-package.py caught the archive
  // containing a README that did not exist in the project.
  { name: 'README.md', data: fs.readFileSync(path.join(ROOT, 'README.md')) },
];

const apk = path.join(ROOT, 'APK.md');
if (fs.existsSync(apk)) files.push({ name: 'APK.md', data: fs.readFileSync(apk) });

const outZip = path.join(DIST, 'room13.zip');
zipFiles(files, outZip);

/* --- report -------------------------------------------------------------- */

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const htmlSize = fs.statSync(outHtml).size;
const zipSize = fs.statSync(outZip).size;

console.log('=== packaged ===');
console.log(`  dist/room13.html   ${kb(htmlSize)}   single file, ${inlined} audio track(s) inlined`);
console.log(`  dist/room13.zip    ${kb(zipSize)}   ${files.length} files (full project)`);
console.log('');
console.log('  play the single file:  open dist/room13.html in any browser');
console.log('  self-contained:        no server, no folder, no network needed');
