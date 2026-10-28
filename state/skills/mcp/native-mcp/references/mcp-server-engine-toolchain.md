# Wiring a full engine toolchain into one MCP server (worked example: REA / `rea-agents`)

REA registers a single `rea` stdio server but delegates all deep analysis to
bring-your-own engines. `rea setup` never installs them, and the server reports
availability through its own doctor. This is the end-to-end recipe for going
from `environment_healthy: false` to a verified engine call, on a Linux host
(Ubuntu 24.04 container, no systemd, root shell, ~7.8 GB disk).

## 1. Read the server's own gate first

```bash
rea doctor --client hermes        # healthy: true, environment_healthy: false
```

The report names every missing piece and the exact env var that would satisfy
it (`GHIDRA_INSTALL_DIR`, `REA_JADX_MCP_JAR`, `REA_KUNA_COMMAND`,
`REA_TSHARK_COMMAND`, `REA_APTTOOL_COMMAND`, `REA_WABT_BIN_DIRECTORY`, …). Treat
it as the checklist — do not guess versions.

Docs in the source tree are the authority on pins and lanes:

```bash
grep -rn "REA_[A-Z0-9_]*" ~/rea/docs | sort -u      # every env var the server reads
grep -rniE "ghidra 1[12]|JDK 21" ~/rea/docs/*.md    # the verified version lane
```

## 2. Verified version lanes (do not "upgrade" past these)

| Piece | Pin that REA verifies | Why it matters |
|---|---|---|
| Ghidra | **12.1.4** + JDK 21 (Ghidra 12.x requires 21+) | newer 12.2 exists; the verified lane is 12.1.4 |
| jadx bridge | `jadx-headless-mcp-0.7.1-all.jar` | exact version expected by the JADX provider |
| jadx CLI | any 1.x (optional; the jar bundles jadx-core) | convenience only |
| WABT | 1.0.42 | asset naming is `wabt-<ver>-linux-x64.tar.gz` |
| wakaru | v1.14.0 (`wakaru-linux-x64.tar.gz`) | JS recovery |
| Sigrok | 0.7.2 (`apt` is already correct) | signal decoding |
| pwntools / pyelftools / unicorn | 4.15.0 / 0.33 / 2.1.2 | offline ELF + core-dump lanes |
| unblob | 26.6.4 (`pip`, needs `libmagic1`) | firmware extraction |
| Binwalk | 3.1.x | **no release assets** — needs a Rust build; skip unless required |
| Hopper / IDA / JEB / Kuna | n/a | macOS-only or licensed/proprietary — cannot be installed |

## 3. Resolve release assets without `jq`

Fresh images often have `curl` but no `jq`; Node is usually present for an
npm-distributed server:

```bash
node -e '
const get = async (u) => (await fetch(u, {headers:{"User-Agent":"setup"}})).json();
(async () => {
  const r = await get("https://api.github.com/repos/NationalSecurityAgency/ghidra/releases");
  for (const rel of r.slice(0,3)) console.log(rel.tag_name, rel.assets.map(a=>a.name).join(" | "));
})();'
```

Un-authenticated GitHub API is rate-limited (~60/h); once several lookups run,
prefer constructing the download URL directly from the tag + asset name.

## 4. Install layout used (everything under `/opt`)

```bash
apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y \
  --no-install-recommends python3 python3-pip python3-venv python3-dev \
  openjdk-21-jdk-headless gdb binutils tshark apktool sigrok-cli \
  xz-utils unzip wget ca-certificates jq cabextract p7zip-full libmagic1
```

- Ghidra → `/opt/ghidra` (symlink to the extracted `ghidra_12.1.4_PUBLIC/`).
- jadx → `/opt/jadx`, bridge jar → `/opt/jadx-headless-mcp/`.
- WABT → `/opt/wabt/wabt-1.0.42/bin` (point `REA_WABT_BIN_DIRECTORY` at the `bin`).
- wakaru → `/usr/local/bin/wakaru`.
- python tools: `python3 -m pip install --break-system-packages -U
  "pwntools==4.15.0" "pyelftools==0.33" "unicorn==2.1.2"` and `unblob==26.6.4`.

