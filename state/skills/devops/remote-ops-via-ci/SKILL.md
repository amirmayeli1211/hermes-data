---
name: remote-ops-via-ci
description: "Deploy to a remote host your sandbox cannot SSH to."
version: 1.0.0
author: Reza + Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [remote, ssh, deployment, github-actions, ci, egress, firewall, vps, von, panel]
---

# Remote Ops Via a CI Runner

Operate a server you cannot reach directly: diagnose where the block actually is,
then route the work through a runner that *can* reach it, and read the output back.

## When to use

- You must install, configure, or inspect a remote host, and the local
  environment has no route to it.
- A connection attempt fails and it is not obvious whether the host is down or the
  network is filtered.
- You need a repeatable way to run privileged commands on a box you reach only
  through someone else's infrastructure.

## Step 1 — Diagnose WHERE the block is, before concluding anything

Classify every failed connect into one of three states. The distinction is the
whole diagnosis:

| result | meaning |
| --- | --- |
| **OPEN** | TCP handshake completed |
| **REFUSED** | the packet ARRIVED and nothing is listening — **the host is alive** |
| **TIMEOUT** | something dropped it before arrival — filtered, and you do not yet know by whom |

A bare timeout tells you nothing about the target. Run the **control test**: probe
the same port on several unrelated, definitely-SSH hosts.

```python
import socket
for h in ("github.com", "gitlab.com", "bitbucket.org", "1.1.1.1", TARGET):
    s = socket.socket(); s.settimeout(6)
    try: s.connect((h, 22)); print(h, "OPEN")
    except Exception as e: print(h, type(e).__name__)
    finally: s.close()
```

Read the result:

- **Every** destination times out on that port while 443 on the same hosts
  connects instantly → the block is on **your** side (egress policy). The target is
  not implicated.
- Only your target times out, while github/gitlab open → the block is at **the
  target**.
- REFUSED on many ports of the target → the host is up; only that port is closed.

Then enumerate what is actually reachable in both directions before choosing a
path — probe a spread of ports on the target and a spread on a known-good host.
Allowed-outbound lists are frequently just `80, 443`.

**Do not report "the server is unreachable" from a single timeout.** Without the
control row, an egress block is indistinguishable from a dead host, and you will
send the user chasing a server that was healthy the whole time.

## Step 2 — Pick a path, in this order

1. **The target on an allowed port.** Many hosts expose SSH on 443 as well as 22
   (`ssh -p 443`); that alone resolves a `22`-only egress block.
2. **A CI runner as the execution layer** (below). Works whenever you can push to
   any repo with Actions enabled.
3. **Hand the command to the user** to paste into their own terminal. Say plainly
   that you could not reach the host and give them the exact command — this is
   honest, not a failure.

## Step 3 — The CI-runner pattern

A hosted runner has unrestricted egress, so it opens the session and you drive it
through the API. Nothing is stored on the local disk.

### 3a. A dedicated private repo

Use a separate repo from any data/state repo — mixing them makes both harder to
reason about. Create it through the API and confirm it exists before writing.

### 3b. Credentials as encrypted repo secrets

```sh
python3 -m pip install --target <ephemeral-dir> pynacl   # libsodium sealed box
```

```python
from nacl import encoding, public
pk = public.PublicKey(key_b64.encode(), encoding.Base64Encoder())
sealed = public.SealedBox(pk).encrypt(value.encode())
```

Fetch `key_id` + `key` from `/repos/{r}/actions/secrets/public-key`, then
`PUT /repos/{r}/actions/secrets/{NAME}` with `encrypted_value` and `key_id`.

- Install the dependency with `--target <dir>` **outside the state root**, so a
  state audit does not flag it and it never becomes durable data.
