/* sprites.js — pixel art as character grids, tinted at draw time.
   No image files: every sprite is defined as rows of characters mapped through a
   palette, so the whole art set is a few KB of source and scaling never blurs.
   '.' always means transparent. */
'use strict';

const SPR = {};

/* Palette: deliberately desaturated. A horror game loses its nerve if the
   colours are cheerful, so everything sits in a narrow, grimy range. */
const PAL = {
  // player
  h: '#120f14', // hair
  s: '#c99a76', // skin
  S: '#a87a5c', // skin shadow
  j: '#3a4a5c', // jacket
  J: '#28323f', // jacket shadow
  p: '#26303a', // trousers
  e: '#0a0a0c', // eyes
  // creature
  n: '#0b0b0e', // void body
  N: '#161621',
  r: '#6e1f1a', // eye glow
  R: '#c0392b',
  // props
  w: '#4a3b2a', // wood
  W: '#5f4c36',
  m: '#2b2b33', // metal
  M: '#3d3d47',
  g: '#2f3a2a', // grime/green
  b: '#1b1b22', // black-ish
  y: '#c9a227', // amber (lamps, paper edge)
  Y: '#e8d9a0', // paper
  k: '#2a2118', // dark wood
  c: '#7a7268', // concrete
  C: '#948b80',
  d: '#5a1f1b', // dried blood
  v: '#3a2a3a', // purple-ish fabric
  t: '#101014', // deep dark
};

/* --- player: 12x16, two walk frames + idle -------------------------------
   Small on purpose: at 16px tiles a 12px-wide body reads clearly and leaves
   room for doorways. */
SPR.playerDown = [
  '....hhhh....',
  '...hhhhhh...',
  '...hssssh...',
  '...seesse...',
  '...ssssss...',
  '....sSSs....',
  '...jjjjjj...',
  '..jjJJJJjj..',
  '..jjJJJJjj..',
  '..sjjjjjjs..',
  '...jjjjjj...',
  '...pppppp...',
  '...pp..pp...',
  '...pp..pp...',
  '...pp..pp...',
  '..kk....kk..',
];
SPR.playerDown1 = [
  '....hhhh....',
  '...hhhhhh...',
  '...hssssh...',
  '...seesse...',
  '...ssssss...',
  '....sSSs....',
  '...jjjjjj...',
  '..jjJJJJjj..',
  '..jjJJJJjj..',
  '..sjjjjjjs..',
  '...jjjjjj...',
  '...pppppp...',
  '..pp....pp..',
  '..pp....pp..',
  '..pp....pp..',
  '.kk......kk.',
];
SPR.playerDown2 = [
  '....hhhh....',
  '...hhhhhh...',
  '...hssssh...',
  '...seesse...',
  '...ssssss...',
  '....sSSs....',
  '...jjjjjj...',
  '..jjJJJJjj..',
  '..jjJJJJjj..',
  '..sjjjjjjs..',
  '...jjjjjj...',
  '...pppppp...',
  '....pppp....',
  '....pppp....',
  '...pp..pp...',
  '..kk....kk..',
];
SPR.playerUp = [
  '....hhhh....',
  '...hhhhhh...',
  '...hhhhhh...',
  '...hhhhhh...',
  '...hhhhhh...',
  '....hhhh....',
  '...jjjjjj...',
  '..jjJJJJjj..',
  '..jjJJJJjj..',
  '..sjjjjjjs..',
  '...jjjjjj...',
  '...pppppp...',
  '...pp..pp...',
  '...pp..pp...',
  '...pp..pp...',
  '..kk....kk..',
];
SPR.playerUp1 = [
  '....hhhh....',
  '...hhhhhh...',
  '...hhhhhh...',
  '...hhhhhh...',
  '...hhhhhh...',
  '....hhhh....',
  '...jjjjjj...',
  '..jjJJJJjj..',
  '..jjJJJJjj..',
  '..sjjjjjjs..',
  '...jjjjjj...',
  '...pppppp...',
  '..pp....pp..',
  '..pp....pp..',
  '..pp....pp..',
  '.kk......kk.',
];
SPR.playerUp2 = [
  '....hhhh....',
  '...hhhhhh...',
  '...hhhhhh...',
  '...hhhhhh...',
  '...hhhhhh...',
  '....hhhh....',
  '...jjjjjj...',
  '..jjJJJJjj..',
  '..jjJJJJjj..',
  '..sjjjjjjs..',
  '...jjjjjj...',
  '...pppppp...',
  '....pppp....',
  '....pppp....',
  '...pp..pp...',
  '..kk....kk..',
];
SPR.playerSide = [
  '....hhh.....',
  '...hhhhh....',
  '...hssss....',
  '...ssees....',
  '...ssssss...',
  '....sSss....',
  '...jjjjj....',
  '..jjJJJjj...',
  '..jjJJJjj...',
  '...jjjjjs...',
  '...jjjjj....',
  '...ppppp....',
  '...pp.pp....',
  '...pp.pp....',
  '...pp.pp....',
  '..kk...kk...',
];
SPR.playerSide1 = [
  '....hhh.....',
  '...hhhhh....',
  '...hssss....',
  '...ssees....',
  '...ssssss...',
  '....sSss....',
  '...jjjjj....',
  '..jjJJJjj...',
  '..jjJJJjj...',
  '...jjjjjs...',
  '...jjjjj....',
  '...ppppp....',
  '..pp...pp...',
  '..pp...pp...',
  '..pp...pp...',
  '.kk....kk...',
];
SPR.playerSide2 = [
  '....hhh.....',
  '...hhhhh....',
  '...hssss....',
  '...ssees....',
  '...ssssss...',
  '....sSss....',
  '...jjjjj....',
  '..jjJJJjj...',
  '..jjJJJjj...',
  '...jjjjjs...',
  '...jjjjj....',
  '...ppppp....',
  '....ppp.....',
  '....ppp.....',
  '...pp.pp....',
  '..kk..kk....',
];

