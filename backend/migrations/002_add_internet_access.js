import { getContainers, saveContainer, getGroups, saveGroup } from '../services/db.js';

export const name = '002_add_internet_access';

export async function up() {
  console.log('[Migration 002] Adding internetAccess to existing containers and groups...');

  const containers = await getContainers();
  let updatedContainers = 0;
  for (const c of containers) {
    if (c.config && c.config.internetAccess === undefined) {
      c.config.internetAccess = false;
      await saveContainer(c.id, c.name, c.config, c.status, c.docker_id, c.current_node);
      updatedContainers++;
    }
  }
  console.log(`[Migration 002] Updated ${updatedContainers} container(s).`);

  const groups = await getGroups();
  let updatedGroups = 0;
  for (const g of groups) {
    if (g.config && g.config.internetAccess === undefined) {
      g.config.internetAccess = false;
      await saveGroup(g.id, g.name, g.config);
      updatedGroups++;
    }
  }
  console.log(`[Migration 002] Updated ${updatedGroups} group(s).`);
}