---
name: native-mcp
description: "MCP client: connect servers, register tools (stdio/HTTP)."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [MCP, Tools, Integrations]
    related_skills: [mcporter]
---

# Native MCP Client

Hermes Agent has a built-in MCP client that connects to MCP servers at startup, discovers their tools, and makes them available as first-class tools the agent can call directly. No bridge CLI needed -- tools from MCP servers appear alongside built-in tools like `terminal`, `read_file`, etc.

## When to Use

Use this whenever you want to:
- Connect to MCP servers and use their tools from within Hermes Agent
- Add external capabilities (filesystem access, GitHub, databases, APIs) via MCP
- Run local stdio-based MCP servers (npx, uvx, or any command)
- Connect to remote HTTP/StreamableHTTP MCP servers
- Have MCP tools auto-discovered and available in every conversation

For ad-hoc, one-off MCP tool calls from the terminal without configuring anything, see the `mcporter` skill instead.

## Prerequisites

- **mcp Python package** -- optional dependency; install with `pip install mcp`. If not installed, MCP support is silently disabled.
- **Node.js** -- required for `npx`-based MCP servers (most community servers)
- **uv** -- required for `uvx`-based MCP servers (Python-based servers)

Install the MCP SDK:

```bash
pip install mcp
# or, if using uv:
uv pip install mcp
```

## Quick Start

Add MCP servers to `~/.hermes/config.yaml` under the `mcp_servers` key:

```yaml
mcp_servers:
  time:
    command: "uvx"
    args: ["mcp-server-time"]
```

Restart Hermes Agent. On startup it will:
1. Connect to the server
2. Discover available tools
3. Register them with the prefix `mcp_time_*`
4. Inject them into all platform toolsets

You can then use the tools naturally -- just ask the agent to get the current time.

## Registering a Server That Ships Its Own Installer

Many MCP servers bundle a `setup` subcommand that writes the `mcp_servers`
entry for you (REA / `rea-agents`, and similar npm-distributed servers). Two
rules separate a working registration from one that breaks a week later.

**1. Install the package globally first — never let `npx` paths into the config.**

Installers usually resolve the command to whichever binary invoked them. Run
the installer through `npx` and it will happily write a path like
`~/.npm/_npx/6a7ef3e74bb1f228/node_modules/.bin/rea` into your config. That is
a content-addressed cache — npm prunes it, and the registration then dies
silently with no config change to explain it. Install globally first so the
installer resolves a stable path:

```bash
npm install -g <package>                    # e.g. npm install -g rea-agents
which <binary>                              # verify: /usr/local/bin/rea
<binary> setup --client hermes --dry-run    # confirm the planned command is the global path
```

**2. Bare `setup` usually just prints a doctor report.**

Server-agnostic pattern: `setup` with no scope argument prints a status report
with `plannedActions: []` and exits 0. That is not an error and nothing was
written. Name the client explicitly, preview, then apply:

```bash
<binary> setup --client hermes --dry-run    # prints plannedActions[]
<binary> setup --client hermes --yes        # applies; writes a .backup beside the config
```

`--all-detected` configures every detected agent instead of naming one. Respect
the tool's consent model — the plan is meant to require approval before writing,
so always dry-run first and show the user the target paths that would change.

### Verification: handshake the server before trusting the registration