/* --- the entity: 14x18, taller than the player so it reads as looming ----
   Two states: dormant (eyes dim) and hunting (eyes lit). The eye colour is a
   separate overlay so it can be animated without redrawing the body. */
SPR.entityDormant = [
  '.....nnnn.....',
  '....nnnnnn....',
  '...nnnnnnnn...',
  '...nNnnnnNn...',
  '...nnnnnnnn...',
  '....nnnnnn....',
  '....nnnnnn....',
  '...nnnnnnnn...',
  '..nnnnnnnnnn..',
  '.nnnnnnnnnnnn.',
  '.nNnnnnnnnnNn.',
  '.nnnnnnnnnnnn.',
  '.nnnnnnnnnnnn.',
  '..nnnnnnnnnn..',
  '..nnnn..nnnn..',
  '..nnn....nnn..',
  '..nnn....nnn..',
  '..nn......nn..',
];
SPR.entityEyes = [
  '..............',
  '..............',
  '..............',
  '....r....r....',
  '....R....R....',
  '....r....r....',
  '..............',
  '..............',
  '..............',
  '..............',
  '..............',
  '..............',
  '..............',
  '..............',
  '..............',
  '..............',
  '..............',
  '..............',
];

/* --- props: 16x16 tiles ------------------------------------------------ */

