#!/usr/bin/env bash
# destroy-cluster.sh — destroy all cluster VMs and resources
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLUSTER_NET_NAME="coredocker-cluster"

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

if virsh net-info "$CLUSTER_NET_NAME" &>/dev/null; then
  echo "Destroying network $CLUSTER_NET_NAME..."
  virsh net-destroy "$CLUSTER_NET_NAME" 2>/dev/null || true
  virsh net-undefine "$CLUSTER_NET_NAME" 2>/dev/null || true
fi

# Clean up disks (optional)
rm -rf "$SCRIPT_DIR/disks" "$SCRIPT_DIR/cloud-init-build" "$SCRIPT_DIR/repo.tar.gz" "$SCRIPT_DIR/serve.py"

echo "Done."
