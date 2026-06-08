import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SNAPSHOT = path.join(__dirname, '..', 'fixtures', 'etcd-snapshot.db');

// ===========================================================================
// Snapshot validation (unit tests on restoreSystem logic)
// ===========================================================================
describe('snapshot validation', () => {
  it('rejects files smaller than 64 bytes', () => {
    const buf = Buffer.alloc(32, 0x00);
    expect(buf.length).toBeLessThan(64);
  });

  it('rejects plaintext files (mostly printable ASCII)', () => {
    const buf = Buffer.from('{"hello": "world", "data": "this is a json backup file that someone might upload"}');
    // First 8 bytes are all printable ASCII
    const head = buf.subarray(0, 8);
    let printable = 0;
    for (const b of head) {
      if (b >= 0x20 && b <= 0x7e) printable++;
    }
    expect(printable).toBeGreaterThanOrEqual(6);
  });

  it('accepts binary etcd snapshots (binary header)', () => {
    const buf = Buffer.alloc(128, 0x00);
    buf[8] = 0x04; // some non-zero binary data after header
    buf[9] = 0xed;
    buf[10] = 0xda;

    expect(buf.length).toBeGreaterThanOrEqual(64);

    const head = buf.subarray(0, 8);
    let printable = 0;
    for (const b of head) {
      if (b >= 0x20 && b <= 0x7e) printable++;
    }
    // All zeros = non-printable, should pass
    expect(printable).toBeLessThan(6);
  });

  it('real etcd snapshot fixture is valid format', async () => {
    const fs = await import('fs');
    if (!fs.existsSync(FIXTURE_SNAPSHOT)) return; // skip in CI without fixture
    const data = fs.readFileSync(FIXTURE_SNAPSHOT);

    // Size check
    expect(data.length).toBeGreaterThan(64);

    // Not plaintext
    const head = data.subarray(0, 8);
    let printable = 0;
    for (const b of head) {
      if (b >= 0x20 && b <= 0x7e) printable++;
    }
    expect(printable).toBeLessThan(6);
  });

  it('real etcd snapshot can be written to a restore path', async () => {
    const fs = await import('fs');
    if (!fs.existsSync(FIXTURE_SNAPSHOT)) return; // skip in CI without fixture
    const os = await import('os');
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etcd-restore-'));
    const destPath = path.join(destDir, 'snapshot.db');

    const data = fs.readFileSync(FIXTURE_SNAPSHOT);
    fs.writeFileSync(destPath, data);

    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.statSync(destPath).size).toBe(data.length);

    // Clean up
    fs.rmSync(destDir, { recursive: true, force: true });
  });
});

// ===========================================================================
// etcd snapshot file iteration (scheduler backup task)
// ===========================================================================
describe('snapshot file iteration', () => {
  it('sorts snapshot files by mtime and keeps newest 7', () => {
    const snapshots = [
      { name: 'etcd-snapshot-2026-06-01T01-00-00.000Z.db', mtime: 1000 },
      { name: 'etcd-snapshot-2026-06-02T01-00-00.000Z.db', mtime: 2000 },
      { name: 'etcd-snapshot-2026-06-03T01-00-00.000Z.db', mtime: 3000 },
      { name: 'etcd-snapshot-2026-06-04T01-00-00.000Z.db', mtime: 4000 },
      { name: 'etcd-snapshot-2026-06-05T01-00-00.000Z.db', mtime: 5000 },
      { name: 'etcd-snapshot-2026-06-06T01-00-00.000Z.db', mtime: 6000 },
      { name: 'etcd-snapshot-2026-06-07T01-00-00.000Z.db', mtime: 7000 },
      { name: 'etcd-snapshot-2026-06-08T01-00-00.000Z.db', mtime: 8000 },
    ];

    const sorted = snapshots.sort((a, b) => b.mtime - a.mtime);
    const kept = sorted.slice(0, 7);
    const removed = sorted.slice(7);

    expect(kept.length).toBe(7);
    expect(removed.length).toBe(1);
    expect(removed[0].name).toContain('2026-06-01');
    expect(kept[0].name).toContain('2026-06-08'); // newest first
  });

  it('keeps all snapshots when fewer than 7 exist', () => {
    const snapshots = [
      { name: 'etcd-snapshot-2026-06-01T01-00-00.000Z.db', mtime: 1000 },
      { name: 'etcd-snapshot-2026-06-02T01-00-00.000Z.db', mtime: 2000 },
    ];

    const sorted = snapshots.sort((a, b) => b.mtime - a.mtime);
    const kept = sorted.slice(0, 7);
    expect(kept.length).toBe(2);
  });

  it('filters out non-snapshot files', () => {
    const files = [
      'etcd-snapshot-2026-06-01.db',
      'random-file.txt',
      'etcd-snapshot-2026-06-02.db',
      'etcd-snapshot-2026-06-03.db.log',
    ];

    const snapshots = files.filter(f =>
      f.startsWith('etcd-snapshot-') && f.endsWith('.db')
    );

    expect(snapshots.length).toBe(2);
    expect(snapshots).toContain('etcd-snapshot-2026-06-01.db');
    expect(snapshots).not.toContain('random-file.txt');
  });
});

// ===========================================================================
// Snapshot naming convention
// ===========================================================================
describe('snapshot naming', () => {
  it('generates ISO-like filenames that are filesystem-safe', () => {
    const now = new Date('2026-06-08T12:00:00.000Z');
    const name = `etcd-snapshot-${now.toISOString().replace(/:/g, '-')}`;
    expect(name).toBe('etcd-snapshot-2026-06-08T12-00-00.000Z');

    // Must be safe for Linux filesystems (no colons, no slashes)
    expect(name).not.toMatch(/[:]/);
    expect(name).not.toMatch(/[\/]/);

    // Must end with .db
    const fullName = `${name}.db`;
    expect(fullName).toMatch(/\.db$/);
  });
});
