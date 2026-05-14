import etcd from './db.js';

const MIGRATIONS_PREFIX = 'system/migrations/';

let appliedMigrations = new Set();

export async function loadAppliedMigrations() {
  try {
    const all = await etcd.getAll().prefix(MIGRATIONS_PREFIX).strings();
    appliedMigrations = new Set(Object.keys(all));
    console.log(`[Migrations] Loaded ${appliedMigrations.size} applied migration(s).`);
  } catch (e) {
    console.error(`[Migrations] Failed to load applied migrations: ${e.message}`);
    appliedMigrations = new Set();
  }
}

export function isMigrationApplied(name) {
  return appliedMigrations.has(`${MIGRATIONS_PREFIX}${name}`);
}

async function markMigrationApplied(name) {
  await etcd.put(`${MIGRATIONS_PREFIX}${name}`).value(JSON.stringify({ appliedAt: new Date().toISOString() }));
  appliedMigrations.add(`${MIGRATIONS_PREFIX}${name}`);
}

export async function runMigrations(migrations) {
  console.log('[Migrations] Checking for pending migrations...');
  await loadAppliedMigrations();

  const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
  let ranAny = false;

  for (const migration of sorted) {
    if (isMigrationApplied(migration.name)) {
      console.log(`[Migrations] Skipping ${migration.name} (already applied).`);
      continue;
    }

    console.log(`[Migrations] Running ${migration.name}...`);
    try {
      await migration.up();
      await markMigrationApplied(migration.name);
      console.log(`[Migrations] ${migration.name} completed successfully.`);
      ranAny = true;
    } catch (e) {
      console.error(`[Migrations] ${migration.name} FAILED: ${e.message}`);
      throw e;
    }
  }

  if (!ranAny) {
    console.log('[Migrations] No pending migrations to run.');
  }
}
