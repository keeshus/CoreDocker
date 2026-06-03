import { etcd } from '../services/db.js';
import { nodeId } from '../config.js';

const LOCKS_PREFIX = 'locks/container/';

export async function withContainerLock(containerId, callback) {
  const lockKey = `${LOCKS_PREFIX}${containerId}`;
  const lease = etcd.lease(120);
  let acquired = false;
  try {
    // Atomic compare-and-swap: only create the lock key if it doesn't exist.
    // The non-atomic get-then-put pattern has a TOCTOU race where two
    // concurrent callers can both see no lock and both acquire it.
    const result = await etcd.if(lockKey, 'Create', '==', 0)
      .then(lease.put(lockKey).value(nodeId))
      .commit();
    if (!result.succeeded) {
      throw new Error(`Container ${containerId} is being modified by another operation`);
    }
    acquired = true;
    return await callback();
  } finally {
    if (acquired) {
      await lease.revoke().catch(() => {});
    }
  }
}