SPR.door = [
  'wwwwwwwwwwwwwwww',
  'wWWWWWWWWWWWWWWw',
  'wWkkkkkkkkkkkkWw',
  'wWkwwwwwwwwwwkWw',
  'wWkwWWWWWWWWwkWw',
  'wWkwWkkkkkkWwkWw',
  'wWkwWkwwwwkWwkWw',
  'wWkwWkwWWwkWwkWw',
  'wWkwWkwWWwkWwkWw',
  'wWkwWkwwwwkWwkWw',
  'wWkwWkkkkkkWwkWw',
  'wWkwWWWWWWWWwkWw',
  'wWkwwwwwwwwwwkWw',
  'wWkkkkkkkkkkkkWw',
  'wWWWWWWWWWWWWWWw',
  'wwwwwwwwwwwwwwww',
];
SPR.doorOpen = [
  'wwwwwwwwwwwwwwww',
  'wWWWWWWWWWWWWWWw',
  'wWttttttttttttWw',
  'wWttttttttttttWw',
  'wWttttttttttttWw',
  'wWttttttttttttWw',
  'wWttttttttttttWw',
  'wWttttttttttttWw',
  'wWttttttttttttWw',
  'wWttttttttttttWw',
  'wWttttttttttttWw',
  'wWttttttttttttWw',
  'wWttttttttttttWw',
  'wWttttttttttttWw',
  'wWWWWWWWWWWWWWWw',
  'wwwwwwwwwwwwwwww',
];
SPR.note = [
  '................',
  '................',
  '....YYYYYYYY....',
  '...YyYYYYYYyY...',
  '...YYkkkkkkYY...',
  '...YYkYYYYkYY...',
  '...YYkkkkkkYY...',
  '...YYkYYYYkYY...',
  '...YYkkkkkkYY...',
  '...YYkYYYYkYY...',
  '...YYkkkkkkYY...',
  '...YyYYYYYYyY...',
  '....YYYYYYYY....',
  '................',
  '................',
  '................',
];
SPR.key = [
  '................',
  '................',
  '................',
  '....mmmm........',
  '...mMMMMm.......',
  '...mM..Mm.......',
  '...mM..Mm.......',
  '...mMMMMm.mmm...',
  '....mmmm..m.m...',
  '..........m.m...',
  '..........mmm...',
  '................',
  '................',
  '................',
  '................',
  '................',
];
SPR.battery = [
  '................',
  '................',
  '................',
  '.......mm.......',
  '......mMMm......',
  '...mmmmmmmmmm...',
  '...mMMMMMMMMm...',
  '...mMyyyyMMM m..',
  '...mMyyyyMMMm...',
  '...mMMyyMMMMm...',
  '...mMMMMMMMMm...',
  '...mmmmmmmmmm...',
  '................',
  '................',
  '................',
  '................',
];
SPR.tape = [
  '................',
  '................',
  '..bbbbbbbbbbbb..',
  '..bmmmmmmmmmmb..',
  '..bm........mb..',
  '..bm.mm..mm.mb..',
  '..bm.mm..mm.mb..',
  '..bm........mb..',
  '..bmmmmmmmmmmb..',
  '..bbbbbbbbbbbb..',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
];
SPR.radio = [
  '................',
  '................',
  '.mmmmmmmmmmmmmm.',
  '.mMMMMMMMMMMMMm.',
  '.mM..........Mm.',
  '.mM.mmmmmmmm.Mm.',
  '.mM.mggggggm.Mm.',
  '.mM.mggggggm.Mm.',
  '.mM.mmmmmmmm.Mm.',
  '.mM..........Mm.',
  '.mM.oo.oo.oo.Mm.',
  '.mM..........Mm.',
  '.mMMMMMMMMMMMMm.',
  '.mmmmmmmmmmmmmm.',
  '................',
  '................',
];
SPR.lamp = [
  '................',
  '................',
  '.......mm.......',
  '.......mm.......',
  '.......mm.......',
  '......mMMm......',
  '.....mmYYmm.....',
  '....mYYYYYYm....',
  '....mYyyyyYm....',
  '...mYYyyyyYYm...',
  '...mYyyyyyyYm...',
  '....mYYYYYYm....',
  '.....mmmmmm.....',
  '................',
  '................',
  '................',
];
SPR.mirror = [
  'mmmmmmmmmmmmmmmm',
  'mCCCCCCCCCCCCCCm',
  'mCcccccccccccCCm',
  'mCcccccccccccCCm',
  'mCccggggggcccCCm',
  'mCccggggggcccCCm',
  'mCcccccccccccCCm',
  'mCcccccccccccCCm',
  'mCcccccccccccCCm',
  'mCcccccccccccCCm',
  'mCcccccccccccCCm',
  'mCcccccccccccCCm',
  'mCcccccccccccCCm',
  'mCCCCCCCCCCCCCCm',
  'mmmmmmmmmmmmmmmm',
  '................',
];
SPR.stairs = [
  'kkkkkkkkkkkkkkkk',
  'kwwwwwwwwwwwwwwk',
  'kkkkkkkkkkkkkkkk',
  'kwwwwwwwwwwwwwwk',
  'kkkkkkkkkkkkkkkk',
  'kwwwwwwwwwwwwwwk',
  'kkkkkkkkkkkkkkkk',
  'kwwwwwwwwwwwwwwk',
  'kkkkkkkkkkkkkkkk',
  'kwwwwwwwwwwwwwwk',
  'kkkkkkkkkkkkkkkk',
  'kwwwwwwwwwwwwwwk',
  'kkkkkkkkkkkkkkkk',
  'kwwwwwwwwwwwwwwk',
  'kkkkkkkkkkkkkkkk',
  'kkkkkkkkkkkkkkkk',
];
SPR.bed = [
  '................',
  '..mmmmmmmmmmmm..',
  '..mWWWWWWWWWWm..',
  '..mvvvvvvvvvvm..',
  '..mvvvvvvvvvvm..',
  '..mvvvvvvvvvvm..',
  '..mYYYYYYYYYYm..',
  '..mYYYYYYYYYYm..',
  '..mYYYYYYYYYYm..',
  '..mYYYYYYYYYYm..',
  '..mmmmmmmmmmmm..',
  '..wWWWWWWWWWWw..',
  '..wWWWWWWWWWWw..',
  '................',
  '................',
  '................',
];
SPR.desk = [
  '................',
  '................',
  'wwwwwwwwwwwwwwww',
  'wWWWWWWWWWWWWWWw',
  'wWWWWWWWWWWWWWWw',
  'www.wwwwwwww.www',
  '..w..........w..',
  '..w..........w..',
  '..w..........w..',
  '..ww........ww..',
  '...w........w...',
  '................',
  '................',
  '................',
  '................',
  '................',
];
SPR.crate = [
  '................',
  '..kkkkkkkkkkkk..',
  '..kWWWWWWWWWWk..',
  '..kWkkkkkkkkWk..',
  '..kWkWWWWWWkWk..',
  '..kWkWkkkkWkWk..',
  '..kWkWkWWkWkWk..',
  '..kWkWkWWkWkWk..',
  '..kWkWkWWkWkWk..',
  '..kWkWkkkkWkWk..',
  '..kWkWWWWWWkWk..',
  '..kWkkkkkkkkWk..',
  '..kWWWWWWWWWWk..',
  '..kkkkkkkkkkkk..',
  '................',
  '................',
];
SPR.shelf = [
  'wwwwwwwwwwwwwwww',
  'wWWWWWWWWWWWWWWw',
  'wWkkkkWWkkkkWWkw',
  'wWWWWWWWWWWWWWWw',
  'wwwwwwwwwwwwwwww',
  'wWWWWWWWWWWWWWWw',
  'wWkkWWkkkkWWkkkw',
  'wWWWWWWWWWWWWWWw',
  'wwwwwwwwwwwwwwww',
  'wWWWWWWWWWWWWWWw',
  'wWkkkkWWkkkkWWkw',
  'wWWWWWWWWWWWWWWw',
  'wwwwwwwwwwwwwwww',
  'wWWWWWWWWWWWWWWw',
  'wwwwwwwwwwwwwwww',
  '................',
];
SPR.bathtub = [
  '................',
  '..CCCCCCCCCCCC..',
  '.CccccccccccccC.',
  '.CcggggggggggccC',
  '.CcggggggggggccC',
  '.CccgggggggggccC',
  '.CccccccccccccC.',
  '.CccccccccccccC.',
  '.CccccccccccccC.',
  '.CccccccccccccC.',
  '.CCCCCCCCCCCCCC.',
  '..C..........C..',
  '..C..........C..',
  '................',
  '................',
  '................',
];
SPR.sink = [
  '................',
  '................',
  '...CCCCCCCCCC...',
  '..CccccccccccC..',
  '..CcggggggggcC..',
  '..CccccccccccC..',
  '..CCCCCCCCCCCC..',
  '.....C....C.....',
  '.....C....C.....',
  '....CC....CC....',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
];
SPR.blood = [
  '................',
  '................',
  '................',
  '.....ddd........',
  '....ddddd...d...',
  '...ddddddd.ddd..',
  '..dddddddddddd..',
  '..dddddddddddd..',
  '...dddddddddd...',
  '....dddddddd....',
  '.....dddd.d.....',
  '......d....d....',
  '................',
  '................',
  '................',
  '................',
];
SPR.flesh = [
  '................',
  '.....ddddddd....',
  '...ddddddddddd..',
  '..ddddddddddddd.',
  '..ddddddddddddd.',
  '..ddddddddddddd.',
  '...ddddddddddd..',
  '....ddddddddd...',
  '.....ddddddd....',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
];
SPR.altar = [
  '................',
  '..cccccccccccc..',
  '..cCCCCCCCCCCc..',
  '..cCCCCCCCCCCc..',
  '..cCCddddddCCc..',
  '..cCCddddddCCc..',
  '..cCCCCCCCCCCc..',
  '..cccccccccccc..',
  '..cc........cc..',
  '..cc........cc..',
  '..cc........cc..',
  '................',
  '................',
  '................',
  '................',
  '................',
];

