---
name: rea-analysis-toolchain
description: "Install, wire and verify the bring-your-own analysis engines and helper CLIs that REA (rea-agents) delegates deep analysis to: Ghidra + JDK, jadx bridge jar, packet/signal/WASM/firmware helpers, Android build tools. Use when rea doctor reports environment_healthy: false, when an engine is missing or the wrong version, or when a user asks to install/repair REA's tooling."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [rea, ghidra, jadx, reverse-engineering, toolchain, mcp, engines, apktool, jadx-headless-mcp]
    related_skills: [native-mcp, hermes-gateway-no-systemd, hermes-agent]
---

# REA analysis toolchain (bring-your-own engines)

REA ships one stdio MCP server but delegates all deep analysis to engines it
never installs. Its own doctor is the specification: it names each missing
engine and the exact environment variable that satisfies it. This skill covers
installing those pieces, wiring the environment so the MCP server actually sees
them, and verifying with evidence rather than optimism.

**Companion docs:** the vendor skill `reverse-engineer-anything` (installed by
`rea setup`) covers *using* REA. This skill covers *provisioning* it, because
edits to the vendor skill are overwritten by the next `rea setup` run.

**Generic MCP mechanics** (env merge semantics, restart requirement, the
symlinked-global-install trap) live in `native-mcp`, section "Giving a server a
toolchain through `env`", plus its worked example
`references/mcp-server-engine-toolchain.md`.

## When to use this

- `rea doctor --client hermes` → `environment_healthy: false`
- "install the tools", "why can't you decompile / open an APK"
- `ghidra`, `jadx`, `kuna` checks report `missing_analysis_engine`
- after any `rea` reinstall, when `skill:identity` reports `config_drift`
- the user wants a capability that needs a helper CLI (packet capture, signal
  decoding, WASM, firmware extraction, Android resources/build)

## Workflow

1. **Read the gate, don't guess.**
   ```bash
   rea doctor --client hermes
   ```
   Every failure line carries the variable name and the expected version lane.
2. **Confirm the pins in the source tree** (not from memory, not "latest"):
   ```bash
   grep -rhoE "REA_[A-Z0-9_]+" ~/rea/docs | sort -u     # env vars the server reads
   grep -rniE "Ghidra 1[12]|JDK 21" ~/rea/docs/*.md    # verified version lanes
   ```
   REA's docs state, per tool, the exact build its parsers were verified
   against. Stay on that lane: a newer Ghidra exists and is *not* the verified
   lane. See `references/verified-install-recipe.md` for the table.
3. **Install into a stable, documented root** (`/opt/<tool>`), never into a
   build tree or a home cache, and record the path in one env file.
4. **Set the env on the MCP server, not just in your shell.** The server is
   spawned by the gateway with a filtered environment; values that only exist
   in your shell are invisible to it. Put them under
   `mcp_servers.rea.env` in `~/.hermes/config.yaml` **and** keep a sourceable
   copy (`/root/rea-tools.sh`) for CLI work. Both must stay in sync.
5. **Restart the client** so the server process is born with the new env. On a
   host without systemd: kill the gateway and let the supervisor respawn it
   (`hermes-gateway-no-systemd` → "Deliberate restart"). Send the user-facing
   summary *before* arming the restart.
6. **Verify in two steps, then state what is still impossible.**
   - server-side: `source <envfile> && rea doctor --client hermes` →
     `environment_healthy: true`, with the engine version echoed back.
   - session-side: one real call, reading the provider out of the result
     (`analysis_profile.provider = ghidra 12.1.4`, plus counts). A non-empty
     reply is not evidence the engine was found.

## What can and cannot be installed

Installable on a Linux container: Ghidra + JDK, jadx/bridge jar, apktool,
tshark/capinfos, rizin, gdb/binutils, sigrok-cli, WABT, wakaru, unblob,
pwntools/pyelftools/unicorn, Android SDK + Gradle + bundletool.

Not installable — say so plainly instead of hunting: **Hopper** (macOS only),
**IDA** and **JEB** (licensed, BYO registration: `REA_IDA_MCP_CONFIG`,
`REA_JEB_MCP_URL`), **Kuna** (proprietary), and **Binwalk 3.x** (no published
release assets; needs a Rust build — Unblob usually covers extraction anyway).

## Pitfalls

- **A global install from a local path is a symlink.** `npm i -g <local-dir>`
  leaves `.../lib/node_modules/<pkg> → <local-dir>`. Freeing disk by deleting
  the source tree's `node_modules` then breaks the "installed" server with
  `ERR_MODULE_NOT_FOUND`. Install from the registry
  (`npm i -g <pkg>@<version>`) so the server is self-contained, and check
  `readlink -f "$(which rea)"`.
- **npm allowlists can skip a needed postinstall.** A native dependency
  (frida) installs but its binding is absent until
  `npm i -g --allow-scripts=<dep> <pkg>@<version>`.
- **Never reinstall over a live server.** Replacing the package directory while
  the MCP connection is up kills it; the client then reports a startup failure
  that no amount of retrying fixes — only a client restart.
- **Reinstalling rea creates `skill:identity` drift.** Repair with
  `rea setup --client hermes --skill-client hermes --skill` (dry-run first: it
  prints `plannedActions[]`; apply with `--yes`). It also *overwrites* the
  vendor skill, so never park host knowledge in that file.
- **Disk budget is part of the design.** Ghidra extracted ≈ 900 MB, static
  rizin ≈ 630 MB, JDK ≈ 300 MB, Android SDK ≈ 470 MB. Prefer extracting only
  what runs (`tar -xJf … bin`), delete archives after unpacking, and free the
  source clone's `node_modules` when the CLI is registry-installed.
- **Static archives ship their own build tree.** Always `tar -t`/`unzip -l`
  before extracting; a `--strip-components=1` on a flat archive silently
  scatters binaries and static libs (it cost a 712 MB mis-extraction once).
- **Jar/host tools need the right JDK, not just any JDK.** Ghidra 12.x needs
  21; set `JAVA_HOME` explicitly in the MCP env (the distro default may be 17).
- **`pip` on Ubuntu 24.04 is externally managed** — use
  `--break-system-packages` for the pinned REA lane, and install `libmagic1`
  or `unblob` fails at import.

## Reporting (this user)

Long installs are reported **once, at the end**, as one structured log in
Persian: what was installed with versions, where it went, where the env was
set (plus the config backup path), what was verified, and what could not be
installed and why. Do not narrate step-by-step progress or send per-step
messages; the user reads the final log and will ask follow-ups from it. They
also want the *plan/status* stated up front when they join a session mid-task,
and they expect the action to be taken rather than proposed.

## Reference

- `references/verified-install-recipe.md` — exact versions, URLs, apt list,
  `/opt` layout, the `mcp_servers.rea.env` block, and the verification
  transcript from a full provision on Ubuntu 24.04.
