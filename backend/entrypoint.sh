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

# Run the application (no privilege drop needed for rootless Docker compat)
exec "$@"