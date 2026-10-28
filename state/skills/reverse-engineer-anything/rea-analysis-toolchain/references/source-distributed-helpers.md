# Source-distributed helper CLIs: install + resume notes

Session-derived notes for helper CLIs that ship as source tarballs rather than
registry packages. Current case: `hev` (hev-socks5-tunnel).

- Source archive: `hev.tar.xz` → extracted to `/root/hevsrc/hev-socks5-tunnel-2.19.3/`
- Reference/original copy: `/root/aether-ref/`
- Installed from source tarball, not a stable `/opt/<tool>` lane.
- `rea doctor` does not cover helper CLIs; verify them separately.

Symptom pattern: re-connect bug — `hev` exit code 0 on second attempt.

Root-cause direction: the failure traces to the service/tun2socks layer for the
second start, not the entry binary; fix/inspect that layer.
