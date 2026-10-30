import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isMugConcept,
  runCost,
  upgradeMemory,
  type EvidenceRun,
  type Job,
  type LabStatus,
  type DeskMemory,
  type Mode,
} from '@livinglayer/domain';

type Payload = { payload: string };

export class EvidenceStore {
  private db: Database;
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(dir, 'livinglayer.sqlite'), { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta_budget (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta_spend (day TEXT PRIMARY KEY, usd REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desk_memory (mode TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS placement_claims (segment_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);`);
    this.renameDemoMode();
  }
  /**
   * The offline mode used to be called `fixture`. Payloads are compact JSON, so
   * the mode and the virtual light ids can be renamed as text.
   */
  private renameDemoMode(): void {
    const renamed = (column: string) =>
      `replace(replace(replace(${column}, '"mode":"fixture"', '"mode":"demo"'), '"source":"fixture"', '"source":"demo"'), 'light.fixture_', 'light.demo_')`;
    this.db.transaction(() => {
      this.db.run(
        `UPDATE evidence SET payload = ${renamed('payload')} WHERE payload LIKE '%fixture%'`,
      );
      this.db.run(
        `UPDATE OR IGNORE desk_memory SET mode = 'demo', payload = ${renamed('payload')} WHERE mode = 'fixture'`,
      );
      this.db.run("DELETE FROM desk_memory WHERE mode = 'fixture'");
    })();
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
      ? upgradeMemory(JSON.parse(row.payload) as DeskMemory)
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
  /** An AI job that ended: its steps, timings, pictures and the runs it made. */
  saveJob(job: Job): void {
    this.db.run(
      'INSERT INTO jobs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
      [job.id, job.createdAt, JSON.stringify(job)],
    );
  }
  getJob(id: string): Job | undefined {
    const row = this.db.query<Payload, [string]>('SELECT payload FROM jobs WHERE id = ?').get(id);
    return row ? (JSON.parse(row.payload) as Job) : undefined;
  }
  /** The latest jobs, newest first, as many as the run log keeps. */
  listJobs(): Job[] {
    return this.db
      .query<Payload, []>('SELECT payload FROM jobs ORDER BY created_at DESC LIMIT 200')
      .all()
      .map((row) => JSON.parse(row.payload) as Job);
  }
  usedToday(): number {
    const row = this.db
      .query<{ attempts: number }, [string]>('SELECT attempts FROM meta_budget WHERE day = ?')
      .get(new Date().toISOString().slice(0, 10));
    return row?.attempts ?? 0;
  }
  /** Count one outbound attempt, failed or not. */
  countRequest(): void {
    this.db.run(
      `INSERT INTO meta_budget (day, attempts) VALUES (?, 1)
      ON CONFLICT(day) DO UPDATE SET attempts = attempts + 1`,
      [new Date().toISOString().slice(0, 10)],
    );
  }
  /**
   * What today's live calls (UTC) have cost, from each call's own usage. A day
   * that began before this ledger existed starts from its saved runs.
   */
  spentToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.db
      .query<{ usd: number }, [string]>('SELECT usd FROM meta_spend WHERE day = ?')
      .get(day);
    if (row) return row.usd;
    const usd = this.list()
      .filter((r) => r.createdAt.startsWith(day))
      .reduce((sum, r) => sum + (runCost(r) ?? 0), 0);
    this.db.run('INSERT OR IGNORE INTO meta_spend (day, usd) VALUES (?, ?)', [day, usd]);
    return usd;
  }
  addSpend(usd: number): void {
    if (!(usd > 0)) return;
    this.spentToday(); // seeds today's row first
    this.db.run('UPDATE meta_spend SET usd = usd + ? WHERE day = ?', [
      usd,
      new Date().toISOString().slice(0, 10),
    ]);
  }
  /** The daily spend limit someone set in the lab, or `fallback` from the config. */
  spendLimit(fallback: number): number {
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
      .get('spend_limit_usd');
    const usd = row ? Number(row.value) : NaN;
    return Number.isFinite(usd) && usd > 0 ? usd : fallback;
  }
  /** Set the daily spend limit; null goes back to the config's. */
  setSpendLimit(usd: number | null): void {
    if (usd === null) this.db.run('DELETE FROM settings WHERE key = ?', ['spend_limit_usd']);
    else
      this.db.run(
        'INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ['spend_limit_usd', String(usd)],
      );
  }
  /** A value kept in `settings`, or null. */
  setting(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
      .get(key);
    return row ? row.value : null;
  }
  setSetting(key: string, value: string): void {
    this.db.run(
      'INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
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
      // Proof of the lamp: a light turned on, not a switch or a light turned off.
      lamp: runs.some(
        (r) =>
          (r.kind === 'lamp' &&
            !String((r.output as { entityId?: string }).entityId).startsWith('switch.') &&
            (r.output as { action?: string }).action !== 'off') ||
          (r.kind === 'placement' &&
            (r.output as { lamp?: { stateConfirmed?: boolean } }).lamp?.stateConfirmed === true),
      ),
    };
  }
  close(): void {
    this.db.close();
  }
}