Static archives deserve care: the rizin static tarball expands to ~600 MB of
`.a` files. Extract only what runs:

```bash
tar -tJf rizin.tar.xz | head -20        # inspect layout FIRST
tar -xJf rizin.tar.xz -C /opt/rizin bin # then extract just bin/
```

## 5. Hand the environment to the MCP server

```yaml
mcp_servers:
  rea:
    command: /usr/local/bin/node
    args: [/usr/local/bin/rea, mcp]
    env:
      PATH: /usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/jadx/bin:/opt/rizin/bin:/opt/gradle/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/34.0.0:/usr/lib/jvm/java-21-openjdk-amd64/bin
      JAVA_HOME: /usr/lib/jvm/java-21-openjdk-amd64
      GHIDRA_INSTALL_DIR: /opt/ghidra
      REA_JADX_MCP_JAR: /opt/jadx-headless-mcp/jadx-headless-mcp-0.7.1-all.jar
      # …plus REA_*_COMMAND / REA_*_BIN_DIRECTORY for each installed helper
```

Keep a sourceable copy for shell use (`/root/rea-tools.sh`) so the CLI and the
MCP server see identical values. `env` is merged over the filtered baseline, so
this adds without dropping `PATH` — but it *replaces* `PATH` if you set it.

## 6. Restart, then verify identity

```bash
pkill -TERM -f "venv/bin/hermes gateway run"     # supervisor respawns in ~5s
source /root/rea-tools.sh && rea doctor --client hermes
#  healthy: true
#  environment_healthy: true
#  ghidra-version: 12.1.4 · ghidra-java: 21.0.12.1 · ghidra-headless: ok
```

Then a real call through the session, reading the engine out of the result:

```
open_binary(/usr/bin/prlimit)   → {"format":"elf","kind":"executable","sha256":"1706…"}
binary_overview()               → analysis_profile.provider = ghidra 12.1.4,
                                  procedure_count 164, segment_count 33, string_count 192
```

`provider_version: 12.1.4` in the Evidence is the proof; a non-empty reply is not.

## 7. Pitfalls that cost time

- **A global npm install from a local path is a symlink.** `npm i -g
  /home/user/rea` left `/usr/local/lib/node_modules/rea-agents → /home/user/rea`,
  so deleting the source clone's `node_modules` (to free ~870 MB) broke the
  "global" binary with `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'`.
  Recovery: `rm` the symlink, then `npm i -g rea-agents@<version>` from the
  registry — self-contained, ~200 MB, and independent of the clone.
- **frida bindings need their install script.** npm prints
  "1 package has install scripts not yet covered by allowScripts: frida"; the
  package installs but the native module is missing. Fix:
  `npm i -g --allow-scripts=frida rea-agents@<version>`, then confirm
  `node -e "require('<pkg>/node_modules/frida')"`.
- **The server's bundled skill is vendor-owned.** `rea setup` (and any repair
  run) rewrites `~/.hermes/skills/reverse-engineer-anything/`, so host-specific
  notes must live in your own skill, not in the vendor's file.
- **Reinstalling the server creates skill drift.**
  `doctor` then reports `skill:identity: config_drift`; repair with
  `rea setup --client hermes --skill-client hermes --skill --dry-run` (shows
  `plannedActions[]`) and apply with `--yes`.
- **Disk is part of the install.** Ghidra ~900 MB extracted, rizin static
  ~630 MB, JDK ~300 MB. Delete archives after extraction (`/root/dl`), and
  check `df -h /` before large fetches; a full `/tmp` tmpfs breaks unrelated
  tooling.
- **A dead engine means a live-server restart, not a retry.** Once the MCP
  server's files were replaced under it, calls returned
  "REA could not start … ask them to restart the MCP client" — a startup
  failure that repeating the call never fixes.
