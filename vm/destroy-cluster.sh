#!/usr/bin/env bash
# destroy-cluster.sh — destroy all cluster VMs and resources
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLUSTER_NET_NAME="coredocker-cluster"
BACKHAUL_NET_NAME="coredocker-backhaul"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with: sudo bash $0"
  exit 1
fi

echo "Destroying cluster VMs..."
for vm in node-1 node-2 node-3; do
  if virsh dominfo "$vm" &>/dev/null; then
    echo "  Destroying $vm..."
    virsh destroy "$vm" 2>/dev/null || true
    virsh undefine "$vm" 2>/dev/null || true
  else
    echo "  $vm does not exist."
  fi
done

for net in "$CLUSTER_NET_NAME" "$BACKHAUL_NET_NAME"; do
  if virsh net-info "$net" &>/dev/null; then
    echo "Destroying network $net..."
    virsh net-destroy "$net" 2>/dev/null || true
    virsh net-undefine "$net" 2>/dev/null || true
  fi
done

# Clean up disks (optional)
rm -rf "$SCRIPT_DIR/disks" "$SCRIPT_DIR/cloud-init-build" "$SCRIPT_DIR/repo.tar.gz" "$SCRIPT_DIR/serve.py"

# Clear known_hosts so SSH doesn't complain about changed host keys on recreate
for ip in 192.168.100.10 192.168.100.11 192.168.100.12 10.100.0.10 10.100.0.11 10.100.0.12; do
  ssh-keygen -f '/root/.ssh/known_hosts' -R "$ip" 2>/dev/null || true
done

echo "Done."
