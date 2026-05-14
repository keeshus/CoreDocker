import { getContainers, saveContainer } from '../services/db.js';

export const name = '001_fix_ha_container_status';

export async function up() {
  console.log('[Migration 001] Checking HA containers for stale status...');
  const containers = await getContainers();
  let fixed = 0;

  for (const c of containers) {
    const needsFix = c.ha && c.ha_allowed_nodes && c.ha_allowed_nodes.length > 0 && c.status === 'error: missing-pinned-node';
    if (needsFix) {
      await saveContainer(c.id, c.name, c.config, 'stopped', null, null);
      fixed++;
    }
  }

  console.log(`[Migration 001] Fixed ${fixed} HA container(s) with stale status.`);
}
