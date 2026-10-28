# Installing an npm-distributed MCP server end-to-end

Worked example: REA (`morluto/rea`, npm package `rea-agents`) registered with
Hermes. The shape generalizes to any npm-package MCP server that ships its own
`setup` subcommand.

## 0. Node.js prerequisite

Read the pin before installing anything:

```bash
git clone https://github.com/<owner>/<repo>
cd <repo> && cat .nvmrc
grep -A3 '"engines"\|"packageManager"' package.json
```

If the distro/apt Node is older than the pin, install the official tarball into
`/usr/local` rather than arguing with the project's requirement:

```bash
uname -m                                   # confirm arch → linux-x64
curl -sI https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz | head -1
mkdir -p /root/dl && cd /root/dl
curl -sL -o node.tar.xz https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz
tar -xf node.tar.xz
cp -r node-v24.22.1-linux-x64/bin/*     /usr/local/bin/
cp -r node-v24.22.1-linux-x64/lib/*     /usr/local/lib/
cp -r node-v24.22.1-linux-x64/include/* /usr/local/include/   # optional
cp -r node-v24.22.1-linux-x64/share/*   /usr/local/share/     # optional
PATH="/usr/local/bin:$PATH" node -v && npm -v
```

### Pick the download dir deliberately

Check `/tmp` before downloading tens of MB into it. On many container images
`/tmp` is a small tmpfs (~1 GB) that is already full, and `curl` fails with a
misleading `curl: (23) Failure writing output to destination` instead of a disk
space error:

```bash
df -h /tmp
du -sh /tmp/* 2>/dev/null | sort -rh | head -5   # find the hog
```

If it is tmpfs and near 100%, download to a directory on the real filesystem
(`/root/dl`, `$HOME/dl`) instead.

### PATH ordering

When a project's `AGENTS.md`/`README` says the pinned toolchain lives under
`/usr/local/bin`, prefix `PATH="/usr/local/bin:$PATH"` on every `node`/`npm`
invocation. An older Node earlier on `PATH` otherwise silently wins.

## 1. Build from source (cloned repos only)

An installer run against an unbuilt source clone fails with a message that is
itself the instruction:

```
REA's compiled runtime is missing. Run `npm ci && npm run build:cached` in
/home/user/rea to install dependencies and build REA, then restart it.
```

Follow it literally, and put long builds in a background process so the turn
isn't held open:

```bash
npm ci                    # use the project's own documented command
npm run build:cached
```

npm 11 may warn that packages have "install scripts not yet covered by
allowScripts" (e.g. `esbuild` postinstall). The build can still succeed — only
chase it if the build actually fails.

## 2. Install globally so the registration path is stable

```bash
npm install -g .              # from the clone, keeps your local build
# or: npm install -g <package-name>
which <binary>                # expect /usr/local/bin/<binary>
```

Skipping this is what produces the transient `~/.npm/_npx/<hash>/...` command
in the config.

## 3. Run the server's own setup against the client

```bash
<binary> setup --client hermes --dry-run
<binary> setup --client hermes --yes
```

Observed output shape (REA):

```
status: ready
plannedActions[2]:
  - id: "configure_client:hermes"   target: /home/user/.hermes/config.yaml
    operation: update               backupPath: .../config.yaml.rea.backup
    detail: Command: "/usr/local/bin/node" "/usr/local/bin/rea" "mcp"
  - id: "install_skill:hermes"      target: /home/user/.hermes/skills/reverse-engineer-anything
appliedActions[2]: configured_hermes,installed_skill
clients:
  hermes: {status: configured, backupPath: ...}
```

Take your own timestamped backup too. The installer writes one, but a manual
copy makes the later diff unambiguous:

```bash
cp ~/.hermes/config.yaml ~/.hermes/config.yaml.manual-backup-$(date +%s)
```

Resulting config block:

```yaml
mcp_servers:
  rea:
    command: /usr/local/bin/node
    args:
      - /usr/local/bin/rea
      - mcp
    enabled: true
```

## 4. Verify

```bash
<binary> doctor --client hermes                # scope_checks should be healthy
grep -n -A25 "^mcp_servers:" ~/.hermes/config.yaml
diff <prior-copy> ~/.hermes/config.yaml
```

Then handshake the server (parent SKILL.md) and separately confirm any bundled
skill appears in the session's skill list.

### `environment_healthy: false` is not a failed install

`doctor` reports `environment_healthy: false` when optional native analysis
engines (Ghidra, IDA, jadx, kuna) are absent. These are bring-your-own by
design — the installer will not download them. Static JavaScript, browser,
Electron, and managed-code analysis need no native engine and work regardless.
Report it as "engines not configured", not as a broken install.
