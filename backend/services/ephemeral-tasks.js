import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import docker from './docker.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const BACKUP_MOUNT = '/mnt/backup';
const NONBACKUP_MOUNT = '/mnt/non-backup';
export const SYSTEM_NAMESPACE = '__system__';

const SAFE_PATH_RE = /^[a-zA-Z0-9_\/\-.]+$/;

/**
 * Resolve the host-side absolute path for a Docker API bind mount source.
 * If the configured env path is relative, derive it from the compose bind
 * mount info in /proc/1/mountinfo.
 */
export function resolveHostPath(envPath, mountPoint) {
  if (!envPath || path.isAbsolute(envPath)) return envPath || '/data/backup';
  // Resolve relative paths against the compose project dir or cwd
  const base = process.env.COMPOSE_PROJECT_DIR || process.cwd();
  return path.resolve(base, envPath);
}

export function validatePath(p) {
  if (p.includes('..')) {
    throw new Error('Path traversal detected');
  }
  if (!SAFE_PATH_RE.test(p)) {
    throw new Error('Invalid characters in path');
  }
}

export async function runEphemeralTask(image, cmd, options = {}) {
  const secretCleanups = [];

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

    const backupPath = resolveHostPath(process.env.HOST_BACKUP_PATH, BACKUP_MOUNT);
    const nonBackupPath = resolveHostPath(process.env.HOST_NONBACKUP_PATH, NONBACKUP_MOUNT);

    const defaultBinds = [
      `${backupPath}:/data/backup`,
      `${nonBackupPath}:/data/non-backup`
    ];

    // Handle secrets as files instead of env vars to avoid docker inspect exposure
    const { Secrets, Env, HostConfig: userHostConfig, ...restOptions } = options;
    const extraBinds = [];
    const envOverrides = [];

    if (Secrets && typeof Secrets === 'object') {
      const runId = crypto.randomBytes(6).toString('hex');
      const secretBaseDir = `${nonBackupPath}/${SYSTEM_NAMESPACE}/secrets/${runId}`;

      for (const [key, value] of Object.entries(Secrets)) {
        if (value === null || value === undefined) continue;
        const hostPath = `${secretBaseDir}/${key}`;
        mkdirSync(path.dirname(hostPath), { recursive: true });
        writeFileSync(hostPath, String(value), { mode: 0o600 });
        // Mount into container at /run/secrets/{key} (read-only)
        extraBinds.push(`${hostPath}:/run/secrets/${key}:ro`);
        // Some tools support _FILE variants that point to the secret file
        envOverrides.push(`${key}_FILE=/run/secrets/${key}`);
      }
      secretCleanups.push(secretBaseDir);
    }

    const hostConfig = {
      Binds: [...defaultBinds, ...extraBinds],
      AutoRemove: false,
      ...userHostConfig,
    };

    const container = await docker.createContainer({
      Image: image,
      Cmd: cmd,
      Env: [...(Env || []), ...envOverrides],
      HostConfig: hostConfig,
      ...restOptions
    });

    try {
      await container.start();
      const result = await container.wait();
      const logs = await container.logs({ stdout: true, stderr: true });
      const demuxed = demuxDockerLogs(logs);

      return {
        stdout: demuxed.stdout,
        stderr: demuxed.stderr,
        exitCode: result.StatusCode
      };
    } finally {
      await container.remove().catch(e =>
        console.warn(`[EphemeralTasks] Failed to remove container: ${e.message}`)
      );
      // Clean up secret files
      for (const dir of secretCleanups) {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  } catch (error) {
    // Clean up on error too
    for (const dir of secretCleanups) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
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