Restart-only verification is slow and its failure mode ("tools missing") is
ambiguous. Probe the stdio server directly with a JSON-RPC `initialize` frame
and read `serverInfo`:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  | timeout 20 <command> <args...> 2>&1 | head -c 800
```

A healthy server replies with `{"result":{"protocolVersion":...,"serverInfo":{"name":...}}}`.
Non-zero exit or silence means the registration is broken no matter what the
setup tool reported.

### Post-registration checklist

- Confirm the entry landed under `mcp_servers:` (not `mcp:`) with `command` and
  `args` split — see the Configuration Reference above.
- Diff against the backup the installer wrote to confirm only intended keys
  changed. Installers commonly re-serialize the whole YAML; list-indentation
  shifts are normal and harmless — verify values, not whitespace.
- Adding a server needs a **restart** (no hot reload). No tool appears until then.
- Servers that bundle a skill install it under `~/.hermes/skills/`; that skill
  shows up in the session's skill list *immediately*, before any restart. Do not
  confuse the two when reporting "installed".

See `references/npm-mcp-server-install.md` for a worked end-to-end transcript
(REA / `rea-agents`, including the Node.js prerequisite when the distro package
is too old for the server's pin).

## Configuration Reference

Each entry under `mcp_servers` is a server name mapped to its config. There are two transport types: **stdio** (command-based) and **HTTP** (url-based).

### Stdio Transport (command + args)

```yaml
mcp_servers:
  server_name:
    command: "npx"             # (required) executable to run
    args: ["-y", "pkg-name"]   # (optional) command arguments, default: []
    env:                       # (optional) environment variables for the subprocess
      SOME_API_KEY: "value"
    timeout: 120               # (optional) per-tool-call timeout in seconds, default: 120
    connect_timeout: 60        # (optional) initial connection timeout in seconds, default: 60
```

### HTTP Transport (url)

```yaml
mcp_servers:
  server_name:
    url: "https://my-server.example.com/mcp"   # (required) server URL
    headers:                                     # (optional) HTTP headers
      Authorization: "Bearer sk-..."
    timeout: 180               # (optional) per-tool-call timeout in seconds, default: 120
    connect_timeout: 60        # (optional) initial connection timeout in seconds, default: 60
```

### All Config Options

| Option            | Type   | Default | Description                                       |
|-------------------|--------|---------|---------------------------------------------------|
| `command`         | string | --      | Executable to run (stdio transport, required)     |
| `args`            | list   | `[]`    | Arguments passed to the command                   |
| `env`             | dict   | `{}`    | Extra environment variables for the subprocess    |
| `url`             | string | --      | Server URL (HTTP transport, required)             |
| `headers`         | dict   | `{}`    | HTTP headers sent with every request              |
| `timeout`         | int    | `120`   | Per-tool-call timeout in seconds                  |
| `connect_timeout` | int    | `60`    | Timeout for initial connection and discovery      |

Note: A server config must have either `command` (stdio) or `url` (HTTP), not both.

## How It Works

### Startup Discovery

When Hermes Agent starts, `discover_mcp_tools()` is called during tool initialization:

1. Reads `mcp_servers` from `~/.hermes/config.yaml`
2. For each server, spawns a connection in a dedicated background event loop
3. Initializes the MCP session and calls `list_tools()` to discover available tools
4. Registers each tool in the Hermes tool registry

### Tool Naming Convention

MCP tools are registered with the naming pattern:

```
mcp_{server_name}_{tool_name}
```

Hyphens and dots in names are replaced with underscores for LLM API compatibility.

Examples:
- Server `filesystem`, tool `read_file` → `mcp_filesystem_read_file`
- Server `github`, tool `list-issues` → `mcp_github_list_issues`
- Server `my-api`, tool `fetch.data` → `mcp_my_api_fetch_data`

### Auto-Injection

After discovery, MCP tools are automatically injected into all `hermes-*` platform toolsets (CLI, Discord, Telegram, etc.). This means MCP tools are available in every conversation without any additional configuration.

### Connection Lifecycle

- Each server runs as a long-lived asyncio Task in a background daemon thread
- Connections persist for the lifetime of the agent process
- If a connection drops, automatic reconnection with exponential backoff kicks in (up to 5 retries, max 60s backoff)
- On agent shutdown, all connections are gracefully closed

### Idempotency

`discover_mcp_tools()` is idempotent -- calling it multiple times only connects to servers that aren't already connected. Failed servers are retried on subsequent calls.

## Transport Types

### Stdio Transport

The most common transport. Hermes launches the MCP server as a subprocess and communicates over stdin/stdout.

```yaml
mcp_servers:
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
```

The subprocess inherits a **filtered** environment (see Security section below) plus any variables you specify in `env`.

### HTTP / StreamableHTTP Transport

For remote or shared MCP servers. Requires the `mcp` package to include HTTP client support (`mcp.client.streamable_http`).

```yaml
mcp_servers:
  remote_api:
    url: "https://mcp.example.com/mcp"
    headers:
      Authorization: "Bearer sk-..."
