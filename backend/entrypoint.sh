#!/bin/sh
set -e

# Create required subdirectories under the mounted backup and non-backup paths.
# The container runs as root (which maps to the host user in rootless Docker),
# so mkdir always succeeds. Subdirectories ensure per-container isolation.

mkdir -p /mnt/backup/__system__/logs
mkdir -p /mnt/backup/__system__/nginx/conf.d/locations
mkdir -p /mnt/backup/__system__/nginx/ssl
mkdir -p /mnt/backup/__system__/etcd/config
mkdir -p /mnt/backup/__system__/etcd-data
mkdir -p /mnt/non-backup

# Run the application (drop privileges after creating directories)
chown -R nodejs:nodejs /mnt/backup /mnt/non-backup
exec su -s /bin/sh nodejs -c "exec node backend/index.js"