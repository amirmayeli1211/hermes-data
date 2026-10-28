---
name: hermes-gateway-no-systemd
description: "Keep the Hermes gateway permanently alive on hosts without systemd (Docker/tini/boxd sandboxes, WSL without systemd=true) using a detached supervisor loop."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [hermes, gateway, systemd, watchdog, supervisor, container, docker, wsl, uptime]
    related_skills: [hermes-agent]
---

# Keeping the Hermes gateway alive without systemd

## When to use this

Load this skill when the user reports any of:

- "The agent goes offline / falls asleep if I don't message it for a few minutes"
- "The gateway keeps dying"
- "Keep yourself always online"
- You find the gateway running as a child of a TTY shell

…**and** the host has no systemd (`hermes gateway install` won't work).

## Diagnose first — do not guess

### 1. Confirm there is no systemd

```bash
ls /run/systemd/system 2>/dev/null         # no output → no systemd
ps -p 1 -o comm=                           # tini / dumb-init / bash → container
```

### 2. Confirm the gateway is TTY-attached

```bash
ps -eo pid,ppid,sid,tty,cmd | grep "gateway ru[n]"
```

A `TT` like `pts/0` (instead of `?`) means it will die with that terminal.

### 3. Find the actual cause in the logs

```bash
grep -n "Shutdown context" ~/.hermes/logs/errors.log
tail -30 ~/.hermes/logs/gateway-shutdown-diag.log
grep -n "Starting Hermes Gateway\|Gateway stopped\|Exiting with code" ~/.hermes/logs/gateway.log
```

The smoking gun looks like:

```
WARNING gateway.run: Shutdown context: signal=SIGTERM under_systemd=no parent_name=bash
INFO gateway.run: Exiting with code 1 (signal-initiated shutdown without restart request)
  so systemd Restart=on-failure can revive the gateway.
```

## Why the obvious fixes fail

| Idea | Why it fails |
|------|--------------|
| Hermes cron job that `pgrep`s + relaunches | The cron ticker runs **inside** the gateway process. Gateway down ⇒ cron down ⇒ nothing relaunches it. Chicken-and-egg. |
| `hermes gateway install` | Requires systemd/launchd. Silently unusable on this host. |
| `nohup hermes gateway run &` in a terminal tool call | Rejected in foreground commands; and `tools/environments/local.py` `killpg()`s the whole process group on cleanup. |
| Just restarting it once manually | It dies again on the next TTY close. |

**Root cause:** `gateway/run.py` deliberately exits with code **1** on an
unexpected SIGTERM so that systemd's `Restart=on-failure` revives it. With no
systemd, that contract has no counterpart — so you must supply the supervisor.

## The fix — two layers

### Layer 1 (primary): detached supervisor loop

Create `~/.hermes/scripts/gateway_supervisor.sh`:

```bash
#!/bin/bash
set -u

HERMES_BIN="/usr/local/lib/hermes-agent/venv/bin/hermes"
LOG_DIR="${HOME}/.hermes/logs"
SUP_LOG="${LOG_DIR}/gateway-supervisor.log"
LOCK_FILE="${HOME}/.hermes/gateway-supervisor.lock"   # NOT /tmp — it may be a full tmpfs
RESTART_DELAY=5
GW_PATTERN="venv/bin/hermes gateway run"

export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin"
mkdir -p "$LOG_DIR"
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >> "$SUP_LOG"; }

# Single instance
exec 9>"$LOCK_FILE"
flock -n 9 || { log "another supervisor holds the lock"; exit 0; }

# Clear any stale unsupervised gateway so two Telegram pollers never race
waited=0
while pgrep -f "$GW_PATTERN" >/dev/null 2>&1; do
    [ "$waited" -eq 0 ] && log "stale gateway detected — SIGTERM"
    pkill -TERM -f "$GW_PATTERN" 2>/dev/null
    sleep 2; waited=$((waited + 2))
    if [ "$waited" -ge 120 ]; then pkill -KILL -f "$GW_PATTERN"; sleep 2; break; fi
done
[ "$waited" -gt 0 ] && log "stale gateway cleared after ${waited}s"

log "=== supervisor started (pid $$) ==="

delay="$RESTART_DELAY"
while true; do
    started_at=$(date +%s)
    log "launching: $HERMES_BIN gateway run"
    "$HERMES_BIN" gateway run < /dev/null >> "$SUP_LOG" 2>&1
    rc=$?
    ran_for=$(( $(date +%s) - started_at ))
    # adaptive backoff so a crash loop doesn't spin
    if [ "$ran_for" -lt 10 ]; then
        delay=$(( delay * 2 )); [ "$delay" -gt 60 ] && delay=60
    else
        delay="$RESTART_DELAY"
    fi
    log "gateway exited rc=$rc after ${ran_for}s — restarting in ${delay}s"
    sleep "$delay"
done
```

### Layer 1b: detached launcher

Create `~/.hermes/scripts/start_gateway_supervisor.sh`:

```bash
#!/bin/bash
set -u
setsid nohup "${HOME}/.hermes/scripts/gateway_supervisor.sh" >/dev/null 2>&1 &
exit 0
```

### Layer 2: silent cron safety net

Create `~/.hermes/scripts/gateway_keepalive.sh`:

```bash
#!/bin/bash
set -u
SUPERVISOR="${HOME}/.hermes/scripts/gateway_supervisor.sh"
SUP_LOG="${HOME}/.hermes/logs/gateway-supervisor.log"
SUP_PATTERN="scripts/gateway_supervisor.sh"   # note: 'scripts/' prefix avoids
                                              # matching start_gateway_supervisor.sh
export PATH="/usr/local/bin:/usr/bin:/bin"

# Healthy → print NOTHING. Empty stdout = the cron scheduler sends no message.
pgrep -f "$SUP_PATTERN" >/dev/null 2>&1 && exit 0

mkdir -p "$(dirname "$SUP_LOG")"
printf '[%s] keepalive: supervisor missing — relaunching\n' "$(date -u +%FT%TZ)" >> "$SUP_LOG"
setsid nohup "$SUPERVISOR" >/dev/null 2>&1 &
sleep 3

if pgrep -f "$SUP_PATTERN" >/dev/null 2>&1; then
    echo "⚠️ Gateway supervisor was down — relaunched. Back online in ~10s."
else
    echo "❌ Supervisor down and could NOT be relaunched. Check $SUP_LOG"
fi
```

Install it (script arg must be a **bare filename** — `~/.hermes/scripts/` is
implied):

```
cronjob(action="create", name="Gateway Supervisor Keepalive",
        no_agent=True, schedule="*/5 * * * *",
        script="gateway_keepalive.sh")
```

### Cut over without cutting off the current reply

The supervisor kills the running gateway, which tears down the session you are
talking through. Arm the swap **detached with a delay** so your reply is
delivered first. Put this in a script file (a bare `setsid` in a foreground
terminal call is rejected):

```bash
#!/bin/bash
setsid nohup bash -c 'sleep 30; exec /home/user/.hermes/scripts/start_gateway_supervisor.sh' >/dev/null 2>&1 &
exit 0
```

Then run `bash /path/kick_cutover.sh`, reply to the user, and warn them that
~15 seconds of silence follows. The session survives — the conversation is in
the SessionDB, so the new gateway keeps the same session and the user's next
message lands normally.

## Verify

```bash
# supervisor: PPID 1, TTY '?'  |  gateway: PPID == supervisor PID, TTY '?'
ps -eo pid,ppid,sid,tty,cmd | grep -E "scripts/gateway_superviso[r].sh|gateway ru[n]"

tail -20 ~/.hermes/logs/gateway-supervisor.log
grep -n "Connected to Telegram\|telegram connected\|Cron ticker started" ~/.hermes/logs/gateway.log | tail
```

Expect `TPGID`/TTY `?` for both, `✓ telegram connected`, and
`Cron ticker started (interval=60s)`.

**Real test that the watchdog works:** kill the gateway and confirm the
supervisor brings it back within ~5s.

```bash
pkill -f "venv/bin/hermes gateway ru[n]"   # bracket trick avoids self-match
sleep 12
pgrep -af "venv/bin/hermes gateway ru[n]"
```

## Pitfalls

- **`pkill -f "pattern"` can kill your own shell.** The pattern appears in the
  shell's own command line. Always bracket one character:
  `pkill -f "my_scrip[t].sh"`.
- **Don't put the lock file in `/tmp`** on hosts where `/tmp` is a small or
  full tmpfs. Use `$HOME/.hermes/`.
- **Cron `script` must be a bare filename**, relative to `~/.hermes/scripts/`.
  Absolute or `~/`-prefixed paths are rejected.
- **No-agent cron jobs are silent only on empty stdout.** Any `echo` in the
  healthy path becomes a message to the user every tick. Keep the healthy path
  print-free.
- **Two gateways = Telegram polling conflict** (`Conflict: terminated by other
  getUpdates request`). That's why the supervisor clears stale gateways and
  holds an `flock`.
- **If the whole sandbox is suspended by the host when idle**, nothing inside
  the container can fix it — say so rather than over-promising.
- Check `~/.hermes/logs/errors.log`; it also surfaces unrelated but useful
  facts (deprecated `.env` keys, provider quota errors).
