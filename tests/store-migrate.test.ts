import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../apps/server/src/store.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'livinglayer-store-'));
  dirs.push(dir);
  return dir;
};

describe('store migrations', () => {
  it('rename the old mode once, then leave later rows alone', () => {
    const dir = tmp();
    // A database from before migrations: the old table, no generated columns.
    const raw = new Database(join(dir, 'livinglayer.sqlite'), { strict: true, create: true });
    raw.run(
      'CREATE TABLE evidence (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)',
    );
    raw.run("INSERT INTO evidence VALUES ('a', 'now', '{\"mode\":\"fixture\"}')");
    raw.close();
    const first = new EvidenceStore(dir);
    expect(first.getRun('a')).toEqual({ mode: 'demo' } as never);
    first.save({ id: 'b', createdAt: 'now', mode: 'demo', source: 'fixture' } as never);
    first.close();
    const second = new EvidenceStore(dir);
    expect((second.getRun('b') as unknown as { source: string }).source).toBe('fixture');
    second.close();
  });

  it('waits on a busy database and writes with synchronous NORMAL', () => {
    const store = new EvidenceStore(tmp());
    const db = (store as unknown as { db: Database }).db;
    expect(db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()!.timeout).toBe(5000);
    expect(db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()!.synchronous).toBe(1);
    store.close();
  });
});
