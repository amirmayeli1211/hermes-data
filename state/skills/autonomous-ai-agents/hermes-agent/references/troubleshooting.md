# Troubleshooting

### Voice not working
1. Check `stt.enabled: true` in config.yaml
2. Verify provider: `python -c "import pm; pm.sync_venv(['stt-whisper'], explicit=True)"` or set API key
3. In gateway: `/restart`. In CLI: exit and relaunch.

### Tool not available
1. `hermes tools` — check if toolset is enabled for your platform
2. Some tools need env vars (check `.env`)
3. `/reset` after enabling tools

### Model/provider issues
1. `hermes doctor` — check config and dependencies
2. `hermes auth` — re-authenticate OAuth providers (or `hermes auth add <provider>`)
3. Check `.env` has the right API key
4. **Copilot 403**: `gh auth login` tokens do NOT work for Copilot API. You must use the Copilot-specific OAuth device code flow via `hermes model` → GitHub Copilot.

### Changes not taking effect
- **Tools/skills:** `/reset` starts a new session with updated toolset
- **Config changes:** In gateway: `/restart`. In CLI: exit and relaunch.
- **Code changes:** Restart the CLI or gateway process

### web_extract shows a stale page (result caching)
`web_search`/`web_extract` cache results for 20 minutes (PR #94618) — a
repeat fetch of the same URL within the TTL is served from cache, which
can look like "my website changes aren't showing up."

Automatic carveouts (always fetched live, never cached):
- localhost / 127.0.0.1 / `*.local` / `*.localhost` / single-label LAN
  hostnames / private + link-local IP ranges (dev servers, hot-reload
  builds, chat-GUI artifact previews)
- URLs matched by `security.website_blocklist`
- failed responses and keyless-rescue-served responses

Developing a site tested over the PUBLIC internet (Vercel/Netlify
preview, ngrok/cloudflared tunnel, staging domain)? Public DNS isn't
auto-carved-out — list the host in config.yaml:

```yaml
web:
  cache_exempt_hosts:      # always fetched live; effective immediately
    - mysite.vercel.app
    - "*.ngrok-free.app"
    - mysite.dev           # suffix match: also covers preview.mysite.dev
```

Blunt instruments: `web.cache_ttl_minutes: 1` (min) or
`web.cache_enabled: false` disables both caches entirely.

### Skills not showing
1. `hermes skills list` — verify installed
2. `hermes skills config` — check platform enablement
3. Load explicitly: `hermes -s name` (or the skill's own `/<name>` slash command)

### Gateway issues
Check logs first:
```bash
grep -i "failed to send\|error" ~/.hermes/logs/gateway.log | tail -20
```

Common gateway problems:
- **Gateway dies on SSH logout**: Enable linger: `sudo loginctl enable-linger $USER`
- **Gateway dies on WSL2 close**: WSL2 requires `systemd=true` in `/etc/wsl.conf` for systemd services to work. Without it, gateway falls back to `nohup` (dies when session closes).
- **Gateway crash loop**: Reset the failed state: `systemctl --user reset-failed hermes-gateway`

### Platform-specific issues
- **Discord bot silent**: Must enable **Message Content Intent** in Bot → Privileged Gateway Intents.
- **Slack bot only works in DMs**: Must subscribe to `message.channels` event. Without it, the bot ignores public channels.
- **Windows-specific issues** (`Alt+Enter` newline, WinError 10106, UTF-8 BOM config, line endings): see `references/windows-quirks.md`.

### Auxiliary models not working
If `auxiliary` tasks (vision, compression, session_search) fail silently, the `auto` provider can't find a backend. Either set `OPENROUTER_API_KEY` or `GOOGLE_API_KEY`, or explicitly configure each auxiliary task's provider:
```bash
hermes config set auxiliary.vision.provider <your_provider>
hermes config set auxiliary.vision.model <model_name>
```

### "No space left on device" / the state volume fills up
Hermes points `TMPDIR`/`TMP`/`TEMP` at `<HERMES_HOME>/cache/scratch` at boot. When
`HERMES_HOME` is a small mounted volume rather than the container overlay, every
temp file written by any tool lands on that small volume — a single large job can
exhaust it and take the gateway down with the whole process group.

Diagnose in this order:
```sh
df -h "$HERMES_HOME" /              # compare the state volume against the overlay
findmnt -T "$HERMES_HOME" -o SOURCE,FSTYPE
du -sh "$HERMES_HOME"/* | sort -rh | head -12
python3 -c 'import tempfile; print(tempfile.gettempdir())'
```

Two facts about the override that are easy to get wrong:

- A user-set `TMPDIR` (environment or `HERMES_HOME/.env`) is **respected** —
  `apply_scratch_tmp_env()` leaves it alone, and `python3 -c "import tempfile"`
  follows it. So setting `TMPDIR` in `.env` to a roomier path is the supported fix.
- A `TMPDIR` naming a **missing** directory does not error: `tempfile` silently
  falls through to the next candidate, which is `<HERMES_HOME>/cache/scratch` on
  the small volume. Recreate that directory on boot, or the offload quietly
  stops working after a container recreate.

Do not symlink `<HERMES_HOME>/cache/scratch` at another filesystem — `os.replace`
is a rename and raises `EXDEV` across devices, breaking atomic writes. Redirect
`TMPDIR` instead. `hermes scratch`-style pruning (24h idle) only covers Hermes's
own scratch dir, not a redirected temp root.

Floor planning for a two-tier container, the measurement recipes, and a
re-runnable check: see the `github-first-storage` skill
(`references/disk-tiers.md`, `scripts/disk-tier-check.sh`).

### "Reset permissions" / auto-approving everything
See `references/security-privacy.md` — wipe the "Always allow" stores, don't touch yolo mode.

