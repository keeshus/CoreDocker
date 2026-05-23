import etcd from '../services/db.js';

const nodeId = process.env.NODE_ID || 'master';
const LOCKS_PREFIX = 'locks/container/';

export async function withContainerLock(containerId, callback) {
  const lockKey = `${LOCKS_PREFIX}${containerId}`;
  const lease = etcd.lease(120);
  try {
    const success = await etcd.put(lockKey).value(nodeId).lease(lease).ifAbsent();
    if (!success) {
      await lease.revoke();
      throw new Error(`Container ${containerId} is being modified by another operation`);
    }
    return await callback();
  } finally {
    try { await lease.revoke(); } catch (e) {
      console.warn(`[Locks] Failed to revoke lease for ${containerId}: ${e.message}`);
    }
  }
}