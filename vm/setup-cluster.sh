#!/usr/bin/env bash
# setup-cluster.sh — Fully automated 3-node CoreDocker cluster on KVM
#
# Prerequisites:
#   sudo, virsh, virt-install, genisoimage, qemu-img, curl
#
# Usage:
#   sudo bash vm/setup-cluster.sh          # run if VMs already exist
#   sudo bash vm/setup-cluster.sh --recreate  # destroy + recreate fresh
#
set -euo pipefail

# ════════════════════════════════════════════════════════
# Configuration
# ════════════════════════════════════════════════════════
NUM_NODES=3
CLUSTER_NET_NAME="coredocker-cluster"
CLUSTER_SUBNET="192.168.100.0/24"
CLUSTER_GATEWAY="192.168.100.1"
BACKHAUL_NET_NAME="coredocker-backhaul"
BACKHAUL_SUBNET="10.100.0.0/24"
BACKHAUL_GATEWAY="10.100.0.1"
DOMAIN="coredocker.local"

VM_MEMORY_MB=3072
VM_CPUS=2
VM_DISK_GB=10

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLOUD_IMAGE_URL="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
CLOUD_IMAGE_FILE="$SCRIPT_DIR/noble-server-cloudimg-amd64.img"
SSH_KEY_DIR="$SCRIPT_DIR/ssh-keys"
SSH_KEY_PRIV="$SSH_KEY_DIR/cluster.key"
SSH_KEY_PUB="$SSH_KEY_DIR/cluster.key.pub"
TARBALL_PORT=9999

# Node definitions: name:public_ip:backhaul_ip:public_mac:backhaul_mac:is_first
NODES=(
  "node-1|192.168.100.10|10.100.0.10|52:54:00:c0:de:01|52:54:00:cd:fe:01|true"
  "node-2|192.168.100.11|10.100.0.11|52:54:00:c0:de:02|52:54:00:cd:fe:02|false"
  "node-3|192.168.100.12|10.100.0.12|52:54:00:c0:de:03|52:54:00:cd:fe:03|false"
)

# ════════════════════════════════════════════════════════
# Helpers
# ════════════════════════════════════════════════════════
log()  { echo -e "\e[1;34m[+]\e[0m $*"; }
warn() { echo -e "\e[1;33m[!]\e[0m $*"; }
err()  { echo -e "\e[1;31m[-]\e[0m $*" >&2; }

TARBALL_PID=""

cleanup() {
  log "Cleaning up..."
  kill "$TARBALL_PID" 2>/dev/null || true
  rm -f "$SCRIPT_DIR/repo.tar.gz"
}
trap cleanup EXIT

check_prereqs() {
  local missing=()
  for cmd in virsh virt-install genisoimage qemu-img curl git; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    err "Missing: ${missing[*]}"
    exit 1
  fi
  if ! python3 --version &>/dev/null; then
    err "python3 is required to serve the repo tarball"
    exit 1
  fi
}

# ════════════════════════════════════════════════════════
# 1. Download cloud image
# ════════════════════════════════════════════════════════
download_cloud_image() {
  if [ -f "$CLOUD_IMAGE_FILE" ]; then
    log "Cloud image cached: $CLOUD_IMAGE_FILE"
    return
  fi
  log "Downloading Ubuntu 24.04 cloud image..."
  curl -#L -o "$CLOUD_IMAGE_FILE" "$CLOUD_IMAGE_URL"
}

# ════════════════════════════════════════════════════════
# 2. Generate SSH key pair
# ════════════════════════════════════════════════════════
generate_ssh_key() {
  mkdir -p "$SSH_KEY_DIR"
  [ -f "$SSH_KEY_PRIV" ] && { log "SSH key exists: $SSH_KEY_PRIV"; return; }
  log "Generating cluster SSH key..."
  ssh-keygen -t ed25519 -f "$SSH_KEY_PRIV" -N "" -C "coredocker-cluster"
  chmod 600 "$SSH_KEY_PRIV"
}

