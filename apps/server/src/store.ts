import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isMugConcept,
  type EvidenceRun,
  type LabStatus,
  type DeskMemory,
  type Mode,
} from '@livinglayer/domain';
import { LabError } from './errors.js';

type Payload = { payload: string };

export class EvidenceStore {
  private db: Database;
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(dir, 'livinglayer.sqlite'), { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta_budget (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS desk_memory (mode TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS placement_claims (segment_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);`);
  }
  save(run: EvidenceRun): void {
    this.db.run('INSERT INTO evidence VALUES (?, ?, ?)', [
      run.id,
      run.createdAt,
      JSON.stringify(run),
    ]);
  }
  getRun(id: string): EvidenceRun | undefined {
    const row = this.db
      .query<Payload, [string]>('SELECT payload FROM evidence WHERE id = ?')
      .get(id);
    return row ? (JSON.parse(row.payload) as EvidenceRun) : undefined;
  }
  latestSegment(mode: Mode): string | undefined {
    const row = this.db
      .query<{ id: string }, [Mode]>(
        "SELECT id FROM evidence WHERE json_extract(payload, '$.mode') = ? AND json_extract(payload, '$.kind') = 'segment' ORDER BY rowid DESC LIMIT 1",
      )
      .get(mode);
    return row ? row.id : undefined;
  }
  updateRun(run: EvidenceRun): void {
    this.db.run('UPDATE evidence SET payload = ? WHERE id = ?', [JSON.stringify(run), run.id]);
  }
  memory(mode: Mode): DeskMemory {
    const row = this.db
      .query<Payload, [Mode]>('SELECT payload FROM desk_memory WHERE mode = ?')
      .get(mode);
    return row
      ? (JSON.parse(row.payload) as DeskMemory)
      : { mode, object: null, observation: null, zone: null, lastDecision: null };
  }
  saveMemory(memory: DeskMemory): void {
    this.db.run(
      'INSERT INTO desk_memory VALUES (?, ?) ON CONFLICT(mode) DO UPDATE SET payload = excluded.payload',
      [memory.mode, JSON.stringify(memory)],
    );
  }
  claimPlacement(segmentId: string): boolean {
    return (
      this.db.run('INSERT OR IGNORE INTO placement_claims VALUES (?, ?)', [
        segmentId,
        new Date().toISOString(),
      ]).changes === 1
    );
  }
  list(): EvidenceRun[] {
    return this.db
      .query<Payload, []>('SELECT payload FROM evidence ORDER BY rowid DESC LIMIT 200')
      .all()
      .map((row) => JSON.parse(row.payload) as EvidenceRun);
  }
  usedToday(): number {
    const row = this.db
      .query<{ attempts: number }, [string]>('SELECT attempts FROM meta_budget WHERE day = ?')
      .get(new Date().toISOString().slice(0, 10));
    return row?.attempts ?? 0;
  }
  reserveRequest(limit: number): void {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.db
      .query<{ attempts: number }, [string, number]>(
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
  readAsset(asset: string): Buffer | null {
    const [runId, name] = asset.split('/');
    if (!runId || !name || !/^[a-z0-9-]+$/.test(runId) || !/^[a-z0-9.-]+$/.test(name)) return null;
    try {
      return readFileSync(join(this.dir, 'evidence', runId, name));
    } catch {
      return null;
    }
  }
  liveEvidence(): LabStatus['liveEvidence'] {
    const runs = this.db
      .query<Payload, []>(
        "SELECT payload FROM evidence WHERE json_extract(payload, '$.mode') = 'live' AND json_extract(payload, '$.status') = 'completed'",
      )
      .all()
      .map((row) => JSON.parse(row.payload) as EvidenceRun);
    return {
      text: runs.some((r) => r.kind === 'text'),
      discover: runs.some((r) => r.kind === 'discover'),
      segment: runs.some(
        (r) =>
          r.kind === 'segment' && isMugConcept(String((r.output as { concept?: string }).concept)),
      ),
      lamp: runs.some(
        (r) =>
          r.kind === 'lamp' ||
          (r.kind === 'placement' &&
            (r.output as { lamp?: { stateConfirmed?: boolean } }).lamp?.stateConfirmed === true),
      ),
    };
  }
  close(): void {
    this.db.close();
  }
}