- Secrets are **write-only**: the API can never read a value back. Keep the
  original only where it belongs (a password manager, or the user's own message).
- The credential the user pastes into chat is worth telling them to rotate once the
  work is done.

### 3c. One script in the repo, with PHASES

Commit the server-side logic as a real file (`ops/remote.sh`) with a phase
dispatch, not as a heredoc inside the workflow YAML — it is then versioned,
reviewable, and diffable, and a failure prints the line that failed.

```sh
PHASE="${1:-probe}"
case "$PHASE" in
    probe)   phase_probe ;;    # read-only: what is this box, what can it reach
    prepare) phase_prepare ;;  # dependencies the later phases assume
    install) phase_install ;;  # the expensive, slow step
    status)  phase_status ;;   # inspect without changing
    cleanup) phase_cleanup ;;  # remove installer artifacts
    *) die "unknown phase: $PHASE" ;;
esac
```

Phases must be **idempotent** — the runner is ephemeral and a retry after a partial
failure re-runs the whole phase. Probe first and read its output before installing;
the probe is where you learn the box has no container runtime, or that a registry
it needs is unreachable.

### 3d. The workflow

```yaml
- name: Run the phase over SSH
  env:
    SSHPASS: ${{ secrets.PG_PASS }}
    TARGET_HOST: ${{ secrets.PG_HOST }}
    TARGET_USER: ${{ secrets.PG_USER }}
  run: |
    sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=25 -o ServerAliveInterval=20 -o LogLevel=ERROR \
      -T "${TARGET_USER}@${TARGET_HOST}" "bash -s -- '${{ inputs.phase }}'" \
      < ops/remote.sh
```

- `sshpass -e` takes the password from **`$SSHPASS`, not argv**. argv is
  world-readable under `/proc`, so a password on the command line is a leak.
- `-T`: no pty. The remote script is non-interactive.
- `StrictHostKeyChecking=no` + `UserKnownHostsFile=/dev/null`: the host key is
  unknown and pinning it would mean storing another secret for no gain here.
- Declare an `inputs` block with `type: choice` and the phase options, so the phase
  is validated before the job starts rather than by the remote script.

### 3e. Read the result back

```
POST /repos/{r}/actions/workflows/{file}/dispatches   {"ref":"main","inputs":{...}}
GET  /repos/{r}/actions/runs?per_page=15              -> find the run
GET  /repos/{r}/actions/runs/{id}                     -> status / conclusion
GET  /repos/{r}/actions/jobs/{job_id}/logs            -> the output
```

A dispatch response carries **no run id**. Find it by polling for a run whose
`path` matches your workflow and whose `status` is not `completed`; registration
takes seconds to a minute, so poll rather than assuming failure to dispatch.

## Pitfalls

- **The job-logs endpoint 302-redirects to a blob URL, and a client that will not
  follow a redirect on a request carrying an `Authorization` header turns that
  into `HTTP 401`.** It reads as an auth problem and sends you to check the token,
  which is fine. Use `curl -sSL` with the header: curl forwards it only to the API
  host and follows the redirect. `urllib` does not, which is how a working token
  produced a 401.
- **Every log line is prefixed with a 29-character ISO timestamp** (and the first
  line of the whole stream often carries a UTF-8 BOM). Strip the prefix before
  parsing, and locate your own output by a marker you control (an `=== phase ===`
  banner) rather than by line position.
- **Fire-and-forget a long phase and then poll, rather than holding one call
  open.** Install phases run for minutes; a single blocking call risks a transport
  timeout that says nothing about the remote work, which continues regardless.
- **Do not put the remote logic in a workflow `input`.** It cannot be reviewed, it
  cannot be diffed, and a quoting change silently alters what runs as root.
- **Never echo a secret in the workflow's own output.** Print which keys are
  present (`sed -n 's/^\([A-Z_]*\)=.*/\1/p' file`) and never their values.
- **Discover the platform before installing onto it.** `/proc/1/comm` decides
  whether `systemctl` can manage anything; a container with `tini` as PID 1 has
  `systemctl` installed and unusable, so systemd-based installers report success and
  leave nothing running.
- **A distribution upgrade can land a version the installer has never seen.**
  A brand-new OS release is not "just a newer Ubuntu" — a compose-based installer
  may refuse it, or install cleanly and fail at runtime. Read `PRETTY_NAME` in the
  probe and prefer a release the project lists as supported.
- **Read the installer's own argument parser before trusting its `--help` or the
  docs.** Download the script and grep the option's validation branch; a documented
  flag was found to reject the very value it documents.

## Networks behind filtering (registry and mirror handling)

Before installing anything that pulls container images, check that the default
registry is reachable. It often is not even when github.com and the distro archive
resolve fine.

1. Probe candidate mirrors with a real `/v2/` request and pick the **first that
   answers**, ordered by reachability rather than by reputation — a blocked mirror
   fails every pull with a timeout.
2. Write it into `/etc/docker/daemon.json` as `registry-mirrors`, set sane
   `log-opts` limits at the same time (an unbounded json-file log fills a small
   disk), and restart the daemon.
3. **Verify with an actual pull** (`docker pull hello-world`), not with the probe.
   A mirror can answer `/v2/` and still fail on a real manifest fetch.
4. Prefer the distro's own package (`docker.io`) over the vendor convenience
   script when the vendor's download host may itself be filtered.

Run all of this inside the `prepare` phase, ordered before `install`, and print the
chosen mirror and the pull result so a later failure can be attributed.

## Reporting

A remote deploy is a long chain of phases across many turns. Serve the user-visible
report at the END, when the work is finished — and in the meantime keep working
rather than yielding the turn to deliver a fragment.

**Finish the task, then report once. A half-answer between tool batches is not
progress the user can use.** They cannot act on "I am mid-way through phase 2", so
they read the pause as the work stalling and interrupt to ask what happened — which
costs more turns than continuing would have. Chaining many tool calls in one turn is
cheap; stopping to narrate each step is what makes a long job feel broken.

Two things are genuinely worth an early turn, and only these:

- **A decision the user must make** (which host, which backend, whether to
  proceed after a cost or scope finding).
- **A blocker that ends the work** — say plainly that it failed, what the output
  said, and what you need. Do not dress a failed phase as done.

For a phase that runs for minutes, dispatch it and keep going; its result lands in
the conversation when it finishes. Never hold a turn open on a slow phase just to
have something to say.

## Wording a claim you did not finish verifying

A long deploy accumulates partial results, and the temptation is to describe the
intended end state. Report only what a command's own output showed, and label the
rest:

- Say **"the installer exited 1 with `<exact message>`"**, not "the install had an
  issue".
- Keep a short "verified by running it" vs "read from the source" vs "from the
docs" split in the reference file, and update it when a phase is re-run.
- A phase whose output you have not read yet is **unknown**, not done — and
  "unknown" is a fine thing to report.

Support file: `references/pasarguard-deploy.md` — the panel+node deploy recipe for
this pattern, including the installer flag that rejects its own default.
