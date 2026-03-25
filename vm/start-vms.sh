#!/bin/bash

# Configuration
ALPINE_VERSION="3.23.3"
ALPINE_ARCH="x86_64"
ALPINE_ISO="alpine-virt-${ALPINE_VERSION}-${ALPINE_ARCH}.iso"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/${ALPINE_ARCH}/${ALPINE_ISO}"
VM_COUNT=3
VM_PREFIX="core-docker-node"
VM_MEM=2048
VM_DISK="10G"
VM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${VM_DIR}")"
PID_DIR="${VM_DIR}/pids"
HEADLESS=false # Set to true to run in the background without a window

mkdir -p "${PID_DIR}"

# Check for KVM
if [ ! -e /dev/kvm ]; then
    echo "WARNING: /dev/kvm not found. Performance will be slow."
    KVM_OPT=""
else
    KVM_OPT="-enable-kvm"
fi

# Download Alpine ISO if not present
if [ ! -f "${VM_DIR}/${ALPINE_ISO}" ]; then
    echo "Downloading Alpine ${ALPINE_VERSION}..."
    curl -L -o "${VM_DIR}/${ALPINE_ISO}" "${ALPINE_URL}"
fi

# Create and start VMs
for i in $(seq 1 ${VM_COUNT}); do
    VM_NAME="${VM_PREFIX}-${i}"
    DISK_IMG="${VM_DIR}/${VM_NAME}.qcow2"
    PID_FILE="${PID_DIR}/${VM_NAME}.pid"
    
    echo "Checking VM: ${VM_NAME}..."

    # Create disk if it doesn't exist
    if [ ! -f "${DISK_IMG}" ]; then
        echo "Creating disk image for ${VM_NAME}..."
        qemu-img create -f qcow2 "${DISK_IMG}" "${VM_DISK}"
    fi

    # Check if VM is already running
    if [ -f "${PID_FILE}" ] && kill -0 $(cat "${PID_FILE}") 2>/dev/null; then
        echo "VM ${VM_NAME} is already running (PID: $(cat "${PID_FILE}"))."
        continue
    fi

    # Calculate ports
    SSH_PORT=$((2220 + i))
    HTTP_PORT=$((8080 + i))
    HTTPS_PORT=$((8440 + i))

    echo "Starting VM: ${VM_NAME} (SSH: ${SSH_PORT}, HTTP: ${HTTP_PORT}, HTTPS: ${HTTPS_PORT})..."
    
    DISPLAY_OPT="-display default"
    if [ "$HEADLESS" = true ]; then
        DISPLAY_OPT="-display none -daemonize"
    fi

    qemu-system-x86_64 \
        ${KVM_OPT} \
        -name "${VM_NAME}" \
        -m ${VM_MEM} \
        -smp 1 \
        -drive file="${DISK_IMG}",if=virtio \
        -cdrom "${VM_DIR}/${ALPINE_ISO}" \
        -boot order=cd \
        -net nic,model=virtio \
        -net user,hostfwd=tcp::${SSH_PORT}-:22,hostfwd=tcp::${HTTP_PORT}-:80,hostfwd=tcp::${HTTPS_PORT}-:443 \
        -virtfs local,path="${PROJECT_DIR}",mount_tag=project,security_model=none,id=project \
        ${DISPLAY_OPT} \
        -pidfile "${PID_FILE}"

    echo "VM ${VM_NAME} started in the background (PID: $(cat "${PID_FILE}"))."
done

echo ""
echo "VMs are running. To perform the Alpine installation:"
echo "1. Connect to each VM. Since they are headless, you can use 'telnet' if you add '-serial telnet::xxxx,server,nowait', or change '-display none' to '-display gtk' temporarily to see the screen."
echo "2. Inside the VM, run: setup-alpine -f /media/project/vm/answers"
echo "3. Once installed, run: apk add docker docker-cli-compose"
echo "4. Add your user to the docker group: addgroup kees docker && rc-update add docker boot && service docker start"
echo ""
echo "SSH access (after installation):"
for i in $(seq 1 ${VM_COUNT}); do
    echo "  ${VM_PREFIX}-${i}: ssh -p $((2220 + i)) kees@localhost"
done
