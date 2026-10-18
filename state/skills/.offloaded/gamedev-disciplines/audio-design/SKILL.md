---
name: audio-design
description: >
  Implement game audio practice — bus/mixer architecture and gain in decibels,
  ducking (sidechain), adaptive/dynamic music via layering and re-sequencing,
  SFX variation, and beat synchronization. Engine-neutral. Use when the user
  mentions audio mixing, audio buses, adaptive/dynamic music, ducking, SFX
  variation, music layers, or syncing gameplay to the beat.
---

# Audio design

Game audio is a **mixing graph plus a music system**. Route every sound through a
small set of buses so you can balance and process groups; make music *react* to
play through layering and re-sequencing rather than looping one track. This skill
teaches the portable practice; bind it to `godot-audio`, Unity's AudioMixer, or
middleware (FMOD/Wwise) for concrete APIs.

## When to use

- Use to design a bus/mixer layout, set group volumes, and apply effects (reverb,
  compression, EQ) to groups of sounds.
- Use to duck music/ambience under dialogue or impacts (sidechain).
- Use to build adaptive music that responds to combat/exploration intensity.
- Use to add SFX variation (pitch/sample randomization) and sync events to a beat.

**When *not* to use:** for the engine's concrete audio nodes/streams, use
`godot-audio` or the engine's audio skill. Loading/streaming and asset import are
engine concerns. For UI sliders that drive bus volume, see the engine UI skill.

## Core workflow

1. **Lay out buses, not per-sound volume.** A typical tree: `Master ← {Music,
   SFX, Ambience, UI, Voice}`. Everything plays into a bus; the player's settings
   sliders map to bus volumes. Never set hundreds of clip volumes by hand.
2. **Work in decibels, not linear.** Perceived loudness is logarithmic. Volume
   controls and automation should operate in dB; convert only at the edges.
3. **Leave headroom.** Mix so the Master peaks below 0 dBFS (aim for a target
   loudness, e.g. around -14 to -16 LUFS for many games) to avoid clipping.
4. **Duck competing sources** with a sidechain compressor (or volume automation):
   when voice/important SFX plays, the music bus dips, then recovers.
5. **Make music adaptive** via *vertical* layering (stems faded in/out) and/or
   *horizontal* re-sequencing (swap segments at musical boundaries). See the
   reference.
6. **Vary repeated SFX** with small random pitch/volume offsets and sample pools
   so footsteps and hits don't sound robotic.
7. **Verify on real output.** Listen on headphones and speakers; check that the
   mix balances, ducking is audible but not pumping, and music transitions land
   on the beat — never assume from the editor meters alone.

## Patterns

### 1. Bus routing and dB gain

```gdscript
# Route sounds to named buses; control GROUPS, not individual clips.
sfx_player.bus = "SFX"
music_player.bus = "Music"

# Map a 0..1 settings slider to decibels (linear_to_db), the perceptual unit.
func set_bus_volume(bus_name: String, slider01: float) -> void:
    var idx := AudioServer.get_bus_index(bus_name)
    var db := linear_to_db(clamp(slider01, 0.0001, 1.0))   # 0 -> silence, 1 -> 0 dB
    AudioServer.set_bus_volume_db(idx, db)
# RIGHT: slider -> dB via linear_to_db. WRONG: assigning slider01 straight as dB
# (a "0.5" would be only +0.5 dB — almost no change — and 0 would be 0 dB, full).
```

### 2. Ducking via sidechain (music dips under voice)

```gdscript
# A compressor on the MUSIC bus, keyed by the VOICE bus, lowers music while
# dialogue plays, then releases. This is "sidechain ducking".
# Setup (engine-specific): add a compressor effect to the Music bus and set its
# sidechain to the Voice bus. Then tune:
#   threshold: level on Voice that triggers ducking (e.g. -30 dB)
#   ratio:     how hard to duck (e.g. 8:1 for a clear dip)
#   attack:    fast (~10 ms) so music gets out of the way promptly
#   release:   slow (~300-500 ms) so it recovers smoothly, not pumping
# No-middleware alternative: tween the Music bus volume down on voice start and
# back up on voice end.
func duck_music(active: bool) -> void:
    var target_db := -12.0 if active else 0.0
    create_tween().tween_method(
        func(v): set_bus_volume_db("Music", v), current_music_db, target_db, 0.25)
```

### 3. SFX variation (kill the "machine gun" repeat)

```gdscript
# Randomize pitch slightly and pick from a sample pool so repeats feel organic.
func play_varied(samples: Array, bus := "SFX") -> void:
    var p := AudioStreamPlayer.new()
    p.stream = samples[randi() % samples.size()]   # rotate through several takes
    p.bus = bus
    p.pitch_scale = randf_range(0.94, 1.06)         # +/- ~6% pitch wobble
    add_child(p); p.play()
    p.finished.connect(p.queue_free)                # clean up one-shots
```

### 4. Beat-synced events (quantize to the music grid)

