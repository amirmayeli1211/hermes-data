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
| apktool | **3.0.3** (upstream JAR → `/opt/apktool/apktool`) | the apt 2.7.0 package predates the CVE-2024-21633 path-escape fix (2.9.2); REA flags it as a limitation. Replace the launcher and point `REA_APKTOOL_COMMAND` at it |
| tshark / capinfos | 4.2.2 (apt) | packet captures |
| sigrok-cli | 0.7.2 (apt) | signal decoding |
| rizin | 0.9.1 (`rizin-v0.9.1-static-x86_64.tar.xz`) | extract **only** `bin/rizin` + `share/` (≈114 MB); the archive also carries `lib/librz_*.a` and `include/` totalling ~600 MB, and each `rz-*` binary is ~59 MB. See the layout trap below |
| gdb / binutils | 15.1 / 2.42 (apt) | MI sessions + objdump |
| WABT | 1.0.42 (`wabt-1.0.42-linux-x64.tar.gz`) | point `REA_WABT_BIN_DIRECTORY` at `.../bin` |
| wakaru | 1.14.0 (`wakaru-linux-x64.tar.gz`) | JS recovery |
| unblob | 26.6.4 (pip) | needs `libmagic1` |
| pwntools / pyelftools / unicorn | 4.15.0 / 0.33 / 2.1.2 (pip) | offline ELF + core dumps |
| Gradle / bundletool / apksigner | 9.8.2 / 1.18.3 / 0.9 | Android build chain. Standalone `/opt/gradle` was later **removed to reclaim disk** — build through the project's `./gradlew` wrapper instead, and see `hermes-gateway-no-systemd` → `references/disk-reclamation.md` before defending a Gradle cache |
| frida bindings | 17.23.2 via npm `--allow-scripts=frida` | ships inside the rea package |

Unavailable by design: Hopper (macOS), IDA, JEB, Kuna (licensed/proprietary),
Binwalk 3.x (Rust build; `ReFirmLabs/binwalk` publishes **no release assets** —
`v3.1.0` is source-only, pip only ships the unsupported 2.1.0, and `cargo` is not
installed, so `inspect_firmware_regions` stays `capability_unavailable`; use
`extract_firmware`/unblob instead).

**unblob needs an absolute-path env var.** `extract_firmware` fails with
`This integration requires Linux and an absolute REA_UNBLOB_COMMAND path to the
caller-supplied tool` even when `unblob` is on `PATH`. Set
`REA_UNBLOB_COMMAND=/usr/local/bin/unblob` (the pip shim is fine — it `import`s
`unblob.cli` from system python3).

**CLI quirk:** these subcommands take their required arguments **positionally**,
not as flags — `rea extract-firmware <path> <outputDirectory>`. Passing
`--outputDirectory` (or `--output-directory`) returns `Unknown flag`.

## API package that does the heavy lifting

```bash
apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y \
  --no-install-recommends python3 python3-pip python3-venv python3-dev \
  openjdk-21-jdk-headless gdb binutils tshark sigrok-cli \
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
tar -tJf rizin.tar.xz | head -25     # bin/ include/ lib/ librz*.a ... → list before extracting
tar -xJf rizin.tar.xz -C /opt/rizin bin/rizin share    # ~114 MB, not 712 MB
```

Extracting all of `bin/` costs ~650 MB (11 helpers × ~59 MB each, every one
statically linked) and `lib/librz_*.a` is another ~600 MB — on a small disk that
is the difference between a working toolchain and a full filesystem.
`bin/rizin share` is the useful 114 MB. `--strip-components=1` instead produces a
712 MB mess with **no runnable binary**, so verify with
`[ -x /opt/rizin/bin/rizin ]`.

## Layout

