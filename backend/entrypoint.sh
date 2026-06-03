#!/bin/sh
set -e

# Create required subdirectories under the mounted backup and non-backup paths.
# The container runs locked down (cap_drop: ALL, no-new-privileges, read-only rootfs).
# With no capabilities, chown is impossible, so we chmod the subdirectories to be
# world-writable, then drop privileges to the non-root nodejs user.
#
# The Node.js application code already creates all subdirectories on demand with
# { recursive: true }. This entrypoint ensures the root-level mount points are
# writable by the nodejs user before the app starts.

mkdir -p /mnt/backup/__system__/logs
mkdir -p /mnt/backup/__system__/nginx/conf.d/locations
mkdir -p /mnt/backup/__system__/nginx/ssl
mkdir -p /mnt/backup/__system__/etcd/config
mkdir -p /mnt/backup/__system__/etcd-data
mkdir -p /mnt/non-backup

# Make directories writable by the nodejs user (chown needs CAP_CHOWN)
chmod -R 777 /mnt/backup/__system__
chmod 777 /mnt/non-backup 2>/dev/null || true

exec su-exec nodejs node backend/index.js