/* --- pre-render every sprite into an offscreen canvas ---------------------
   Drawing per-pixel with fillRect every frame is the classic pixel-art
   performance trap: at 60fps with a full screen of tiles it dominates the
   frame budget. Each sprite is rasterised ONCE here, then blitted. */
const SPRITE_CACHE = {};

function bakeSprite(rows, name) {
  const h = rows.length, w = rows[0].length;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      if (!ch || ch === '.' || ch === ' ') continue;
      const col = PAL[ch];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    }
  }
  SPRITE_CACHE[name] = c;
  return c;
}

function bakeSpriteTinted(rows, name, tint, alpha) {
  const h = rows.length, w = rows[0].length;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      if (!ch || ch === '.' || ch === ' ') continue;
      g.fillStyle = (ch === '.' ? null : tint);
      if (!g.fillStyle) continue;
      g.fillRect(x, y, 1, 1);
    }
  }
  SPRITE_CACHE[name] = c;
  return c;
}

function bakeAll() {
  for (const k in SPR) bakeSprite(SPR[k], k);
  // A flat silhouette of the entity, used for the shadow it casts forward.
  bakeSpriteTinted(SPR.entityDormant, 'entitySilhouette', '#000');
}

/* Draw a baked sprite. `flip` mirrors horizontally for the side-facing frames,
   so one set of art serves both directions. */
function drawSprite(g, name, x, y, flip) {
  const c = SPRITE_CACHE[name];
  if (!c) return;
  if (flip) {
    g.save();
    g.translate(Math.round(x) + c.width, Math.round(y));
    g.scale(-1, 1);
    g.drawImage(c, 0, 0);
    g.restore();
  } else {
    g.drawImage(c, Math.round(x), Math.round(y));
  }
}