# ════════════════════════════════════════════════════════
# 3. Create libvirt network
# ════════════════════════════════════════════════════════
create_network() {
  if virsh net-info "$CLUSTER_NET_NAME" &>/dev/null; then
    local state; state="$(virsh net-info "$CLUSTER_NET_NAME" | grep 'Active:' | awk '{print $2}')"
    if [ "$state" = "no" ]; then
      log "Starting existing network $CLUSTER_NET_NAME..."
      virsh net-start "$CLUSTER_NET_NAME"
    else
      log "Network $CLUSTER_NET_NAME exists and is active."
    fi
  else
    log "Creating libvirt network $CLUSTER_NET_NAME..."
    virsh net-define "$SCRIPT_DIR/network.xml"
    virsh net-start "$CLUSTER_NET_NAME"
  fi

  # Backhaul network (isolated — no NAT, internal cluster traffic only)
  if virsh net-info "$BACKHAUL_NET_NAME" &>/dev/null; then
    local state; state="$(virsh net-info "$BACKHAUL_NET_NAME" | grep 'Active:' | awk '{print $2}')"
    if [ "$state" = "no" ]; then
      log "Starting existing network $BACKHAUL_NET_NAME..."
      virsh net-start "$BACKHAUL_NET_NAME"
    else
      log "Network $BACKHAUL_NET_NAME exists and is active."
    fi
  else
    log "Creating libvirt network $BACKHAUL_NET_NAME..."
    virsh net-define "$SCRIPT_DIR/network-backhaul.xml"
    virsh net-start "$BACKHAUL_NET_NAME"
  fi
}

# ════════════════════════════════════════════════════════
# 4. Create repo tarball + start HTTP server
# ════════════════════════════════════════════════════════
start_http_server() {
  if [ -f "$SCRIPT_DIR/repo.tar.gz" ]; then
    log "Repo tarball exists, skipping creation."
  else
    log "Creating repo tarball (excluding node_modules, .git, etc.)..."
    cd "$PROJECT_DIR"
    tar czf /tmp/repo.tar.gz \
      --exclude='.git' \
      --exclude='node_modules' \
      .
    mv /tmp/repo.tar.gz "$SCRIPT_DIR/repo.tar.gz"
  fi

  log "Starting HTTP server on port $TARBALL_PORT..."
  cd "$SCRIPT_DIR"

  # Serve tarball and bootstrap script
  cat > serve.py <<'PYEOF'
import http.server, socketserver, os, sys

port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
script_dir = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=script_dir, **kw)
    def log_message(self, fmt, *a):
        pass  # quiet

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", port), Handler) as httpd:
    httpd.serve_forever()
PYEOF

  python3 serve.py "$TARBALL_PORT" &
  TARBALL_PID=$!
  sleep 1
  log "HTTP server running (pid $TARBALL_PID)."
}

# ════════════════════════════════════════════════════════
# 5. Generate cloud-init ISO for a node
# ════════════════════════════════════════════════════════
generate_cloud_init() {
  local node_name="$1" public_ip="$2" backhaul_ip="$3" public_mac="$4" backhaul_mac="$5"
  local iso_dir="$SCRIPT_DIR/cloud-init-build/$node_name"
  local iso_file="$SCRIPT_DIR/cloud-init-build/${node_name}-seed.iso"
  mkdir -p "$iso_dir"

  local public_key; public_key="$(cat "$SSH_KEY_PUB")"

  # meta-data
  printf 'instance-id: %s\nlocal-hostname: %s\n' "$node_name" "$node_name" > "$iso_dir/meta-data"

  # network-config — match by MAC to avoid ambiguity between the two virtio NICs
  cat > "$iso_dir/network-config" << NETCFG
version: 2
ethernets:
  # Public interface (1Gb client network with NAT + DNS)
  public:
    match:
      macaddress: ${public_mac}
    dhcp4: false
    addresses:
      - ${public_ip}/24
    gateway4: ${CLUSTER_GATEWAY}
    nameservers:
      addresses:
        - 1.1.1.1
        - 8.8.8.8
    search:
      - ${DOMAIN}
  # Backhaul interface (2.5Gb cluster-internal, isolated — no gateway)
  backhaul:
    match:
      macaddress: ${backhaul_mac}
    dhcp4: false
    addresses:
      - ${backhaul_ip}/24
    nameservers:
      search:
        - backhaul.${DOMAIN}
NETCFG

  # user-data — downloads repo from host and runs bootstrap
  cat > "$iso_dir/user-data" <<USERDATA
#cloud-config
hostname: ${node_name}
manage_etc_hosts: true
disable_root: false
ssh_pwauth: false

users:
  - name: coredocker
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - ${public_key}

packages:
  - curl
  - git
  - jq
  - ca-certificates

package_update: true
package_upgrade: false

runcmd:
  - >
    curl -fsSL http://${CLUSTER_GATEWAY}:${TARBALL_PORT}/repo.tar.gz
    -o /tmp/repo.tar.gz
  - mkdir -p /opt/coredocker
  - tar xzf /tmp/repo.tar.gz -C /opt/coredocker
  - chmod -R a+rX /opt/coredocker
  - rm /tmp/repo.tar.gz
  - bash /opt/coredocker/vm/vm-bootstrap.sh '${node_name}' '${public_ip}' '${backhaul_ip}' >/var/log/coredocker-bootstrap.log 2>&1
USERDATA

  genisoimage -output "$iso_file" -volid cidata -joliet -rock \
    "$iso_dir/meta-data" "$iso_dir/user-data" "$iso_dir/network-config" &>/dev/null
  echo "$iso_file"
}