```

If HTTP support is not available in your installed `mcp` version, the server will fail with an ImportError and other servers will continue normally.

## Security

### Environment Variable Filtering

For stdio servers, Hermes does NOT pass your full shell environment to MCP subprocesses. Only safe baseline variables are inherited:

- `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TERM`, `SHELL`, `TMPDIR`
- Any `XDG_*` variables

All other environment variables (API keys, tokens, secrets) are excluded unless you explicitly add them via the `env` config key. This prevents accidental credential leakage to untrusted MCP servers.

```yaml
mcp_servers:
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      # Only this token is passed to the subprocess
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_..."
```

### Giving a server a toolchain through `env`

stdio servers are spawned with the filtered baseline above, so anything the
server needs beyond `PATH`/`HOME` must be listed under `env`. Three behaviours
matter in practice:

- `env` is **merged over** the baseline, so adding keys never drops `PATH`.
  Overriding `PATH` *does* replace the inherited one — list every directory the
  server and its engines need. A trimmed `PATH` is the most common cause of
  "works in my shell, never from MCP".
- Environment is read **once, at server start**. Editing
  `mcp_servers.<name>.env` changes nothing for the already-running process; the
  client must restart before the change exists.
- Many servers are bring-your-own-engine: they install nothing and read their
  engine locations from the environment.

```yaml
mcp_servers:
  rea:
    command: /usr/local/bin/node
    args: [/usr/local/bin/rea, mcp]
    env:
      PATH: /usr/local/bin:/usr/bin:/bin:/opt/jadx/bin
      JAVA_HOME: /usr/lib/jvm/java-21-openjdk-amd64   # a Java engine needs its own JDK
      GHIDRA_INSTALL_DIR: /opt/ghidra
      REA_JADX_MCP_JAR: /opt/jadx-headless-mcp/jadx-headless-mcp-0.7.1-all.jar
```

A Java-based engine needs `JAVA_HOME` even when `java` is already on `PATH`: the
distro default is often older than the engine's declared minimum (Ghidra 12.x
requires 21 while `/usr/bin/java` can still be 17).

**Verify in two steps, and check identity — not liveness:**

1. Before restarting, run the server's own doctor/version probe in a shell with
   the *same* variables exported (`env A=1 B=2 <server> doctor`). That proves
   the values themselves are right.
2. After the restart, make one real tool call and read the engine identity out
   of the result (provider id/version, resolved path). A call that merely
   returns a value is not proof the engine was found.

Restarting a client that has no service manager (`systemd`) — see
`hermes-gateway-no-systemd`.

**Never replace a server's files while it is running.** Deleting or
reinstalling the package directory under a live MCP connection kills it; the
client then reports a startup failure for that server and every later call fails
identically until the client restarts (retrying the same call cannot help).
Also check what "installed" means: a global install made from a local path
(`npm i -g /path/to/repo`) leaves `.../lib/node_modules/<pkg>` as a **symlink**
to that source tree, so deleting the tree's `node_modules` breaks the "global"
binary. Prefer the registry (`npm i -g <pkg>@<version>`) and confirm with
`readlink -f "$(which <bin>)"`. Some packages need a postinstall that an npm
allowlist can silently skip (`npm i -g --allow-scripts=<dep> <pkg>@<version>`),
leaving a native feature unavailable with no error at call time.

A worked example of wiring a full engine toolchain (Ghidra + JDK, jadx,
packet/signal/WASM helpers) into one MCP server, with the verified versions and
the `doctor` output that proves it, is in
`references/mcp-server-engine-toolchain.md`.

### Credential Stripping in Error Messages

If an MCP tool call fails, any credential-like patterns in the error message are automatically redacted before being shown to the LLM. This covers:

- GitHub PATs (`ghp_...`)
- OpenAI-style keys (`sk-...`)
- Bearer tokens
- Generic `token=`, `key=`, `API_KEY=`, `password=`, `secret=` patterns

## Troubleshooting

### "MCP SDK not available -- skipping MCP tool discovery"

The `mcp` Python package is not installed. Install it:

```bash
pip install mcp
```

### "No MCP servers configured"

No `mcp_servers` key in `~/.hermes/config.yaml`, or it's empty. Add at least one server.

### "Failed to connect to MCP server 'X'"

Common causes:
- **Command not found**: The `command` binary isn't on PATH. Ensure `npx`, `uvx`, or the relevant command is installed.
- **Package not found**: For npx servers, the npm package may not exist or may need `-y` in args to auto-install.
- **Timeout**: The server took too long to start. Increase `connect_timeout`.
- **Port conflict**: For HTTP servers, the URL may be unreachable.

### "MCP server 'X' requires HTTP transport but mcp.client.streamable_http is not available"

Your `mcp` package version doesn't include HTTP client support. Upgrade:

```bash
pip install --upgrade mcp
```

### Tools not appearing

- Check that the server is listed under `mcp_servers` (not `mcp` or `servers`)
- Ensure the YAML indentation is correct
- Look at Hermes Agent startup logs for connection messages
- Tool names are prefixed with `mcp_{server}_{tool}` -- look for that pattern

### Connection keeps dropping

The client retries up to 5 times with exponential backoff (1s, 2s, 4s, 8s, 16s, capped at 60s). If the server is fundamentally unreachable, it gives up after 5 attempts. Check the server process and network connectivity.

## Examples

### Time Server (uvx)

```yaml
mcp_servers:
  time:
    command: "uvx"
    args: ["mcp-server-time"]