```gdscript
# Schedule gameplay/visuals on musical time, not frame time, so they land on beat.
const BPM := 120.0
var seconds_per_beat := 60.0 / BPM

func current_beat(playback_position_sec: float) -> int:
    return int(playback_position_sec / seconds_per_beat)

# Quantize an action to the NEXT beat boundary instead of firing immediately.
func time_until_next_beat(pos: float) -> float:
    return seconds_per_beat - fmod(pos, seconds_per_beat)
# Drive timing from the audio playback clock, which is steadier than frame delta.
```

## When there are no assets: synthesize them

Downloaded sound packs carry unclear licensing and unknown provenance, and a game
needs sounds tuned to its own pacing. Most effects a game actually requires —
ambient beds, footsteps, doors, heartbeats, stingers, UI clicks — are a few
seconds of noise and oscillators, which `ffmpeg` generates with no asset
pipeline, no licence question, and full reproducibility from one script.

```sh
# A low drone: two sines a fifth apart (the beating makes it unsettling) over brown noise.
ffmpeg -f lavfi -i "sine=frequency=55:duration=20" \
       -f lavfi -i "sine=frequency=82.5:duration=20" \
       -f lavfi -i "anoisesrc=color=brown:duration=20:amplitude=0.25" \
       -filter_complex "[0:a][1:a][2:a]amix=inputs=3:duration=shortest,\
lowpass=f=320,tremolo=f=0.12:d=0.45,afade=t=in:d=2,afade=t=out:st=18:d=2" \
       -ac 1 -ar 22050 -b:a 80k -y ambient_drone.mp3
```

The building blocks, and what each one is for:

| Element | ffmpeg source | Use |
| --- | --- | --- |
| Pitch / tone | `sine=frequency=N:duration=S` | drones, chimes, thumps, keys |
| Noise bed | `anoisesrc=color=brown\|pink\|white` | wind, room tone, static, footsteps |
| Beating | two sines a few Hz apart, `amix`ed | unease; a static drone reads as calm |
| Syllables | `tremolo` at 0.5-9 Hz on bandpassed pink noise | whispered speech without TTS |
| Decay envelope | `aeval='val(0)*exp(-K*t)':c=same` | turns a sine into a physical thump |
| Space | `aecho=in:out:delay:decay` | the echo is what reads as a large room |

Encode effects as mono 22.05 kHz MP3: tiny, and the low fidelity suits a pixel
aesthetic. A full horror set of 13 effects is around 650 KB.

**Repeated sounds need variation or they sound mechanical.** Generate two or
three variants of anything fired often (footsteps especially), differing in a
filter cutoff and a body frequency, and rotate them at playback. Do not ship one
footstep.

**Keep effects short and stings bounded.** A scare sting that runs long masks the
dialogue it is meant to punctuate.

## Pitfalls

- **Assuming audio will start on its own.** Every browser and mobile WebView
  blocks playback until a user gesture, and a rejected `play()` promise becomes an
  unhandled rejection that can break the game loop. Gate all sound behind one
  unlock on the first real interaction, queue anything requested before it, and
  attach `.catch()` to every `play()`.
- **One `Audio` element per sound.** Rapid repeats cut each other off, so a
  second footstep truncates the first. Keep a small pool per sound and pick a
  free element, restarting on the oldest only when all are busy.
- **Letting a missing audio file throw.** Attach an `error` listener that ignores
  it, and degrade to silence. A 404 on one effect must never stop the game.
- **Treating slider values as dB.** Volume is logarithmic; map `0..1` through
  `linear_to_db` (and back with `db_to_linear`). A linear slider on raw amplitude
  feels like it does nothing until the very bottom.
- **Per-clip volume instead of buses** makes a global balance pass impossible and
  bloats save/settings. Mix on buses.
- **Clipping the master.** Summed sounds exceed 0 dBFS and distort. Leave
  headroom; put a limiter on Master as a safety net, not as the mixer.
- **Pumping ducking**: too-fast release or too-high ratio makes music audibly
  breathe. Lengthen release; lower ratio.
- **Looping a single music track** for the whole game feels flat. Use layers or
  segments that respond to state (see the reference).
- **Beat sync off frame time.** `delta` drifts; read the **audio playback
  position** for musical timing, and account for output latency.
- **Unbounded one-shot players**: spawning AudioStreamPlayers without freeing
  them leaks. Free on `finished`, or use a small pool.

## References

- `references/adaptive-music.md` — vertical layering vs horizontal re-sequencing,
  transition timing (bars/quantize), stingers, intensity mapping, and crossfades.
- `references/synthesized-audio.md` — the full ffmpeg recipe set: ambient beds,
  footsteps, doors, heartbeats, whispers, stingers, and the playback-side pooling
  and unlock code.

## Related skills

- `godot-audio` — buses, `AudioStreamPlayer`, effects, and sync-to-beat in Godot.
- `input-systems` — trigger audio from input actions.
- `physics-tuning` — collision events that drive impact SFX.
- `platformer`, `roguelike` — genres whose feel leans on audio feedback.