# ════════════════════════════════════════════════════════
# 6. Create VM
# ════════════════════════════════════════════════════════
create_vm() {
  local node_name="$1" node_ip="$2" node_mac="$3" backhaul_mac="$4" seed_iso="$5"

  # Check if VM already exists
  if virsh dominfo "$node_name" &>/dev/null; then
    local state; state="$(virsh dominfo "$node_name" | grep 'State:' | awk '{print $2}')"
    if [ "$state" = "shut" ] || [ "$state" = "off" ]; then
      log "VM $node_name exists and is off. Starting..."
      virsh start "$node_name"
    else
      log "VM $node_name is already running."
    fi
    return
  fi

  local disk_file="$SCRIPT_DIR/disks/${node_name}.qcow2"
  mkdir -p "$SCRIPT_DIR/disks"

  if [ ! -f "$disk_file" ]; then
    log "Creating disk for $node_name..."
    qemu-img create -f qcow2 -b "$CLOUD_IMAGE_FILE" -F qcow2 "$disk_file" "${VM_DISK_GB}G"
  fi

  log "Launching $node_name (public=$node_ip, backhaul=$backhaul_mac)..."
  virt-install \
    --connect qemu:///system \
    --name "$node_name" \
    --memory "$VM_MEMORY_MB" \
    --vcpus "$VM_CPUS" \
    --disk "$disk_file,device=disk,bus=virtio" \
    --disk "$seed_iso,device=cdrom,bus=sata" \
    --network "network=${CLUSTER_NET_NAME},mac=${node_mac},model=virtio" \
    --network "network=${BACKHAUL_NET_NAME},mac=${backhaul_mac},model=virtio" \
    --graphics none \
    --console pty \
    --serial pty \
    --os-variant ubuntu24.04 \
    --import \
    --noautoconsole
}

# ════════════════════════════════════════════════════════
# 7. Wait for VM SSH
# ════════════════════════════════════════════════════════
wait_for_vm() {
  local node_ip="$1" timeout="${2:-300}" interval=5 elapsed=0
  log "Waiting for $node_ip..."
  while [ "$elapsed" -lt "$timeout" ]; do
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 \
      -i "$SSH_KEY_PRIV" "coredocker@${node_ip}" "exit" 2>/dev/null; then
      log "$node_ip ready (${elapsed}s)"
      return 0
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  err "Timeout waiting for $node_ip"
  return 1
}

# ════════════════════════════════════════════════════════
# 8. Wait for CoreDocker health
# ════════════════════════════════════════════════════════
wait_for_health() {
  local node_ip="$1" timeout=600 interval=10 elapsed=0
  log "Waiting for CoreDocker health on $node_ip..."
  while [ "$elapsed" -lt "$timeout" ]; do
    if curl -sf "http://${node_ip}/api/health" >/dev/null 2>&1; then
      log "CoreDocker healthy on $node_ip (${elapsed}s)"
      return 0
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  warn "Health check timed out on $node_ip"
  return 1
}

