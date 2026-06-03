#!/bin/sh
set -e

# Create required subdirectories under the mounted backup and non-backup paths.
# The container runs locked down (cap_drop: ALL, no-new-privileges, read-only rootfs).
# With all capabilities stripped, root has no special privileges — it cannot chown,
# mount, or access kernel interfaces. The process is effectively unprivileged despite
# UID 0. Running as the nodejs user is not possible here because su-exec/setpriv
# require the setgroups syscall which cap_drop: ALL blocks.

mkdir -p /mnt/backup/__system__/logs
mkdir -p /mnt/backup/__system__/nginx/conf.d/locations
mkdir -p /mnt/backup/__system__/nginx/ssl
mkdir -p /mnt/backup/__system__/etcd/config
mkdir -p /mnt/backup/__system__/etcd-data
mkdir -p /mnt/non-backup

exec node backend/index.js