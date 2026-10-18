#!/bin/sh
# generate-audio.sh — synthesize every sound effect the game needs.
#
# WHY SYNTHESIS INSTEAD OF DOWNLOADING
#   Downloaded assets arrive with unclear licensing and unknown provenance, and
#   a horror game needs sounds tuned to its own pacing. ffmpeg can generate all
#   of it from noise and oscillators, so the whole soundtrack is a few hundred KB,
#   is reproducible from this script alone, and carries no licence question.
#
#   Every file is mono 22.05 kHz — deliberately low-fidelity. It keeps the total
#   size tiny, suits a pixel game, and the harshness reads as "old recording",
#   which is what a horror soundtrack wants.
#
# Output: assets/audio/*.mp3  (mp3 chosen over ogg for maximum Android WebView
#         compatibility, since these ship inside an APK later.)

set -eu

OUT="${1:-/data/.hermes/workspace/horror-game/assets/audio}"
FF="${FFMPEG:-ffmpeg}"
FF="$(command -v "$FF" || echo /usr/local/bin/ffmpeg)"

mkdir -p "$OUT"

# Common encoding: mono, 22.05 kHz, 80 kbps. Small, and fine for effects.
ENC="-ac 1 -ar 22050 -b:a 80k -y -loglevel error"

say() { printf '  %-22s ' "$1"; }

# --- ambient beds (looped) -------------------------------------------------

# A low drone: two sines a fifth apart with slow beating, plus a brown-noise bed.
# The beating (55 Hz vs 82.5 Hz) is what makes it feel unsettled rather than calm.
say "ambient_drone"
"$FF" -f lavfi -i "sine=frequency=55:duration=20" \
       -f lavfi -i "sine=frequency=82.5:duration=20" \
       -f lavfi -i "anoisesrc=color=brown:duration=20:amplitude=0.25" \
       -filter_complex "[0:a][1:a][2:a]amix=inputs=3:duration=shortest,\
lowpass=f=320,tremolo=f=0.12:d=0.45,volume=1.5,afade=t=in:d=2,afade=t=out:st=18:d=2" \
       $ENC "$OUT/ambient_drone.mp3" && echo ok || echo FAIL

# Wind through a broken window: brown noise, heavily lowpassed, with a slow
# sweeping band so it gusts instead of hissing flatly.
say "ambient_wind"
"$FF" -f lavfi -i "anoisesrc=color=brown:duration=15:amplitude=0.8" \
       -af "lowpass=f=700,highpass=f=80,tremolo=f=0.18:d=0.7,volume=0.9,\
afade=t=in:d=1.5,afade=t=out:st=13:d=2" \
       $ENC "$OUT/ambient_wind.mp3" && echo ok || echo FAIL

# Basement: a very low rumble plus a slow drip pulse. Distinct from the drone so
# the player can tell which floor they are on by ear alone.
say "ambient_basement"
"$FF" -f lavfi -i "sine=frequency=41:duration=16" \
       -f lavfi -i "anoisesrc=color=brown:duration=16:amplitude=0.5" \
       -filter_complex "[0:a][1:a]amix=inputs=2:duration=shortest,\
lowpass=f=180,volume=1.8,afade=t=in:d=2,afade=t=out:st=14:d=2" \
       $ENC "$OUT/ambient_basement.mp3" && echo ok || echo FAIL

# --- one-shots -------------------------------------------------------------

# Heartbeat. Two thumps per cycle: 'lub' is slightly louder and lower than 'dub'.
# Built as a decaying 50 Hz sine so it feels physical rather than clicky.
say "heartbeat"
"$FF" -f lavfi -i "sine=frequency=50:duration=1.20" \
       -af "volume=6,aeval='val(0)*exp(-12*t)':c=same,\
aecho=0.7:0.6:120:0.35,highpass=f=35" \
       $ENC "$OUT/heartbeat.mp3" && echo ok || echo FAIL

# A whisper: pink noise band-limited to the vocal consonant range, amplitude-
# modulated at an irregular rate so it reads as syllables rather than a hiss.
say "whisper"
"$FF" -f lavfi -i "anoisesrc=color=pink:duration=2.2:amplitude=0.7" \
       -af "highpass=f=900,lowpass=f=3200,\
tremolo=f=5.5:d=0.85,tremolo=f=0.7:d=0.5,volume=0.7,\
afade=t=in:d=0.3,afade=t=out:st=1.7:d=0.5" \
       $ENC "$OUT/whisper.mp3" && echo ok || echo FAIL

