# PasarGuard panel + node deploy (via a CI runner)

PasarGuard is a compose-based proxy panel plus worker nodes, built on Xray-core.
Official docs: `docs.pasarguard.org`; scripts: `github.com/PasarGuard/scripts`.

This reference records the phase order, the concrete commands, and the two things
that actually bite on a fresh box in a filtered network.

## What was verified, and what was not

Be precise when reusing this, because the difference matters:

- **Verified by running it:** the `probe` phase, and the `prepare` phase — Docker
  installed from the distro archive, a domestic registry mirror selected and
  configured, and a real `docker pull hello-world` succeeding through it.
- **Read from the installer source, not from a successful run:** the `--database`
  flag behaviour described below. The install phase was attempted, failed on that
  flag, and the cause was established by downloading the installer and reading its
  argument parser. The install itself was **not** re-run successfully.
- **From the official docs:** node install commands, minimum sizing, the CLI
  surface, and the requirement that the dashboard needs TLS.

## Phase order

```
probe    -> what is this box, what can it reach           (read-only)
prepare  -> docker + registry mirror                      (assumed by install)
install  -> the panel                                      (slow)
node     -> a worker node on the same box                  (slow)
status   -> inspect without changing
cleanup  -> delete installer artifacts from /root
```

Run `probe` first and read it. On the box this was built for it revealed: 1 vCPU,
~956 MB RAM, 19 GB disk, `systemd` as PID 1 (so the normal service paths work),
**no container runtime installed**, and `registry-1.docker.io` unreachable while
`github.com` and the distro archive were fine. Every one of those changed the plan.

## Sizing

| resource | documented node minimum |
| --- | --- |
| RAM | 1 GB |
| CPU | 1 core |
| storage | 10 GB |

SQLite is the right database backend for a single small box: it keeps the stack to
one container with no external database service to run and tune.

## Panel install

```sh
curl -fsSL https://raw.githubusercontent.com/PasarGuard/scripts/main/pasarguard.sh -o /root/pasarguard.sh
chmod +x /root/pasarguard.sh
bash /root/pasarguard.sh install --no-ssl </dev/null
```

- `--no-ssl`: skips the interactive certificate wizard. The dashboard then binds to
  localhost and is reached through an SSH tunnel (`ssh -L 8000:localhost:8000`) —
  suitable for setup and for a panel that must not expose a public TLS listener.
- `</dev/null`: the installer prompts. Redirecting stdin makes every prompt take
  its default instead of hanging a CI job forever.
- Files land in `/opt/pasarguard`, config in `/opt/pasarguard/.env`, data in
  `/var/lib/pasarguard`.

After install, `sudo pasarguard status`, and generate the one-time owner key:

```sh
pasarguard cli generate-temp-key
```

### The `--database` flag rejects its own default

Passing `--database sqlite` exits 1:

```
Unsupported database type: sqlite
```

That message is misleading — SQLite **is** the default. In the installer the
variable is initialised to `sqlite`, then the `--database` case validates the
supplied value against a regex that accepts only
`mysql|mariadb|postgresql|timescaledb`. There is no way to *name* sqlite, because
naming it is never necessary.

**Rule: for SQLite, omit the flag entirely.** Use `--database <engine>` only for one
of those four engines. The install command in the official docs that reads
`install --database sqlite` is wrong and will fail.

## Node install

```sh
curl -fsSL https://raw.githubusercontent.com/PasarGuard/scripts/main/pg-node.sh -o /root/pg-node.sh
chmod +x /root/pg-node.sh
bash /root/pg-node.sh install --self-signed </dev/null
```

- `--self-signed` generates a SAN certificate for the panel↔node link, so no domain
  is needed to bring the pair up.
- Multiple nodes on one server: pass `--name <NAME>` at install and thereafter use
  that name as the command prefix (`<name> status`). **Do not reuse ports between
  node instances** — the connection port and the Xray config must be unique per
  instance, and a collision fails in a way that looks like the node being down.

CLI surface: `pg-node status`, `up`/`down`/`restart`, `logs`, `core-update`,
`geofiles`, `renew-cert`, and `service-*` for the companion systemd daemon.

## Docker mirror, for a filtered network

The default registry was unreachable from the box this was built for while github
and the OS archive were not. Candidate domestic mirrors, probed with a real `/v2/`
request and the first responder used:

```
https://docker.arvancloud.ir
https://docker.iranserver.com
https://registry.docker.ir
https://mirror-docker.runflare.com
https://focker.ir
```

```json
// /etc/docker/daemon.json
{
  "registry-mirrors": ["<chosen>"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
```

Then `systemctl restart docker` and **prove it with a real pull**
(`docker pull hello-world`); a mirror that answers `/v2/` can still fail on a
manifest fetch. Install the runtime from the distro archive (`docker.io` +
`docker-compose-v2`) rather than the vendor convenience script when the vendor's
download host may itself be filtered.

## Reaching the dashboard

Docs: access at `https://YOUR_DOMAIN:8000/dashboard/`. Without a domain or a
certificate, forward the port over SSH and use `http://localhost:8000/dashboard/` —
testing only, since access dies with the terminal. For a long-lived setup, issue a
certificate for a real domain and front the panel with it rather than exposing the
port directly.

## Operational notes

- `pasarguard` and `pg-node` are compose managers: `up`, `down`, `restart`,
  `status`, `logs`, `cli`, `tui`, `backup`, `restore`, `update`, `edit-env`.
- `pasarguard backup-service` configures recurring backups; wire that to a channel
  the operator will actually see, or a broken panel is discovered late.
- Read `.env` key names, never values, when reporting state.
- Delete the downloaded installer scripts from `/root` in the `cleanup` phase; they
  are re-downloadable and only add surface.
