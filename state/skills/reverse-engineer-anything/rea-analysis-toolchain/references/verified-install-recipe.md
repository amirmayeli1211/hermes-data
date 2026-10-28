# Verified install recipe — REA analysis toolchain

Provisioned on Ubuntu 24.04 (container, root shell, no systemd, 2 vCPU / 2 GB
RAM / 7.8 GB disk), REA `rea-agents@6.8.0`, Node 24.22.1. Result:
`rea doctor --client hermes` → `healthy: true`, `environment_healthy: true`.

## Version lanes (as verified by REA's own docs and checks)

| Tool | Installed | Note |
|---|---|---|
| Ghidra | **12.1.4** (`ghidra_12.1.4_PUBLIC_20260921.zip`) | 12.x requires a 64-bit JDK **21+**; 12.2 exists but 12.1.4 is the verified lane |
| JDK | `openjdk-21-jdk-headless` → `/usr/lib/jvm/java-21-openjdk-amd64` | distro `java` was still 17 — set `JAVA_HOME` explicitly |
| jadx bridge | `jadx-headless-mcp-0.7.1-all.jar` | exact version the JADX provider expects |
| jadx CLI | 1.5.6 | optional convenience |
| apktool | 2.7.0 (apt) | resource decode/rebuild |
| tshark / capinfos | 4.2.2 (apt) | packet captures |
| sigrok-cli | 0.7.2 (apt) | signal decoding |
| rizin | 0.9.1 (`rizin-v0.9.1-static-x86_64.tar.xz` → extract `bin/` only) | static libs alone are ~600 MB |
| gdb / binutils | 15.1 / 2.42 (apt) | MI sessions + objdump |
| WABT | 1.0.42 (`wabt-1.0.42-linux-x64.tar.gz`) | point `REA_WABT_BIN_DIRECTORY` at `.../bin` |
| wakaru | 1.14.0 (`wakaru-linux-x64.tar.gz`) | JS recovery |
| unblob | 26.6.4 (pip) | needs `libmagic1` |
| pwntools / pyelftools / unicorn | 4.15.0 / 0.33 / 2.1.2 (pip) | offline ELF + core dumps |
| Gradle / bundletool / apksigner | 9.8.2 / 1.18.3 / 0.9 | Android build chain |
| frida bindings | 17.23.2 via npm `--allow-scripts=frida` | ships inside the rea package |

Unavailable by design: Hopper (macOS), IDA, JEB, Kuna (licensed/proprietary),
Binwalk 3.x (Rust build; no release assets).

## API package that does the heavy lifting

```bash
apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y \
  --no-install-recommends python3 python3-pip python3-venv python3-dev \
  openjdk-21-jdk-headless gdb binutils tshark apktool sigrok-cli \
  xz-utils unzip wget ca-certificates jq cabextract p7zip-full libmagic1
```

`libmagic1` is easy to miss and only surfaces later as
`ImportError: failed to find libmagic` when `unblob` runs.

## Release-asset resolution (no `jq` on a fresh image)

```bash
node -e '
const get = async (u) => (await fetch(u, {headers:{"User-Agent":"setup"}})).json();
(async () => {
  const g = await get("https://api.github.com/repos/NationalSecurityAgency/ghidra/releases");
  for (const rel of g.slice(0,3)) console.log(rel.tag_name, rel.assets.map(a=>a.name).join(" | "));
  const j = await get("https://api.github.com/repos/skylot/jadx/releases/latest");
  console.log("jadx", j.tag_name, j.assets.map(a=>a.name).join(" | "));
})();'
```

GitHub's unauthenticated API is rate-limited (~60/h); after a few lookups,
build the URL from tag + asset name directly
(`https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>`).

Static archive layout — always list first:

```bash
tar -tJf rizin.tar.xz | head -25     # bin/ include/ lib/ librz*.a …  → extract bin/ only
tar -xJf rizin.tar.xz -C /opt/rizin bin
```

`--strip-components=1` on that archive produces a 712 MB mess with no runnable
binary (it eats `bin/`), so verify `ls /opt/rizin/bin`.

## Layout