# Door: a low creak (pitch-swept sawtooth-ish tone) plus the wooden thud of it
# stopping. The sweep is what makes it a hinge instead of a beep.
say "door"
"$FF" -f lavfi -i "sine=frequency=140:duration=1.4" \
       -f lavfi -i "anoisesrc=color=brown:duration=1.4:amplitude=0.6" \
       -filter_complex "[0:a]vibrato=f=7:d=0.6,volume=1.2[a];\
[1:a]lowpass=f=500,volume=1.4[b];[a][b]amix=inputs=2:duration=shortest,\
highpass=f=90,afade=t=in:d=0.2,afade=t=out:st=1.1:d=0.3" \
       $ENC "$OUT/door.mp3" && echo ok || echo FAIL

# Footsteps: two variants with slightly different filtering so a repeated step
# does not sound like a loop. Short noise burst + a low body thump.
for variant in 1 2; do
    say "footstep_$variant"
    if [ "$variant" = "1" ]; then LP=1100; FREQ=70; else LP=850; FREQ=62; fi
    "$FF" -f lavfi -i "anoisesrc=color=white:duration=0.22:amplitude=0.9" \
           -f lavfi -i "sine=frequency=$FREQ:duration=0.22" \
           -filter_complex "[0:a]lowpass=f=$LP,volume=1.5[a];\
[1:a]volume=4,aeval='val(0)*exp(-28*t)':c=same[b];\
[a][b]amix=inputs=2:duration=shortest,afade=t=out:st=0.12:d=0.10" \
           $ENC "$OUT/footstep_$variant.mp3" && echo ok || echo FAIL
done

# Picking up a note: a soft, slightly detuned two-note chime. Detuning avoids the
# "happy UI blip" feel that would break the mood.
say "pickup"
"$FF" -f lavfi -i "sine=frequency=523:duration=1.0" \
       -f lavfi -i "sine=frequency=497:duration=1.0" \
       -filter_complex "[0:a][1:a]amix=inputs=2:duration=shortest,\
aeval='val(0)*exp(-4*t)':c=same,aecho=0.6:0.5:180:0.3,volume=1.1" \
       $ENC "$OUT/pickup.mp3" && echo ok || echo FAIL

# A single drip, for the basement and the bathroom.
say "drip"
"$FF" -f lavfi -i "sine=frequency=1800:duration=0.35" \
       -af "aeval='val(0)*exp(-45*t)':c=same,aecho=0.8:0.7:90:0.45,volume=1.2" \
       $ENC "$OUT/drip.mp3" && echo ok || echo FAIL

# Radio static: white noise with a slow gate, so it crackles instead of sitting
# flat. Used when a tape or radio is interacted with — the story delivery device.
say "static"
"$FF" -f lavfi -i "anoisesrc=color=white:duration=3.0:amplitude=0.55" \
       -af "highpass=f=600,tremolo=f=9:d=0.6,tremolo=f=0.4:d=0.4,\
volume=0.8,afade=t=in:d=0.2,afade=t=out:st=2.6:d=0.4" \
       $ENC "$OUT/static.mp3" && echo ok || echo FAIL

# The scare sting: a dissonant cluster (tritone) with a fast attack and noise
# transient. Loud on purpose, but it is a SHORT file so it cannot mask dialogue.
say "sting"
"$FF" -f lavfi -i "sine=frequency=220:duration=1.6" \
       -f lavfi -i "sine=frequency=311:duration=1.6" \
       -f lavfi -i "anoisesrc=color=white:duration=1.6:amplitude=0.9" \
       -filter_complex "[0:a][1:a]amix=inputs=2:duration=shortest[tones];\
[2:a]lowpass=f=4500,volume=0.5,aeval='val(0)*exp(-9*t)':c=same[noise];\
[tones][noise]amix=inputs=2:duration=shortest,\
aeval='val(0)*(1+1.8*exp(-14*t))':c=same,volume=1.3,\
afade=t=out:st=1.0:d=0.6" \
       $ENC "$OUT/sting.mp3" && echo ok || echo FAIL

# UI click for menus — deliberately dull and quiet, not a bright "button".
say "ui_click"
"$FF" -f lavfi -i "anoisesrc=color=brown:duration=0.09:amplitude=0.8" \
       -af "lowpass=f=900,volume=1.2,afade=t=out:st=0.03:d=0.05" \
       $ENC "$OUT/ui_click.mp3" && echo ok || echo FAIL

# --- report ---------------------------------------------------------------

printf '\n'
n=$(find "$OUT" -name '*.mp3' | wc -l | tr -d ' ')
tot=$(du -sk "$OUT" | cut -f1)
printf 'generated %s files, %s KB total\n' "$n" "$tot"
find "$OUT" -name '*.mp3' -printf '  %-24f %6s B\n' 2>/dev/null | sort || \
    ls -la "$OUT"
