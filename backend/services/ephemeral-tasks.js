import docker from './docker.js';
import fs from 'fs/promises';
import path from 'path';

const BACKUP_MOUNT = '/mnt/backup';
const NONBACKUP_MOUNT = '/mnt/non-backup';
export const SYSTEM_NAMESPACE = '__system__';

const SAFE_PATH_RE = /^[a-zA-Z0-9_\/\-.]+$/;

export function validatePath(p) {
  if (p.includes('..')) {
    throw new Error('Path traversal detected');
  }
  if (!SAFE_PATH_RE.test(p)) {
    throw new Error('Invalid characters in path');
  }
}

export async function runEphemeralTask(image, cmd, options = {}) {
  try {
    try {
      await docker.getImage(image).inspect();
    } catch (e) {
      console.log(`[EphemeralTasks] Pulling image ${image}...`);
      const stream = await docker.pull(image);
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
      });
    }

    const backupPath = process.env.HOST_BACKUP_PATH || '/data/backup';
    const nonBackupPath = process.env.HOST_NONBACKUP_PATH || '/data/non-backup';

    const defaultHostConfig = {
      Binds: [
        `${backupPath}:/data/backup`,
        `${nonBackupPath}:/data/non-backup`
      ],
      AutoRemove: false
    };

    const container = await docker.createContainer({
      Image: image,
      Cmd: cmd,
      HostConfig: { ...defaultHostConfig, ...options.HostConfig },
      ...options
    });

    await container.start();

    const result = await container.wait();

    const logs = await container.logs({ stdout: true, stderr: true });
    const demuxed = demuxDockerLogs(logs);

    await container.remove();

    return {
      stdout: demuxed.stdout,
      stderr: demuxed.stderr,
      exitCode: result.StatusCode
    };
  } catch (error) {
    console.error(`[EphemeralTasks] Task failed (${image}):`, error.message);
    throw error;
  }
}

export function demuxDockerLogs(buffer) {
  let stdout = '';
  let stderr = '';
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;
    const streamType = buffer[offset];
    const frameLength = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + frameLength > buffer.length) break;
    const frame = buffer.toString('utf8', offset, offset + frameLength);
    if (streamType === 1) {
      stdout += frame;
    } else if (streamType === 2) {
      stderr += frame;
    }
    offset += frameLength;
  }
  return { stdout, stderr };
}

export async function writeFileToHost(filePath, content) {
  const relativePath = filePath.startsWith('/') ? filePath.replace(/^\//, '') : filePath;
  validatePath(relativePath);

  const mountPath = BACKUP_MOUNT;
  const fullPath = path.join(mountPath, relativePath);

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf8');
}

export async function removeFileFromHost(filePath) {
  const relativePath = filePath.startsWith('/') ? filePath.replace(/^\//, '') : filePath;
  validatePath(relativePath);

  const mountPath = BACKUP_MOUNT;
  const fullPath = path.join(mountPath, relativePath);

  try {
    await fs.unlink(fullPath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}