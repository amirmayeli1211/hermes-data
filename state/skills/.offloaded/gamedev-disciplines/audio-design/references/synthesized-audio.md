# Synthesized audio recipes

Every effect below is generated from oscillators and noise. No downloads, no
licensing question, and the whole set regenerates from one script.

Common encoding for effects: `-ac 1 -ar 22050 -b:a 80k -y`. Mono 22.05 kHz is
small, and the low fidelity suits a pixel aesthetic. Ambient beds may go longer
(15-20 s) so a loop point is hard to notice.

## Building blocks

| Element | Source | Why it works |
| --- | --- | --- |
| Tone | `sine=frequency=N:duration=S` | Pure sine avoids the buzz of sawtooth at low pitch |
| Noise | `anoisesrc=color=brown\|pink\|white:duration=S:amplitude=A` | Brown = rumble, pink = broadband hiss, white = bright transients |
| Beat/unease | two sines a few Hz apart, `amix`ed | Beating between close tones is what reads as menace; a single tone reads as calm |
| Syllables | `tremolo` on bandpassed pink noise | Amplitude modulation at 4-7 Hz mimics speech rhythm without TTS |
| Decay | `aeval='val(0)*exp(-K*t)':c=same` | Exponential decay makes a sine strike something physical |
| Room | `aecho=in:out:delay:decay` | The echo tail is what signals a large or empty space |
| Distance | `lowpass=f=N` | A wall between you and a sound removes its highs |
| Gusting | slow `tremolo` (f=0.1-0.2) | Turns flat noise into wind that swells |

## Ambient beds

```sh
# Low drone — beating pair plus brown noise bed.
ffmpeg -f lavfi -i "sine=frequency=55:duration=20" \
       -f lavfi -i "sine=frequency=82.5:duration=20" \
       -f lavfi -i "anoisesrc=color=brown:duration=20:amplitude=0.25" \
       -filter_complex "[0:a][1:a][2:a]amix=inputs=3:duration=shortest,\
lowpass=f=320,tremolo=f=0.12:d=0.45,volume=1.5,afade=t=in:d=2,afade=t=out:st=18:d=2" \
       -ac 1 -ar 22050 -b:a 80k -y drone.mp3

# Wind — brown noise, band-limited, slow gust sweep.
ffmpeg -f lavfi -i "anoisesrc=color=brown:duration=15:amplitude=0.8" \
       -af "lowpass=f=700,highpass=f=80,tremolo=f=0.18:d=0.7,volume=0.9,\
afade=t=in:d=1.5,afade=t=out:st=13:d=2" \
       -ac 1 -ar 22050 -b:a 80k -y wind.mp3

# Deep room — 41 Hz plus filtered noise. Distinct from the drone so the player
# can tell which floor they are on by ear alone.
ffmpeg -f lavfi -i "sine=frequency=41:duration=16" \
       -f lavfi -i "anoisesrc=color=brown:duration=16:amplitude=0.5" \
       -filter_complex "[0:a][1:a]amix=inputs=2:duration=shortest,\
lowpass=f=180,volume=1.8,afade=t=in:d=2,afade=t=out:st=14:d=2" \
       -ac 1 -ar 22050 -b:a 80k -y basement.mp3
```

Give each area its own bed. Reusing one ambient for the whole game makes every
room feel like the same room.

## One-shots