```

Registers tools like `mcp_time_get_current_time`.

### Filesystem Server (npx)

```yaml
mcp_servers:
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/documents"]
    timeout: 30
```

Registers tools like `mcp_filesystem_read_file`, `mcp_filesystem_write_file`, `mcp_filesystem_list_directory`.

### GitHub Server with Authentication

```yaml
mcp_servers:
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_xxxxxxxxxxxxxxxxxxxx"
    timeout: 60
```

Registers tools like `mcp_github_list_issues`, `mcp_github_create_pull_request`, etc.

### Remote HTTP Server

```yaml
mcp_servers:
  company_api:
    url: "https://mcp.mycompany.com/v1/mcp"
    headers:
      Authorization: "Bearer sk-xxxxxxxxxxxxxxxxxxxx"
      X-Team-Id: "engineering"
    timeout: 180
    connect_timeout: 30
```

### Multiple Servers

```yaml
mcp_servers:
  time:
    command: "uvx"
    args: ["mcp-server-time"]

  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]

  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_xxxxxxxxxxxxxxxxxxxx"

  company_api:
    url: "https://mcp.internal.company.com/mcp"
    headers:
      Authorization: "Bearer sk-xxxxxxxxxxxxxxxxxxxx"
    timeout: 300
```

All tools from all servers are registered and available simultaneously. Each server's tools are prefixed with its name to avoid collisions.

## Sampling (Server-Initiated LLM Requests)

Hermes supports MCP's `sampling/createMessage` capability — MCP servers can request LLM completions through the agent during tool execution. This enables agent-in-the-loop workflows (data analysis, content generation, decision-making).

Sampling is **enabled by default**. Configure per server:

```yaml
mcp_servers:
  my_server:
    command: "npx"
    args: ["-y", "my-mcp-server"]
    sampling:
      enabled: true           # default: true
      model: "gemini-3-flash" # model override (optional)
      max_tokens_cap: 4096    # max tokens per request
      timeout: 30             # LLM call timeout (seconds)
      max_rpm: 10             # max requests per minute
      allowed_models: []      # model whitelist (empty = all)
      max_tool_rounds: 5      # tool loop limit (0 = disable)
      log_level: "info"       # audit verbosity
```

Servers can also include `tools` in sampling requests for multi-turn tool-augmented workflows. The `max_tool_rounds` config prevents infinite tool loops. Per-server audit metrics (requests, errors, tokens, tool use count) are tracked via `get_mcp_status()`.

Disable sampling for untrusted servers with `sampling: { enabled: false }`.

## Notes

- MCP tools are called synchronously from the agent's perspective but run asynchronously on a dedicated background event loop
- Tool results are returned as JSON with either `{"result": "..."}` or `{"error": "..."}`
- The native MCP client is independent of `mcporter` -- you can use both simultaneously
- Server connections are persistent and shared across all conversations in the same agent process
- Adding or removing servers requires restarting the agent (no hot-reload currently)
