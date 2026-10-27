import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceRun, LabStatus } from '@livinglayer/domain';
import { LabError } from './errors.js';

export class EvidenceStore {
  private db: DatabaseSync;
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'livinglayer.sqlite'));
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta_budget (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL);`);
  }
  save(run: EvidenceRun): void {
    this.db
      .prepare('INSERT INTO evidence VALUES (?, ?, ?)')
      .run(run.id, run.createdAt, JSON.stringify(run));
  }
  list(): EvidenceRun[] {
    return this.db
      .prepare('SELECT payload FROM evidence ORDER BY rowid DESC LIMIT 200')
      .all()
      .map((row) => JSON.parse(String(row.payload)) as EvidenceRun);
  }
  usedToday(): number {
    const row = this.db
      .prepare('SELECT attempts FROM meta_budget WHERE day = ?')
      .get(new Date().toISOString().slice(0, 10));
    return Number(row?.attempts ?? 0);
  }
  reserveRequest(limit: number): void {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.db
      .prepare(
        `INSERT INTO meta_budget (day, attempts) VALUES (?, 1)
      ON CONFLICT(day) DO UPDATE SET attempts = attempts + 1 WHERE attempts < ? RETURNING attempts`,
      )
      .get(day, limit);
    if (!row)
      throw new LabError(
        'request_budget',
        'The configured daily Meta request allowance is exhausted.',
        429,
      );
  }
  asset(runId: string, name: string, content: string | Buffer): string {
    if (!/^[a-z0-9-]+$/.test(runId) || !/^[a-z0-9.-]+$/.test(name))
      throw new Error('Invalid artifact name');
    const path = join(this.dir, 'evidence', runId);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(path, name), content, { mode: 0o600 });
    return `${runId}/${name}`;
  }
  liveEvidence(): LabStatus['liveEvidence'] {
    const runs = this.db
      .prepare(
        "SELECT payload FROM evidence WHERE json_extract(payload, '$.mode') = 'live' AND json_extract(payload, '$.status') = 'completed'",
      )
      .all()
      .map((row) => JSON.parse(String(row.payload)) as EvidenceRun);
    return {
      text: runs.some((r) => r.kind === 'text'),
      discover: runs.some((r) => r.kind === 'discover'),
      segment: runs.some(
        (r) =>
          r.kind === 'segment' &&
          /^(mug|cream mug|cup)$/i.test(String((r.output as { concept?: string }).concept)),
      ),
      lamp: runs.some((r) => r.kind === 'lamp'),
    };
  }
  close(): void {
    this.db.close();
  }
}
