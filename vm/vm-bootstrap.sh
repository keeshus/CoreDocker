#!/usr/bin/env bash
# vm-bootstrap.sh — runs inside each VM via cloud-init
#
# Each VM is fully independent with its own:
#   - Docker daemon  →  own ETCD / Nginx / CoreDNS / Keepalived
#   - CoreDocker backend/frontend  →  own setup page / dashboard
#   - No shared state with other VMs until user joins via setup page
set -euo pipefail

NODE_NAME="${1:-$(hostname)}"
REPO_DIR="/opt/coredocker"
PUBLIC_IP="${2:-}"
BACKHAUL_IP="${3:-}"

log() { echo "[bootstrap] $*"; }

install_docker() {
  if command -v docker &>/dev/null; then
    log "Docker already installed."
    return
  fi
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker || true
  log "Docker installed."
}

start_coredocker() {
  cd "$REPO_DIR"
  # Generate .env with absolute paths + backhaul IP for cluster-internal traffic
  sed "s|^HOST_BACKUP_PATH=.*|HOST_BACKUP_PATH=${REPO_DIR}/data/backup|; s|^HOST_NONBACKUP_PATH=.*|HOST_NONBACKUP_PATH=${REPO_DIR}/data/nonbackup|; s|^HOST_CERTS_PATH=.*|HOST_CERTS_PATH=${REPO_DIR}/nginx/ssl|; s|^NODE_IP=.*|NODE_IP=${BACKHAUL_IP}|; s|^NODE_CLIENT_IP=.*|NODE_CLIENT_IP=${PUBLIC_IP}|; s|^NODE_NAME=.*|NODE_NAME=${NODE_NAME}|" .env > .env.vm
  mv .env.vm .env
  log "Starting CoreDocker stack..."
  log "  Backend will bootstrap: ETCD, Nginx proxy, CoreDNS, Keepalived"
  log "  Reconciler, scheduler, and orchestrator will start"
  docker compose up -d --build 2>&1 | tee /tmp/coredocker-start.log || {
    log "docker compose failed. Check /tmp/coredocker-start.log"
    return 1
  }
  log "CoreDocker stack started."
}

# ── Main ────────────────────────────────────────────────────────
log "=== CoreDocker VM Bootstrap ==="
log "Node: $NODE_NAME"
install_docker
start_coredocker

log "=== Bootstrap complete ==="
log "Open http://$(hostname -I | awk '{print $1}'):80 to access the setup page."
