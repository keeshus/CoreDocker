import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Using a volume path if available, or fallback to current dir
const dbDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = process.env.DB_PATH || path.join(dbDir, 'core.db');
const db = new Database(dbPath, { verbose: console.log });

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS containers (
    id TEXT PRIMARY KEY,
    docker_id TEXT,
    name TEXT UNIQUE,
    config TEXT,
    status TEXT
  );
`);

export const getContainers = () => {
  const stmt = db.prepare('SELECT * FROM containers');
  return stmt.all().map(c => ({
    ...c,
    config: JSON.parse(c.config)
  }));
};

export const getContainerById = (id) => {
  const stmt = db.prepare('SELECT * FROM containers WHERE id = ?');
  const c = stmt.get(id);
  if (c) {
    return { ...c, config: JSON.parse(c.config) };
  }
  return null;
};

export const getContainerByName = (name) => {
  const stmt = db.prepare('SELECT * FROM containers WHERE name = ?');
  const c = stmt.get(name);
  if (c) {
    return { ...c, config: JSON.parse(c.config) };
  }
  return null;
};

export const saveContainer = (id, name, config, status, docker_id = null) => {
  const stmt = db.prepare(`
    INSERT INTO containers (id, name, config, status, docker_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      config = excluded.config,
      status = excluded.status,
      docker_id = excluded.docker_id
  `);
  stmt.run(id, name, JSON.stringify(config), status, docker_id);
};

export const updateContainerDockerId = (id, docker_id) => {
  const stmt = db.prepare('UPDATE containers SET docker_id = ? WHERE id = ?');
  stmt.run(docker_id, id);
};

export const updateContainerStatus = (id, status) => {
  const stmt = db.prepare('UPDATE containers SET status = ? WHERE id = ?');
  stmt.run(status, id);
};

export const deleteContainer = (id) => {
  const stmt = db.prepare('DELETE FROM containers WHERE id = ?');
  stmt.run(id);
};

export default db;
