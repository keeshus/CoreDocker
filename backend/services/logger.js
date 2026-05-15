import pino from 'pino';
import etcd from './db.js';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SYSTEM_NAMESPACE } from './ephemeral-tasks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_RETENTION_KEY = 'settings/log_retention_days';
const DEFAULT_RETENTION_DAYS = 7;
const BACKUP_MOUNT = '/mnt/backup';

const getLogDir = () => {
  return path.join(BACKUP_MOUNT, SYSTEM_NAMESPACE, 'logs');
};

const logDir = getLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logStream = fs.createWriteStream(path.join(logDir, 'system.ndjson'), { flags: 'a' });

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
}