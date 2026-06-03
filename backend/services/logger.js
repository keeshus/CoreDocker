import pino from 'pino';
import { etcd } from './db.js';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SYSTEM_NAMESPACE } from './ephemeral-tasks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_RETENTION_KEY = 'settings/log_retention_days';
const DEFAULT_RETENTION_DAYS = 7;
const NONBACKUP_MOUNT = '/mnt/non-backup';

const getLogDir = () => {
  return path.join(NONBACKUP_MOUNT, SYSTEM_NAMESPACE, 'logs');
};

const logDir = getLogDir();
try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {
  console.warn(`[Logger] Could not create log directory ${logDir}: ${e.message}`);
}

const logStream = (() => {
  try {
    if (fs.existsSync(logDir)) {
      return fs.createWriteStream(path.join(logDir, 'system.ndjson'), { flags: 'a' });
    }
  } catch (e) {
    console.warn(`[Logger] Could not access log directory, falling back to stdout: ${e.message}`);
  }
  return process.stdout;
})();

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: ['password', 'masterPassword', 'currentPassword', 'newPassword', 'token', 'secret', 'sslKey', 'sslCert', 'joinToken'],
    censor: '[REDACTED]',
  },
}, logStream);

export function logEvent(source, type, message, metadata = {}) {
  if (type === 'error') {
    pinoLogger.error({ source, ...metadata }, message);
  } else if (type === 'warn') {
    pinoLogger.warn({ source, ...metadata }, message);
  } else {
    pinoLogger.info({ source, ...metadata }, message);
  }
}

export function startLogger() {
  pinoLogger.info('Logger started');
}

export async function stopLogger() {
  pinoLogger.info('Logger stopped');
  await pinoLogger.flush();
}

export async function flushLogs() {
  const logFilePath = path.join(logDir, 'system.ndjson');
  pinoLogger.info({ path: logFilePath }, 'Logs flushed to disk');
  await pinoLogger.flush();
}

export async function purgeOldLogs() {
  const retentionDaysRaw = await etcd.get(LOG_RETENTION_KEY).string();
  const retentionDays = retentionDaysRaw ? parseInt(retentionDaysRaw, 10) : DEFAULT_RETENTION_DAYS;

  pinoLogger.info({ retentionDays, logDir }, 'Purging old logs');

  // Purge system logs
  try {
    const files = await fsp.readdir(logDir);
    const now = Date.now();
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

    let purged = 0;
    for (const file of files) {
      if (!file.endsWith('.ndjson') && !file.endsWith('.jsonl')) continue;
      const filePath = path.join(logDir, file);
      try {
        const stat = await fsp.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fsp.unlink(filePath);
          purged++;
          pinoLogger.info({ file }, 'Purged old log file');
        }
      } catch (e) {
        pinoLogger.warn({ err: e.message, file }, 'Could not purge log file');
      }
    }
    pinoLogger.info({ purged }, 'Log purge complete');
  } catch (e) {
    pinoLogger.warn({ err: e.message }, 'Log purge directory not found or inaccessible');
  }

  // Purge task run logs (stored per-task per-node in subdirectories)
  const taskLogDir = path.join(NONBACKUP_MOUNT, SYSTEM_NAMESPACE, 'tasks');
  try {
    const taskDirs = await fsp.readdir(taskLogDir, { withFileTypes: true });
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let purged = 0;

    for (const taskDirent of taskDirs) {
      if (!taskDirent.isDirectory()) continue;
      const taskDirPath = path.join(taskLogDir, taskDirent.name);

      // Each task has per-node subdirectories: tasks/{taskId}/{nodeId}/*.log
      const nodeDirs = await fsp.readdir(taskDirPath, { withFileTypes: true });
      for (const nodeDirent of nodeDirs) {
        if (!nodeDirent.isDirectory()) continue;
        const nodeDirPath = path.join(taskDirPath, nodeDirent.name);
        const logFiles = await fsp.readdir(nodeDirPath);

        for (const file of logFiles) {
          if (!file.endsWith('.log')) continue;
          const filePath = path.join(nodeDirPath, file);
          try {
            const stat = await fsp.stat(filePath);
            if (stat.mtimeMs < cutoff) {
              await fsp.unlink(filePath);
              purged++;
            }
          } catch (e) {
            pinoLogger.warn({ err: e.message, file: filePath }, 'Could not purge task log file');
          }
        }
      }
    }

    if (purged > 0) {
      pinoLogger.info({ purged }, 'Task log purge complete');
    }
  } catch (e) {
    // tasks directory may not exist yet — that's fine
    if (e.code !== 'ENOENT') {
      pinoLogger.warn({ err: e.message }, 'Task log purge directory not found or inaccessible');
    }
  }
}