```sh
# Heartbeat — a decaying 50 Hz sine. The decay is what makes it a thump, not a click.
ffmpeg -f lavfi -i "sine=frequency=50:duration=1.20" \
       -af "volume=6,aeval='val(0)*exp(-12*t)':c=same,\
aecho=0.7:0.6:120:0.35,highpass=f=35" \
       -ac 1 -ar 22050 -b:a 80k -y heartbeat.mp3

# Whisper — pink noise bandpassed to the consonant range, amplitude-modulated at
# two rates so it reads as syllables rather than a hiss.
ffmpeg -f lavfi -i "anoisesrc=color=pink:duration=2.2:amplitude=0.7" \
       -af "highpass=f=900,lowpass=f=3200,\
tremolo=f=5.5:d=0.85,tremolo=f=0.7:d=0.5,volume=0.7,\
afade=t=in:d=0.3,afade=t=out:st=1.7:d=0.5" \
       -ac 1 -ar 22050 -b:a 80k -y whisper.mp3

# Door — a vibrato'd low tone (the hinge) mixed with filtered noise (the wood).
ffmpeg -f lavfi -i "sine=frequency=140:duration=1.4" \
       -f lavfi -i "anoisesrc=color=brown:duration=1.4:amplitude=0.6" \
       -filter_complex "[0:a]vibrato=f=7:d=0.6,volume=1.2[a];\
[1:a]lowpass=f=500,volume=1.4[b];[a][b]amix=inputs=2:duration=shortest,\
highpass=f=90,afade=t=in:d=0.2,afade=t=out:st=1.1:d=0.3" \
       -ac 1 -ar 22050 -b:a 80k -y door.mp3

# Footstep — noise burst with a low body thump. Vary LP and FREQ per variant.
ffmpeg -f lavfi -i "anoisesrc=color=white:duration=0.22:amplitude=0.9" \
       -f lavfi -i "sine=frequency=70:duration=0.22" \
       -filter_complex "[0:a]lowpass=f=1100,volume=1.5[a];\
[1:a]volume=4,aeval='val(0)*exp(-28*t)':c=same[b];\
[a][b]amix=inputs=2:duration=shortest,afade=t=out:st=0.12:d=0.10" \
       -ac 1 -ar 22050 -b:a 80k -y footstep_1.mp3

# Pickup — two slightly detuned sines. Detuning avoids the "happy UI blip"
# that would fight a sombre tone.
ffmpeg -f lavfi -i "sine=frequency=523:duration=1.0" \
       -f lavfi -i "sine=frequency=497:duration=1.0" \
       -filter_complex "[0:a][1:a]amix=inputs=2:duration=shortest,\
aeval='val(0)*exp(-4*t)':c=same,aecho=0.6:0.5:180:0.3,volume=1.1" \
       -ac 1 -ar 22050 -b:a 80k -y pickup.mp3

# Sting — a dissonant tritone with a noise transient. Fast attack, and it MUST
# stay short or it masks the dialogue it punctuates.
ffmpeg -f lavfi -i "sine=frequency=220:duration=1.6" \
       -f lavfi -i "sine=frequency=311:duration=1.6" \
       -f lavfi -i "anoisesrc=color=white:duration=1.6:amplitude=0.9" \
       -filter_complex "[0:a][1:a]amix=inputs=2:duration=shortest[tones];\
[2:a]lowpass=f=4500,volume=0.5,aeval='val(0)*exp(-9*t)':c=same[noise];\
[tones][noise]amix=inputs=2:duration=shortest,\
aeval='val(0)*(1+1.8*exp(-14*t))':c=same,volume=1.3,afade=t=out:st=1.0:d=0.6" \
       -ac 1 -ar 22050 -b:a 80k -y sting.mp3
```

## Size reference

A complete 13-effect set lands near 650 KB; the three ambient beds are most of
it. Individual effects are 2-30 KB. There is no reason to reach for compressed
sample packs at these sizes.

## Playback side

Synthesis solves sourcing; the runtime still needs care.

```js
// Browsers and mobile WebViews block audio until a user gesture. Unlock once on
// the first real interaction and queue anything requested before it — otherwise
// the first sounds are silently dropped.
let unlocked = false;
const pending = [];

function unlock() {
  if (unlocked) return;
  unlocked = true;
  for (const fn of pending.splice(0)) { try { fn(); } catch (e) {} }
}

function sfx(name, volume) {
  if (!unlocked) { pending.push(() => playFromPool(name, volume)); return; }
  playFromPool(name, volume);
}

// A pool per sound so rapid repeats overlap instead of cutting each other off.
function playFromPool(name, volume) {
  const list = pool[name];
  let el = list.find((a) => a.paused || a.ended);
  if (!el) { el = list[0]; try { el.currentTime = 0; } catch (e) {} }
  try {
    el.volume = Math.min(1, Math.max(0, volume));
    const p = el.play();
    if (p && p.catch) p.catch(() => {});   // a rejected play() is not fatal
  } catch (e) { /* degrade to silence */ }
}

// Never let a missing file throw into the update loop.
const a = new Audio();
a.src = 'assets/audio/thing.mp3';
a.addEventListener('error', () => {});
```

Crossfade between ambient beds on a short interval rather than setting volume
once: an instant volume change on a loop clicks audibly. Track the desired bed
name and make re-requesting the current one a no-op, so room checks can call it
every frame.
