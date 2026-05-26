#!/bin/sh
set -e

# Create required subdirectories under the mounted backup and non-backup paths.
# The container runs locked down (cap_drop: ALL, no-new-privileges, read-only rootfs).
# With no capabilities, chown is impossible, so we run node as root (no-op security-wise
# since all capabilities are already stripped).

mkdir -p /mnt/backup/__system__/logs
mkdir -p /mnt/backup/__system__/nginx/conf.d/locations
mkdir -p /mnt/backup/__system__/nginx/ssl
mkdir -p /mnt/backup/__system__/etcd/config
mkdir -p /mnt/backup/__system__/etcd-data
mkdir -p /mnt/non-backup

exec node backend/index.js