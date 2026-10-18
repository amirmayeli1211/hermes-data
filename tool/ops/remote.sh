#!/usr/bin/env bash
# remote.sh — the script that runs ON the target server.
#
# WHY THIS FILE LIVES IN A REPO
#   The Hermes sandbox that drives this deployment allows outbound traffic only on
#   ports 80 and 443, so it cannot open an SSH connection at all. GitHub Actions
#   runners have unrestricted egress, so the workflow pipes this file over SSH and
#   runs it. Keeping the logic here means it is versioned and reviewable rather
#   than buried in a workflow input.
#
# Usage (from the workflow):
#     sshpass -e ssh root@host "bash -s -- <phase>" < ops/remote.sh
#
# Phases are separate so one failure does not force a full re-run, and so the
# expensive install steps never repeat by accident.

set -uo pipefail

PHASE="${1:-probe}"
APP="pasarguard"
PG_DIR="/opt/pasarguard"
NODE_DIR="/opt/pg-node"

# Domestic Iranian mirrors. registry-1.docker.io is blocked from this network
# (measured: UNREACHABLE while github.com resolves fine), so image pulls must go
# through a domestic mirror or every `docker compose up` fails.
DOCKER_MIRRORS=(
  "https://docker.arvancloud.ir"
  "https://docker.iranserver.com"
  "https://registry.docker.ir"
  "https://mirror-docker.runflare.com"
  "https://focker.ir"
)
APT_MIRROR="https://mirror.arvancloud.ir/ubuntu"

say()  { printf '\n=== %s ===\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  OK    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
die()  { printf '\nFATAL: %s\n' "$*" >&2; exit 1; }
require_root() { [ "$(id -u)" = "0" ] || die "must run as root"; }

# ---------------------------------------------------------------- phase: probe

phase_probe() {
    say "environment"
    info "host        : $(hostname)"
    info "os          : $(. /etc/os-release && echo "$PRETTY_NAME")"
    info "kernel      : $(uname -r)"
    info "arch        : $(uname -m)"
    info "cpus        : $(nproc)"
    info "ram         : $(free -m | awk '/^Mem:/{print $2" MB total, "$7" MB available"}')"
    info "disk /      : $(df -h / | awk 'NR==2{print $2" total, "$4" free"}')"
    info "swap        : $(free -m | awk '/^Swap:/{print $2" MB"}')"
    info "virtual     : $(systemd-detect-virt 2>/dev/null || echo unknown)"

    say "pid 1 (decides whether systemd can manage services)"
    info "comm        : $(cat /proc/1/comm)"
    if [ "$(cat /proc/1/comm)" = "systemd" ]; then
        ok "systemd is PID 1 — services can be installed and enabled normally"
    else
        warn "systemd is NOT PID 1 — systemd-managed services will not start"
    fi

    say "network egress"
    for h in github.com raw.githubusercontent.com registry-1.docker.io \
             download.docker.com deb.debian.org archive.ubuntu.com; do
        code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "https://$h" 2>/dev/null || echo "ERR")
        if [ "$code" = "ERR" ]; then printf '  %-34s UNREACHABLE\n' "$h"
        else printf '  %-34s HTTP %s\n' "$h" "$code"; fi
    done

    say "domestic docker mirrors (for blocked registry-1.docker.io)"
    for m in "${DOCKER_MIRRORS[@]}"; do
        code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$m/v2/" 2>/dev/null || echo "ERR")
        printf '  %-38s %s\n' "$m" "${code}"
    done

    say "preinstalled tooling"
    for t in curl wget tar gzip docker systemctl ufw apt-get sqlite3 openssl; do
        p=$(command -v "$t" 2>/dev/null || true)
        printf '  %-12s %s\n' "$t" "${p:-MISSING}"
    done

    say "listening ports"
    (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo "  (none)") | head -20

    say "probe complete"
}

# -------------------------------------------------------------- phase: prepare

