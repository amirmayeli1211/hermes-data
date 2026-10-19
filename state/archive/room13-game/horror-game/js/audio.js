/* audio.js — sound with a hard guarantee that a missing or blocked file cannot
   break the game. Every play() is wrapped, and the engine degrades to silence
   rather than throwing into the update loop. */
'use strict';

const Sound = (() => {
  const FILES = {
    ambientDrone:    'assets/audio/ambient_drone.mp3',
    ambientWind:     'assets/audio/ambient_wind.mp3',
    ambientBasement: 'assets/audio/ambient_basement.mp3',
    heartbeat:       'assets/audio/heartbeat.mp3',
    whisper:         'assets/audio/whisper.mp3',
    door:            'assets/audio/door.mp3',
    step1:           'assets/audio/footstep_1.mp3',
    step2:           'assets/audio/footstep_2.mp3',
    pickup:          'assets/audio/pickup.mp3',
    drip:            'assets/audio/drip.mp3',
    static:          'assets/audio/static.mp3',
    sting:           'assets/audio/sting.mp3',
    click:           'assets/audio/ui_click.mp3',
  };

  const banks = {};      // name -> Audio element (for one-shots)
  const pool = {};       // name -> array of Audio elements (for overlapping sfx)
  let ambient = null;    // currently looping ambient
  let ambientName = '';
  let muted = false;
  let ready = false;
  let ambientVolume = 0.5;
  const POOL_SIZE = 4;

  /* Autoplay policy: browsers refuse to start audio until the user has
     interacted. Rather than guessing, every play attempt is queued behind the
     first real gesture. This is why the game is playable-but-silent until the
     player presses "شروع تازه" — and why that click is also what unlocks sound. */
  let unlocked = false;
  const pending = [];

  function build() {
    for (const name in FILES) {
      const src = FILES[name];
      pool[name] = [];
      for (let i = 0; i < POOL_SIZE; i++) {
        const a = new Audio();
        a.src = src;
        a.preload = 'auto';
        a.volume = 1;
        // Never let a media error surface as an uncaught exception.
        a.addEventListener('error', () => { /* silent: file missing */ });
        pool[name].push(a);
      }
      const amb = new Audio();
      amb.src = src;
      amb.preload = 'auto';
      amb.addEventListener('error', () => { /* silent */ });
      banks[name] = amb;
    }
    ready = true;
  }

  function playFromPool(name, volume) {
    if (muted || !ready) return;
    const list = pool[name];
    if (!list || !list.length) return;
    // Pick a free element so rapid repeats overlap instead of cutting each other.
    let el = list.find((a) => a.paused || a.ended);
    if (!el) {
      el = list[0];
      try { el.currentTime = 0; } catch (e) { /* not seekable yet */ }
    }
    try {
      el.volume = Math.max(0, Math.min(1, volume));
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* ignore */ }
  }

  return {
    init() {
      if (ready) return;
      try { build(); } catch (e) { ready = false; }
    },

    /* Called on the first user gesture. Retries every sound requested before it. */
    unlock() {
      if (unlocked) return;
      unlocked = true;
      this.init();
      const q = pending.splice(0, pending.length);
      for (const fn of q) { try { fn(); } catch (e) {} }
      if (ambientName) this.ambient(ambientName, 0);
    },

    sfx(name, volume = 0.7) {
      if (!unlocked) { pending.push(() => playFromPool(name, volume)); return; }
      playFromPool(name, volume);
    },

    /* Crossfade to a looping bed. Re-requesting the current one is a no-op, so
       callers can fire this every frame from a room check. */
    ambient(name, volume = 0.5, fadeMs = 900) {
      if (name === ambientName && ambient) {
        if (!muted) ambient.volume = volume;
        return;
      }
      const previous = ambient;
      const next = banks[name];
      ambientName = name;
      if (!next) return;
      ambient = next;
      try {
        next.loop = true;
        next.currentTime = 0;
        next.volume = 0;
        if (!muted && unlocked) {
          const p = next.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (e) { /* ignore */ }

      // Fade in the new bed and out the old one on a short interval rather than
      // setting volume once, which would click.
      const steps = Math.max(1, Math.floor(fadeMs / 40));
      let i = 0;
      const target = volume;
      const from = previous ? previous.volume : 0;
      const timer = setInterval(() => {
        i++;
        const t = i / steps;
        try { if (ambient === next) next.volume = target * t; } catch (e) {}
        if (previous && previous !== next) {
          try { previous.volume = Math.max(0, from * (1 - t)); } catch (e) {}
        }
        if (i >= steps) {
          clearInterval(timer);
          if (previous && previous !== next) {
            try { previous.pause(); previous.currentTime = 0; } catch (e) {}
          }
        }
      }, 40);
    },

    stopAmbient() {
      if (ambient) { try { ambient.pause(); } catch (e) {} }
      ambient = null;
      ambientName = '';
    },

    /* Heartbeat tempo tracks danger: faster as the entity closes in. */
    heartbeat(rate = 1) {
      this.sfx('heartbeat', Math.min(0.95, 0.45 * rate));
    },

    setMuted(v) {
      muted = !!v;
      if (muted) {
        this.stopAmbient();
      } else {
        const n = ambientName;
        ambientName = '';       // force a restart path
        if (n) this.ambient(n, ambientVolume);
      }
    },
    isMuted() { return muted; },
    setAmbientVolume(v) { ambientVolume = v; if (ambient && !muted) { try { ambient.volume = v; } catch (e) {} } },
    getAmbientVolume() { return ambientVolume; },
  };
})();