```
/opt/ghidra            → symlink to /opt/ghidra_extract/ghidra_12.1.4_PUBLIC
/opt/jadx              → 1.5.6 CLI
/opt/jadx-headless-mcp → jadx-headless-mcp-0.7.1-all.jar
/opt/wabt/wabt-1.0.42/bin
/opt/rizin/bin         → rizin, rz-bin, rz-asm… (symlinked into /usr/local/bin)
/usr/local/bin/wakaru
/opt/apktool/apktool   → apktool 3.0.3 launcher (upstream JAR beside it)
/opt/gradle            → REMOVED to reclaim disk; use the project's ./gradlew wrapper
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
      REA_APKTOOL_COMMAND: /opt/apktool/apktool
      REA_UNBLOB_COMMAND: /usr/local/bin/unblob
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
  "REA could not start ... ask them to restart the MCP client" on the next call.
  Only a client restart cleared it; repeating the call never would have.

## apktool: replacing the distro package with the patched upstream JAR

The apt package is 2.7.0, which REA reports as
`Reported apktool version "2.7.0-dirty" predates the upstream 2.9.2 fix for
CVE-2024-21633`. Upgrade with the upstream JAR and a tiny launcher:

```bash
LATEST=$(curl -sSL https://api.github.com/repos/iBotPeaches/Apktool/releases/latest \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['tag_name'])")   # e.g. v3.0.3
VER=${LATEST#v}
mkdir -p /opt/apktool
curl -sSL -o /opt/apktool/apktool.jar \
  "https://github.com/iBotPeaches/Apktool/releases/download/$LATEST/apktool_${VER}.jar"
printf '#!/bin/sh\nJAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}"\nexec "$JAVA_HOME/bin/java" -jar /opt/apktool/apktool.jar "$@"\n' \
  > /opt/apktool/apktool
chmod +x /opt/apktool/apktool
/opt/apktool/apktool --version     # → 3.0.3
```

Then set `REA_APKTOOL_COMMAND: /opt/apktool/apktool` (config.yaml + `/root/rea-tools.sh`)
and re-run doctor; `environment_healthy: true` confirms the CVE limitation is gone.

**Pitfall — env changes need a client restart.** The REA MCP server inherits
`mcp_servers.rea.env` at launch, so `inspect_apktool_client` keeps reporting the
old launcher until the MCP client restarts. Verify env edits from the CLI
(`source /root/rea-tools.sh && rea doctor --client hermes`) instead of by
re-calling the MCP tool.

## rizin: the 600 MB / missing-binary layout trap

The static tarball is **not** what `--strip-components=1` suggests. Its real
layout is `bin/rizin`, `bin/rz-*` (11 executables, ~59 MB each), `lib/librz_*.a`
(~600 MB), `include/`, `share/`. Extracting the whole archive costs ~712 MB and
`--strip-components=1` *silently loses the main binary*: `share/rizin/...` becomes
`/opt/rizin/rizin/` (a directory), which then collides with the `bin/rizin` file,
so only the `rz-*` helpers survive and `/usr/local/bin/rizin` dangles.

**Two different causes produce the same `ENOENT` symptom**, so diagnose before
reinstalling:

1. **A dangling symlink with no target at all.** A disk sweep that reclaimed
   `/opt/rizin` (see `hermes-gateway-no-systemd` → `references/disk-reclamation.md`)
   leaves `/usr/local/bin/rizin` pointing at nothing.
2. **The strip-components layout bug above** — the target directory exists but the
   binary inside it does not.

Both report `Could not launch the selected rizin executable ... (ENOENT)` while
`ls -la /usr/local/bin/rizin` still looks fine. Discriminate with:

```bash
readlink -f /usr/local/bin/rizin        # empty → cause 1
[ -x /usr/local/bin/rizin ] && echo ok  # never trust `ls` for this
find -L /opt/rizin -maxdepth 1          # `find` needs -L to follow the symlink
```

`find` without `-L` does not follow the symlink and reports **0 files** on a
perfectly healthy Ghidra-style `/opt/<tool>` → extract-dir layout — do not read
that as "the tool is gone".

Extract only what REA needs, keeping the standard layout:

```bash
cd /root/dl
curl -fL -O https://github.com/rizinorg/rizin/releases/download/v0.9.1/rizin-v0.9.1-static-x86_64.tar.xz
rm -rf /opt/rizin && mkdir -p /opt/rizin
tar -xJf rizin-v0.9.1-static-x86_64.tar.xz -C /opt/rizin --no-same-owner bin/rizin share
# → /opt/rizin/bin/rizin (59 MB) + /opt/rizin/share/rizin (56 MB) = ~114 MB
ln -sfn /opt/rizin/bin/rizin /usr/local/bin/rizin
/opt/rizin/bin/rizin -v        # rizin 0.9.1 @ linux-x86-64
```

Confirm from the client with `execute_rizin_command(command="ij", path=<any ELF>)`
— a valid `bin`/`core` JSON means the provider launch path is healthy.

## Verify each external tool from inside REA

`rea doctor` only proves configuration. These calls prove the *wiring*:

| Tool | Call | Healthy result |
|---|---|---|
| adb | `inspect_adb_client` | `version: 37.0.1-…`, `path_source: environment` |
| apktool | `inspect_apktool_client` | version ≥ 2.9.2 and **no** CVE-2024-21633 limitation |
| tshark/capinfos | `inspect_pcap_client` | `tshark_identity_status: verified` + sha256 |
| frida | `list_frida_devices` | local/socket/barebone devices (bindings ship inside the npm package) |
| objdump | `inspect_with_objdump(operation="architectures")` | BFD target table |
| sigrok | `inspect_signal_decoders(limit=1)` | decoder catalog (`examined: 111`) |
| rizin | `execute_rizin_command("ij", …)` | `bin`/`core` JSON |
| jadx | `inspect_android_package(<apk>)` | package/SDK declarations |
| Ghidra | `open_binary(…)` + `binary_overview()` | provider `ghidra`, segment/procedure counts |

Hopper, IDA, JEB and Kuna report `missing_analysis_engine` **by design**
(macOS-only or licensed/proprietary) — on a Linux container that is the expected
final state, not an incomplete install.


