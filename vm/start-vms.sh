#!/bin/bash

# Configuration
ALPINE_VERSION="3.23.3"
ALPINE_ARCH="x86_64"
ALPINE_ISO="alpine-virt-${ALPINE_VERSION}-${ALPINE_ARCH}.iso"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/${ALPINE_ARCH}/${ALPINE_ISO}"
VM_COUNT=3
VM_PREFIX="core-docker-node"
VM_MEM=2048
VM_CPUS=1
VM_DISK_SIZE="10" # in GB
VM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${VM_DIR}")"
HEADLESS=false # Set to true to run in the background without a window

# Check for libvirt/virsh
if ! command -v virsh &> /dev/null; then
    echo "ERROR: 'virsh' not found. Please install libvirt (e.g., sudo apt install libvirt-daemon-system libvirt-clients virtinst)."
    exit 1
fi

# Set graphics and console options based on HEADLESS
if [ "$HEADLESS" = true ]; then
    GRAPHICS_OPTS="--graphics none --noautoconsole"
else
    # Check if virt-viewer is installed for windowed mode
    if ! command -v virt-viewer &> /dev/null; then
        echo "WARNING: 'virt-viewer' not found. You might not see the VM window. Install it with your package manager."
    fi
    GRAPHICS_OPTS="--graphics spice --autoconsole graphical"
fi

# Ensure default network is active
if ! virsh net-info default | grep -q "Active:.*yes"; then
    echo "Starting default network..."
    virsh net-start default 2>/dev/null || true
    virsh net-autostart default 2>/dev/null || true
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
    
    echo "Checking VM: ${VM_NAME}..."

    # Check if VM is already defined in libvirt
    if virsh list --all | grep -q "${VM_NAME}"; then
        if virsh list --all | grep "${VM_NAME}" | grep -q "running"; then
            echo "VM ${VM_NAME} is already running."
        else
            echo "Starting existing VM ${VM_NAME}..."
            virsh start "${VM_NAME}"
            if [ "$HEADLESS" = false ]; then
                virt-viewer --connect qemu:///system "${VM_NAME}" &
            fi
        fi
        continue
    fi

    # Define installation vs import options
    INSTALL_OPTS="--cdrom ${VM_DIR}/${ALPINE_ISO}"
    if [ -f "${DISK_IMG}" ]; then
        echo "Found existing disk for ${VM_NAME}. Importing..."
        INSTALL_OPTS="--import"
    else
        echo "Creating new disk and starting installation for ${VM_NAME}..."
    fi

    # Use virt-install to define and start the VM
    virt-install \
        --connect qemu:///system \
        --name "${VM_NAME}" \
        --memory "${VM_MEM}" \
        --vcpus "${VM_CPUS}" \
        --disk path="${DISK_IMG}",size="${VM_DISK_SIZE}",format=qcow2,bus=virtio \
        ${INSTALL_OPTS} \
        --os-variant alpinelinux3.21 \
        --network network=default,model=virtio \
        --filesystem "${PROJECT_DIR}",project,mode=mapped \
        ${GRAPHICS_OPTS}

    echo "VM ${VM_NAME} created and started."
done

echo ""
echo "VMs are running! To find their IP addresses:"
echo "  virsh net-dhcp-leases default"
echo ""
echo "To connect to a VM console (Ctrl+] to exit):"
echo "  virsh console ${VM_PREFIX}-1"
echo ""
echo "Inside the VM, perform the installation:"
echo "1. Mount the project folder: mkdir -p /media/project && mount -t 9p -o trans=virtio project /media/project"
echo "2. Run: setup-alpine -f /media/project/vm/answers"
echo "3. Once installed, run: apk add docker docker-cli-compose"
echo "4. Setup docker and group:"
echo "   addgroup kees docker && rc-update add docker boot && service docker start"
echo ""
echo "5. Make the project mount persistent across reboots:"
echo "   echo 'project /media/project 9p trans=virtio,version=9p2000.L,rw 0 0' >> /etc/fstab"
echo "   mount -a && ls /media/project  # Verify it works"