# Installs Docker and points it at a domestic registry mirror. Both are required
# before the PasarGuard installers can work: they are compose-based, and the
# upstream registry is unreachable from this network.
phase_prepare() {
    require_root
    say "installing Docker"

    if command -v docker >/dev/null 2>&1; then
        ok "docker already present: $(docker --version)"
    else
        export DEBIAN_FRONTEND=noninteractive
        # Use the distro package. The official get.docker.com script pulls from
        # download.docker.com, which may be filtered; the Ubuntu archive is not.
        apt-get update -qq 2>&1 | tail -3
        if apt-get install -y -qq docker.io docker-compose-v2 2>&1 | tail -5; then
            ok "installed from the distro archive"
        else
            warn "distro install failed; trying the official script"
            curl -fsSL --max-time 60 https://get.docker.com -o /tmp/get-docker.sh && \
                sh /tmp/get-docker.sh 2>&1 | tail -8
        fi
    fi

    command -v docker >/dev/null 2>&1 || die "docker could not be installed"
    ok "docker binary: $(docker --version)"

    say "starting the docker daemon"
    systemctl enable --now docker 2>&1 | tail -3 || warn "systemctl start failed"
    sleep 3
    if docker info >/dev/null 2>&1; then
        ok "daemon is responding"
    else
        warn "daemon not responding yet; showing status"
        systemctl status docker --no-pager 2>&1 | tail -12
    fi

    say "configuring a domestic registry mirror"
    # Each mirror is probed with a real manifest request, and the first one that
    # answers is configured. Ordering by reachability beats ordering by reputation
    # because a blocked mirror fails every pull with a timeout.
    chosen=""
    for m in "${DOCKER_MIRRORS[@]}"; do
        if curl -sS -o /dev/null --max-time 8 "$m/v2/" 2>/dev/null; then
            chosen="$m"; break
        fi
    done

    mkdir -p /etc/docker
    if [ -n "$chosen" ]; then
        ok "using mirror: $chosen"
        cat > /etc/docker/daemon.json <<EOF
{
  "registry-mirrors": ["$chosen"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
    else
        warn "no mirror answered; leaving the default registry"
        warn "image pulls will likely fail on this network"
        cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
    fi

    systemctl restart docker 2>&1 | tail -2 || warn "restart failed"
    sleep 4

    say "verifying docker can actually pull an image"
    if docker pull hello-world 2>&1 | tail -6; then
        ok "pull succeeded"
        docker run --rm hello-world 2>&1 | tail -4 || warn "run failed but pull worked"
        docker rmi hello-world >/dev/null 2>&1 || true
    else
        warn "pull FAILED — this is the blocker for a compose-based install"
        warn "try configuring a different mirror manually in /etc/docker/daemon.json"
    fi

    say "docker compose plugin"
    (docker compose version 2>&1 || docker-compose version 2>&1 || echo "  MISSING") | head -3

    say "prepare complete"
    df -h / | tail -1
}

# -------------------------------------------------------------- phase: install

phase_install() {
    require_root
    say "installing the PasarGuard panel (SQLite, no SSL)"

    # SQLite keeps the stack to a single container with no external database, which
    # is what fits a 1 GB / 1 core box. --no-ssl avoids the interactive certificate
    # wizard; the dashboard is reached over an SSH tunnel rather than a public
    # TLS listener.
    export DEBIAN_FRONTEND=noninteractive

    installer=/root/pasarguard.sh
    curl -fsSL --connect-timeout 15 \
        https://raw.githubusercontent.com/PasarGuard/scripts/main/pasarguard.sh \
        -o "$installer" || die "could not download the panel installer"
    chmod +x "$installer"
    info "installer downloaded: $(wc -c < "$installer") bytes"

    # The installer prompts. </dev/null makes each prompt take its default instead
    # of hanging a CI job; the two that matter are pre-answered by flags.
    say "running: pasarguard.sh install --database sqlite --no-ssl"
    bash "$installer" install --database sqlite --no-ssl </dev/null 2>&1 | tail -80
    rc=${PIPESTATUS[0]}
    info "installer exit code: $rc"

    say "container state"
    (docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true) | head -12

    say "panel CLI"
    (pasarguard status 2>&1 || echo "  pasarguard CLI not available") | head -30

    say "install phase finished (rc=$rc)"
    return 0
}

# ------------------------------------------------------------------ phase: node

phase_node() {
    require_root
    say "installing a PasarGuard node on this same server"

    installer=/root/pg-node.sh
    curl -fsSL --connect-timeout 15 \
        https://raw.githubusercontent.com/PasarGuard/scripts/main/pg-node.sh \
        -o "$installer" || die "could not download the node installer"
    chmod +x "$installer"
    info "node installer downloaded: $(wc -c < "$installer") bytes"

    say "running: pg-node.sh install --self-signed"
    # A self-signed certificate avoids needing a domain for the panel<->node link.
    bash "$installer" install --self-signed </dev/null 2>&1 | tail -80
    info "installer exit code: ${PIPESTATUS[0]}"

    say "node state"
    (pg-node status 2>&1 || echo "  pg-node CLI not available") | head -30
    (docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true) | head -12
}

# ---------------------------------------------------------------- phase: status

phase_status() {
    say "docker"
    (docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo "  docker unavailable") | head -20

    say "panel"
    if command -v pasarguard >/dev/null 2>&1; then
        pasarguard status 2>&1 | head -30 || true
    else
        info "pasarguard CLI not on PATH"
    fi

    say "node"
    if command -v pg-node >/dev/null 2>&1; then
        pg-node status 2>&1 | head -30 || true
    else
        info "pg-node CLI not on PATH"
    fi

    say "listening ports"
    (ss -tlnp 2>/dev/null || true) | head -25

    say "panel env (key NAMES only — never values)"
    if [ -f "$PG_DIR/.env" ]; then
        sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/    \1/p' "$PG_DIR/.env" | head -40
    else
        info "$PG_DIR/.env not found"
    fi

    say "resource use"
    free -m | head -2
    df -h / | tail -1
}

# -------------------------------------------------------------- phase: cleanup

phase_cleanup() {
    require_root
    say "removing installer artifacts from the server"
    rm -f /root/pasarguard.sh /root/pg-node.sh /tmp/get-docker.sh
    ok "installer scripts deleted; the deployment itself is untouched"
    say "disk"
    df -h / | tail -1
}

case "$PHASE" in
    probe)   phase_probe ;;
    prepare) phase_prepare ;;
    install) phase_install ;;
    node)    phase_node ;;
    status)  phase_status ;;
    cleanup) phase_cleanup ;;
    *) die "unknown phase: $PHASE (try: probe, prepare, install, node, status, cleanup)" ;;
esac
