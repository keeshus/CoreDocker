#!/usr/bin/env bash
# update-cluster.sh — Update CoreDocker code on all running cluster VMs
#
# Usage:
#   sudo bash vm/update-cluster.sh
#   sudo bash vm/update-cluster.sh node-2          # update a single node
#   sudo bash vm/update-cluster.sh --no-rebuild     # copy code only, skip compose build
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SSH_KEY="$SCRIPT_DIR/ssh-keys/cluster.key"
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=5 -i $SSH_KEY"
SSH_USER="coredocker"
REPO_DIR="/opt/coredocker"

NODES=(
  "node-1|192.168.100.10|10.100.0.10"
  "node-2|192.168.100.11|10.100.0.11"
  "node-3|192.168.100.12|10.100.0.12"
)

log()  { echo -e "\e[1;34m[+]\e[0m $*"; }
warn() { echo -e "\e[1;33m[!]\e[0m $*"; }
err()  { echo -e "\e[1;31m[-]\e[0m $*" >&2; }

# Determine which nodes to update
TARGET_NODES=()
if [ $# -gt 0 ]; then
  for arg in "$@"; do
    [ "$arg" = "--no-rebuild" ] && continue
    TARGET_NODES+=("$arg")
    break
  done
fi

NO_REBUILD=false
for arg in "$@"; do
  [ "$arg" = "--no-rebuild" ] && NO_REBUILD=true
done

if [ ${#TARGET_NODES[@]} -eq 0 ]; then
  for node_def in "${NODES[@]}"; do
    IFS='|' read -r name ip <<< "$node_def"
    TARGET_NODES+=("$name")
  done
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║    CoreDocker Cluster Code Update        ║"
echo "╚══════════════════════════════════════════╝"
echo ""

if [ "$(id -u)" -ne 0 ]; then
  err "Run with: sudo bash $0"
  exit 1
fi

# ── Step 1: Create tarball ────────────────────────────────
log "Creating code tarball (excluding .git, node_modules)..."
TARBALL="/tmp/coredocker-update.tar.gz"
cd "$PROJECT_DIR"
tar czf "$TARBALL" \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='vm/disks' \
  --exclude='vm/cloud-init-build' \
  --exclude='vm/repo.tar.gz' \
  --exclude='vm/serve.py' \
  --exclude='vm/ssh-keys' \
  --exclude='vm/*.img' \
  .
log "Tarball created: $(du -h "$TARBALL" | cut -f1)"

# ── Step 2: Update each target node ────────────────────────
for node_name in "${TARGET_NODES[@]}"; do
  # Find IPs for this node
  node_ip=""
  backhaul_ip=""
  for node_def in "${NODES[@]}"; do
    IFS='|' read -r name ip bh_ip <<< "$node_def"
    if [ "$name" = "$node_name" ]; then
      node_ip="$ip"
      backhaul_ip="$bh_ip"
      break
    fi
  done
  if [ -z "$node_ip" ]; then
    warn "Unknown node: $node_name, skipping."
    continue
  fi

  log "Updating $node_name ($node_ip)..."

  # Check if VM is reachable
  if ! ssh $SSH_OPTS "$SSH_USER@$node_ip" "exit" 2>/dev/null; then
    warn "$node_name is not reachable, skipping."
    continue
  fi

  # Copy tarball to VM
  log "  Copying code..."
  scp $SSH_OPTS "$TARBALL" "$SSH_USER@$node_ip:/tmp/coredocker-update.tar.gz" >/dev/null

  # Extract and optionally rebuild
  if [ "$NO_REBUILD" = true ]; then
    log "  Extracting code (no rebuild)..."
    ssh $SSH_OPTS "$SSH_USER@$node_ip" \
      "sudo tar xzf /tmp/coredocker-update.tar.gz -C $REPO_DIR && \
       sudo rm /tmp/coredocker-update.tar.gz && \
       sudo sed -i 's|^HOST_BACKUP_PATH=.*|HOST_BACKUP_PATH=${REPO_DIR}/data/backup|; s|^HOST_NONBACKUP_PATH=.*|HOST_NONBACKUP_PATH=${REPO_DIR}/data/nonbackup|; s|^HOST_CERTS_PATH=.*|HOST_CERTS_PATH=${REPO_DIR}/nginx/ssl|; s|^NODE_IP=.*|NODE_IP=${backhaul_ip}|; s|^NODE_CLIENT_IP=.*|NODE_CLIENT_IP=${node_ip}|' ${REPO_DIR}/.env && \
       echo '  Done.'"
  else
    log "  Extracting code and rebuilding containers..."
    ssh $SSH_OPTS "$SSH_USER@$node_ip" \
      "sudo tar xzf /tmp/coredocker-update.tar.gz -C $REPO_DIR && \
       sudo rm /tmp/coredocker-update.tar.gz && \
       cd $REPO_DIR && \
       sudo sed -i 's|^HOST_BACKUP_PATH=.*|HOST_BACKUP_PATH=${REPO_DIR}/data/backup|; s|^HOST_NONBACKUP_PATH=.*|HOST_NONBACKUP_PATH=${REPO_DIR}/data/nonbackup|; s|^HOST_CERTS_PATH=.*|HOST_CERTS_PATH=${REPO_DIR}/nginx/ssl|; s|^NODE_IP=.*|NODE_IP=${backhaul_ip}|; s|^NODE_CLIENT_IP=.*|NODE_CLIENT_IP=${node_ip}|' .env && \
       sudo docker rm -f core-docker-backend core-docker-frontend 2>/dev/null; \
       sudo docker compose up -d --build 2>&1" | sed "s/^/  [$node_name] /"
  fi

  log "$node_name updated."
done

# ── Cleanup ────────────────────────────────────────────────
rm -f "$TARBALL"

echo ""
log "All done!"