```
/opt/ghidra            → symlink to /opt/ghidra_extract/ghidra_12.1.4_PUBLIC
/opt/jadx              → 1.5.6 CLI
/opt/jadx-headless-mcp → jadx-headless-mcp-0.7.1-all.jar
/opt/wabt/wabt-1.0.42/bin
/opt/rizin/bin         → rizin, rz-bin, rz-asm… (symlinked into /usr/local/bin)
/usr/local/bin/wakaru
/opt/gradle            → gradle 9.8.2
/opt/android-sdk       → build-tools 34.0.0 (aapt2, d8, zipalign, apksigner),
                         platforms;android-34, cmdline-tools, platform-tools,
                         bundletool/bundletool-all-1.18.3.jar
```

## `mcp_servers.rea.env` (the part that actually makes engines visible)

```yaml
mcp_servers:
  rea:
    command: /usr/local/bin/node
    args: [/usr/local/bin/rea, mcp]
    enabled: true
    env:
      PATH: /usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/jadx/bin:/opt/rizin/bin:/opt/gradle/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/34.0.0:/usr/lib/jvm/java-21-openjdk-amd64/bin
      JAVA_HOME: /usr/lib/jvm/java-21-openjdk-amd64
      GHIDRA_INSTALL_DIR: /opt/ghidra
      REA_JADX_MCP_JAR: /opt/jadx-headless-mcp/jadx-headless-mcp-0.7.1-all.jar
      REA_WABT_BIN_DIRECTORY: /opt/wabt/wabt-1.0.42/bin
      REA_WAKARU_COMMAND: /usr/local/bin/wakaru
      REA_TSHARK_COMMAND: /usr/bin/tshark
      REA_CAPINFOS_COMMAND: /usr/bin/capinfos
      REA_TSHARK_PRLIMIT_COMMAND: /usr/bin/prlimit
      REA_SIGROK_COMMAND: /usr/bin/sigrok-cli
      REA_APKTOOL_COMMAND: /usr/bin/apktool
      REA_ADB_PATH: /opt/android-sdk/platform-tools/adb
      REA_OBJDUMP_COMMAND: /usr/bin/objdump
      REA_GDB_COMMAND: /usr/bin/gdb
      REA_RIZIN_COMMAND: /usr/local/bin/rizin
      REA_PWNTOOLS_PYTHON: /usr/bin/python3
      ANDROID_HOME: /opt/android-sdk
      ANDROID_SDK_ROOT: /opt/android-sdk
```

Mirror of the same values for shell/CLI work: `/root/rea-tools.sh`
(`source /root/rea-tools.sh`). Back up `config.yaml` before editing
(`cp config.yaml config.yaml.manual-backup-$(date +%s)`); `rea setup` also
leaves its own `.rea.backup` beside it.

## Verification transcript

```bash
source /root/rea-tools.sh && rea doctor --client hermes
# healthy: true / environment_healthy: true
# ghidra              : /opt/ghidra
# ghidra-version      : 12.1.4
# ghidra-headless     : /opt/ghidra/support/analyzeHeadless
# ghidra-native_decompiler: …decompile reports elf x86_64, matches linux/x64
# ghidra-java         : 21.0.12.1; 64-bit; JDK; /usr/lib/jvm/java-21-openjdk-amd64
# jadx                : JADX MCP bridge JAR validated at …/jadx-headless-mcp-0.7.1-all.jar
```

session-side (after restarting the client):

```
open_binary(/usr/bin/prlimit) → elf, x86_64, sha256 17064f67e650…
binary_overview()             → analysis_profile.provider = ghidra 12.1.4
                                segment_count 33, procedure_count 164, string_count 192
```

`rea decompile … --procedure main` correctly failed on that stripped binary
("Unknown Ghidra procedure name or address: main") — that is a symbol-resolution
result, not a toolchain problem. Pick a symbol that exists before calling it a
failure.

## Recovery moves used along the way

- Global rea install was a **symlink** to the source clone; deleting the
  clone's `node_modules` broke it (`Cannot find package 'zod'`). Fix:
  `rm /usr/local/lib/node_modules/rea-agents && npm i -g rea-agents@6.8.0`,
  then `npm i -g --allow-scripts=frida rea-agents@6.8.0` for the frida binding.
- After the reinstall, `skill:identity: config_drift` →
  `rea setup --client hermes --skill-client hermes --skill --dry-run` then
  `… --yes` (silent success; prints `appliedActions[1]: installed_skill`).
- Replacing the package directory while the MCP server was live produced
  "REA could not start … ask them to restart the MCP client" on the next call.
  Only a client restart cleared it; repeating the call never would have.