# ════════════════════════════════════════════════════════
# 0. Destroy (for --recreate)
# ════════════════════════════════════════════════════════
destroy_cluster() {
  log "Recreate flag: destroying existing VMs and network..."
  for vm in node-1 node-2 node-3; do
    if virsh dominfo "$vm" &>/dev/null; then
      virsh destroy "$vm" 2>/dev/null || true
      virsh undefine "$vm" 2>/dev/null || true
    fi
  done
  for net in "$CLUSTER_NET_NAME" "$BACKHAUL_NET_NAME"; do
    if virsh net-info "$net" &>/dev/null; then
      virsh net-destroy "$net" 2>/dev/null || true
      virsh net-undefine "$net" 2>/dev/null || true
    fi
  done
  rm -rf "$SCRIPT_DIR/disks" "$SCRIPT_DIR/cloud-init-build" "$SCRIPT_DIR/repo.tar.gz" "$SCRIPT_DIR/serve.py"
  # Wipe persisted etcd/cluster data so VMs start truly fresh
  rm -rf "$PROJECT_DIR/data/backup/__system__" "$PROJECT_DIR/data/nonbackup/__system__"
  # Clear known_hosts so SSH doesn't complain about changed host keys on recreate
  for ip in 192.168.100.10 192.168.100.11 192.168.100.12 10.100.0.10 10.100.0.11 10.100.0.12; do
    ssh-keygen -f '/root/.ssh/known_hosts' -R "$ip" 2>/dev/null || true
  done
  log "Clean slate ready."
}

main() {
  # Parse --recreate flag
  local recreate=false
  for arg in "$@"; do
    if [ "$arg" = "--recreate" ]; then
      recreate=true
    fi
  done
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║    CoreDocker Cluster VM Setup           ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""

  if [ "$(id -u)" -ne 0 ]; then
    err "Run with: sudo bash $0"
    exit 1
  fi

  check_prereqs

  if [ "$recreate" = true ]; then
    destroy_cluster
  fi

  # Phase 1: Prep
  log "Phase 1/7: Downloading cloud image..."
  download_cloud_image

  log "Phase 2/7: Generating SSH keys..."
  generate_ssh_key

  log "Phase 3/7: Creating libvirt network..."
  create_network

  log "Phase 4/7: Starting HTTP server for repo tarball..."
  start_http_server

  # Phase 2: Generate cloud-init ISOs
  log "Phase 5/7: Generating cloud-init ISOs..."
  rm -rf "$SCRIPT_DIR/cloud-init-build"
  local seed_isos=()
  for node_def in "${NODES[@]}"; do
    IFS='|' read -r name ip bh_ip mac bh_mac is_first <<< "$node_def"
    log "  $name (public=$ip, backhaul=$bh_ip)"
    local iso; iso="$(generate_cloud_init "$name" "$ip" "$bh_ip" "$mac" "$bh_mac")"
    seed_isos+=("$iso|$name|$ip|$bh_ip|$mac|$bh_mac|$is_first")
  done

  # Phase 3: Launch VMs
  log "Phase 6/7: Launching VMs..."
  for entry in "${seed_isos[@]}"; do
    IFS='|' read -r iso name ip bh_ip mac bh_mac is_first <<< "$entry"
    create_vm "$name" "$ip" "$mac" "$bh_mac" "$iso"
  done

  # Phase 4: Wait for all VMs
  log "Phase 7/7: Waiting for VMs to boot and configure..."
  for entry in "${seed_isos[@]}"; do
    IFS='|' read -r iso name ip bh_ip mac bh_mac is_first <<< "$entry"
    wait_for_vm "$ip" 300
  done

  # Wait for CoreDocker on each node
  for entry in "${seed_isos[@]}"; do
    IFS='|' read -r iso name ip bh_ip mac bh_mac is_first <<< "$entry"
    wait_for_health "$ip" 180
  done

  # ════════════════════════════════════════════════
  # Summary
  # ════════════════════════════════════════════════
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║    Cluster Ready!                        ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""
  for entry in "${seed_isos[@]}"; do
    IFS='|' read -r iso name ip bh_ip mac bh_mac is_first <<< "$entry"
    local role="node"
    [ "$is_first" = "true" ] && role="leader"
    printf "  %-10s  ssh -i %s coredocker@%s  (public=%s, backhaul=%s)\n" \
      "$name ($role)" "$SSH_KEY_PRIV" "$ip" "$ip" "$bh_ip"
  done
  echo ""

  # Show cluster state
  local status_json
  status_json="$(curl -sf http://192.168.100.10/api/system/status 2>/dev/null || echo '{"error":"not ready"}')"
  echo "  Node status:"
  echo "  $status_json" | python3 -m json.tool 2>/dev/null || echo "  $status_json"
  echo ""
  log "Done!"
}

main "$@"
