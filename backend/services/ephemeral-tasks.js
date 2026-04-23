import docker from './docker.js';
import etcd from './db.js';

/**
 * Runs an ephemeral container for a specific task and returns its output.
 * @param {string} image - The Docker image to use (e.g., 'alpine', 'restic/restic')
 * @param {string[]} cmd - The command to run inside the container
 * @param {Object} options - Additional options like HostConfig (for mounts)
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
export async function runEphemeralTask(image, cmd, options = {}) {
    try {
        // Ensure image exists
        try {
            await docker.getImage(image).inspect();
        } catch (e) {
            console.log(`[EphemeralTasks] Pulling image ${image}...`);
            const stream = await docker.pull(image);
            await new Promise((resolve, reject) => {
                docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
            });
        }

        // Get configured paths for mounts if not provided
        const backupPath = process.env.HOST_BACKUP_PATH || '/data/backup';
        const nonBackupPath = process.env.HOST_NONBACKUP_PATH || '/data/non-backup';

        const defaultHostConfig = {
            Binds: [
                `${backupPath}:/data/backup`,
                `${nonBackupPath}:/data/non-backup`
            ],
            AutoRemove: false // We manually remove to capture logs easily
        };

        const container = await docker.createContainer({
            Image: image,
            Cmd: cmd,
            HostConfig: { ...defaultHostConfig, ...options.HostConfig },
            ...options
        });

        await container.start();

        // Wait for container to finish
        const result = await container.wait();
        
        // Capture logs
        const logs = await container.logs({ stdout: true, stderr: true });
        // Docker logs are multiplexed if TTY is false (default)
        // We need to demux them or just use a simple string if it's small
        const logString = logs.toString('utf8');

        // Cleanup
        await container.remove();

        return {
            stdout: logString, // Simplified for now
            stderr: '',
            exitCode: result.StatusCode
        };
    } catch (error) {
        console.error(`[EphemeralTasks] Task failed (${image}):`, error.message);
        throw error;
    }
}

/**
 * Specialized helper to write a file to the host backupPath using an ephemeral container.
 */
export async function writeFileToHost(filePath, content) {
    const base64Content = Buffer.from(content).toString('base64');
    const fullPath = filePath.startsWith('/') ? filePath : `/data/backup/${filePath}`;
    
    // Strict path validation to prevent command injection and directory traversal
    if (fullPath.includes('..') || /[\$\&\|\>\<\;]/.test(fullPath)) {
        throw new Error('Invalid file path');
    }

    // Ensure directory exists first
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    
    // Using printf with base64 to avoid shell injection via echo or content
    // We still use sh -c but we are extremely careful with inputs
    await runEphemeralTask('alpine', [
        'sh', '-c',
        `mkdir -p "${dir.replace(/"/g, '\\"')}" && printf "%s" "${base64Content}" | base64 -d > "${fullPath.replace(/"/g, '\\"')}"`
    ]);
}

/**
 * Specialized helper to remove a file from the host backupPath.
 */
export async function removeFileFromHost(filePath) {
    const fullPath = filePath.startsWith('/') ? filePath : `/data/backup/${filePath}`;
    
    if (fullPath.includes('..') || /[\$\&\|\>\<\;]/.test(fullPath)) {
        throw new Error('Invalid file path');
    }

    await runEphemeralTask('alpine', ['rm', '-f', fullPath]);
}
