import docker from './docker.js';
import { connectNginxToNetwork } from './nginx.js';
import { getGroups } from './db.js';

/**
 * Ensure the container's personal network exists and is connected.
 * Container is always connected to its own network for nginx proxying.
 */
export async function ensureContainerNetworks(containerId, name, group, internetAccess) {
    const networkName = `container-${containerId}`;

    // Create or find the container network
    try {
        const existing = docker.getNetwork(networkName);
        await existing.inspect();
    } catch (e) {
        if (e.statusCode !== 404) throw e;
        await docker.createNetwork({
            Name: networkName,
            Driver: 'bridge',
            Internal: !internetAccess,
            CheckDuplicate: true,
            Labels: { 'core-docker.network': 'container', 'core-docker.container': name },
        });
        console.log(`[Network] Created network ${networkName} (internal: ${!internetAccess})`);
    }

    // Connect container to its own network
    try {
        const network = docker.getNetwork(networkName);
        await network.connect({ Container: containerId });
    } catch (e) {
        if (e.message && e.message.includes('already exists')) {
            // Already connected to own network - no action needed
            return;
        }
        throw e;
    }

    // Connect nginx so it can proxy to this container
    await connectNginxToNetwork(networkName);

    // If container belongs to a group, ensure group network and connect
    if (group) {
        const groups = await getGroups();
        const groupConfig = groups.find(g => g.name === group);
        await ensureGroupNetwork(group, groupConfig?.config?.internetAccess ?? false);
        try {
            const groupNetName = `group-${group}`;
            const groupNet = docker.getNetwork(groupNetName);
            await groupNet.connect({ Container: containerId });
        } catch (e) {
            if (e.message && e.message.includes('already exists')) {
                // Already connected to group network - no action needed
                return;
            }
            throw e;
        }
    }
}

/**
 * Ensure a group network exists with the correct --internal setting.
 * Group networks are for peer communication only - nginx is NOT connected.
 */
export async function ensureGroupNetwork(groupName, internetAccess) {
    const networkName = `group-${groupName}`;

    try {
        const existing = docker.getNetwork(networkName);
        const info = await existing.inspect();

        // If internetAccess changed, we need to recreate with correct Internal flag
        const needsRecreate = info.Internal !== !internetAccess; // Internal flag differs from desired
        if (!needsRecreate) return;

        console.log(`[Network] Recreating ${networkName} with internal=${!internetAccess}`);
        // Disconnect all containers before removing
        // Note: Docker will fail if containers are attached, but we handle this gracefully
        try { await existing.remove(); } catch (removeErr) {
            console.warn(`[Network] Could not remove ${networkName} (containers still attached?): ${removeErr.message}`);
            return;
        }
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }

    await docker.createNetwork({
        Name: networkName,
        Driver: 'bridge',
        Internal: !internetAccess,
        CheckDuplicate: true,
        Labels: { 'core-docker.network': 'group', 'core-docker.group': groupName },
    });
    console.log(`[Network] Created network ${networkName} (internal: ${!internetAccess})`);
}

/**
 * Remove a container's personal network.
 */
export async function removeContainerNetworks(containerId) {
    const networkName = `container-${containerId}`;
    try {
        const network = docker.getNetwork(networkName);
        await network.remove();
        console.log(`[Network] Removed network ${networkName}`);
    } catch (e) {
        if (e.statusCode !== 404) {
            console.warn(`[Network] Failed to remove ${networkName}: ${e.message}`);
        }
    }
}

/**
 * Remove a group network.
 */
export async function removeGroupNetwork(groupName) {
    const networkName = `group-${groupName}`;
    try {
        const network = docker.getNetwork(networkName);
        await network.remove();
        console.log(`[Network] Removed network ${networkName}`);
    } catch (e) {
        if (e.statusCode !== 404) {
            console.warn(`[Network] Failed to remove ${networkName}: ${e.message}`);
        }
    }
}

/**
 * Check if a network exists
 */
async function networkExists(networkName) {
    try {
        await docker.getNetwork(networkName).inspect();
        return true;
    } catch {
        return false;
    }
}