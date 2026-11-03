import { Database } from 'bun:sqlite';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  deskMemorySchema,
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

export interface MetaCallRecord {
  kind: string;
  createdAt: string;
  durationMs: number;
  outputTokens: number | null;
  maxOutputTokens: number | null;
  timeoutMs: number;
  cause: string | null;
}

/** Where streaming measurements go, one JSON line each; `bun run runs --streams` reads them. */
export const STREAM_STATS_FILE = 'stream-stats.jsonl';

/** One streaming measurement: a tab's playback, a phone's sending, or the watcher's frames. */
export function appendStreamStats(
  dir: string,
  record: { source: string } & Record<string, unknown>,
) {
  appendFileSync(
    join(dir, STREAM_STATS_FILE),
    `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
  );
}

export class EvidenceStore {
  private db: Database;
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(dir, 'livinglayer.sqlite'), { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta_budget (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta_spend (day TEXT PRIMARY KEY, usd REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desk_memory (mode TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS placement_claims (segment_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, payload TEXT NOT NULL);`);
    this.migrate();
  }
  /**
   * Keep a person's pick between a fixture's drafts, one JSON line each in
   * `fixture-picks.jsonl`: what was chosen and over what, for later study.
   */
  appendPick(pick: Record<string, unknown>): void {
    appendFileSync(join(this.dir, 'fixture-picks.jsonl'), `${JSON.stringify(pick)}\n`);
  }
  appendStreamStats(record: { source: string } & Record<string, unknown>): void {
    appendStreamStats(this.dir, record);
  }
  /** Each migration runs once, in order; `PRAGMA user_version` is how many have. */
  private migrate(): void {
    const migrations = [() => this.renameDemoMode(), () => this.indexEvidence()];
    const done = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!;
    for (let v = done.user_version; v < migrations.length; v++) {
      this.db.transaction(() => {
        migrations[v]!();
        this.db.run(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }
  /**
   * Mode, kind and status as generated columns with an index, so the hot reads
   * (`/api/status`, the latest segment) don't parse every run's payload.
   */
  private indexEvidence(): void {
    for (const column of ['mode', 'kind', 'status'])
      this.db.run(
        `ALTER TABLE evidence ADD COLUMN ${column} TEXT GENERATED ALWAYS AS (json_extract(payload, '$.${column}')) VIRTUAL`,
      );
    this.db.run('CREATE INDEX evidence_mode_kind_status ON evidence (mode, kind, status)');
    this.db.run('CREATE INDEX evidence_created ON evidence (created_at)');
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
    this.db.run('INSERT INTO evidence (id, created_at, payload) VALUES (?, ?, ?)', [
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
        "SELECT id FROM evidence WHERE mode = ? AND kind = 'segment' ORDER BY rowid DESC LIMIT 1",
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
      ? this.parseMemory(mode, row.payload)
      : { mode, object: null, observation: null, zone: null, lastDecision: null };
  }
  private readonly badMemory = new Set<Mode>();
  /**
   * Saved memory through its schema (which upgrades earlier versions). Memory
   * that no longer fits is kept as it is, upgraded and unchecked, rather than
   * lost; the cause is logged once per mode.
   */
  private parseMemory(mode: Mode, payload: string): DeskMemory {
    const raw: unknown = JSON.parse(payload);
    const parsed = deskMemorySchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    if (!this.badMemory.has(mode)) {
      this.badMemory.add(mode);
      console.error(
        `[server] ${mode} desk memory does not fit its schema, using it as saved: ${parsed.error.message}`,
      );
    }
    try {
      return upgradeMemory(raw as DeskMemory);
    } catch {
      return raw as DeskMemory;
    }
  }
  saveMemory(memory: DeskMemory): void {
    this.db.run(
      'INSERT INTO desk_memory VALUES (?, ?) ON CONFLICT(mode) DO UPDATE SET payload = excluded.payload',
      [memory.mode, JSON.stringify(memory)],
    );
  }
  /**
   * Change a mode's desk memory against what is saved now: read, apply and save in one
   * synchronous step, so nothing saved meanwhile is lost. Never hold a memory over an await.
   */
  updateMemory<T = void>(mode: Mode, change: (memory: DeskMemory) => T): T {
    const memory = this.memory(mode);
    const result = change(memory);
    this.saveMemory(memory);
    return result;
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
  /**
   * What `estimateCost` needs of the latest 200 runs (kind, mode, usage), read
   * without parsing their outputs.
   */
  costHistory(): EvidenceRun[] {
    return this.db
      .query<{ kind: string; mode: string; usage: string | null }, []>(
        "SELECT kind, mode, json_extract(payload, '$.usage') AS usage FROM (SELECT rowid, kind, mode, payload FROM evidence ORDER BY rowid DESC LIMIT 200)",
      )
      .all()
      .map(
        (r) => ({ ...r, usage: r.usage ? JSON.parse(r.usage) : null }) as unknown as EvidenceRun,
      );
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
  listJobs(options: { pictures?: boolean } = {}): Job[] {
    // Without pictures they are dropped in SQL: they are most of a job's bytes.
    const payload = options.pictures
      ? 'payload'
      : "json_set(payload, '$.steps', (SELECT json_group_array(json_remove(s.value, '$.image')) FROM json_each(payload, '$.steps') s))";
    return this.db
      .query<Payload, []>(
        `SELECT ${payload} AS payload FROM jobs ORDER BY created_at DESC LIMIT 200`,
      )
      .all()
      .map((row) => JSON.parse(row.payload) as Job);
  }
  recordCall(call: MetaCallRecord): void {
    this.db.run('INSERT INTO meta_calls (created_at, payload) VALUES (?, ?)', [
      call.createdAt,
      JSON.stringify(call),
    ]);
  }
  listCalls(): MetaCallRecord[] {
    return this.db
      .query<Payload, []>('SELECT payload FROM meta_calls ORDER BY id ASC')
      .all()
      .map((row) => JSON.parse(row.payload) as MetaCallRecord);
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
  /** Whether tracking may call SAM or Spark: off unless someone turned it on in the lab. */
  trackingAi(): boolean {
    return this.setting('tracking_ai') === 'on';
  }
  setTrackingAi(on: boolean): void {
    if (on) this.setSetting('tracking_ai', 'on');
    else this.deleteSetting('tracking_ai');
  }
  /** A value kept in `settings`, or null. */
  setting(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
      .get(key);
    return row ? row.value : null;
  }
  deleteSetting(key: string): void {
    this.db.run('DELETE FROM settings WHERE key = ?', [key]);
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
    const kinds = this.db
      .query<
        {
          kind: string;
          concept: string | null;
          entity: string | null;
          action: string | null;
          confirmed: number | null;
        },
        []
      >(
        `SELECT kind,
          json_extract(payload, '$.output.concept') AS concept,
          json_extract(payload, '$.output.entityId') AS entity,
          json_extract(payload, '$.output.action') AS action,
          json_extract(payload, '$.output.lamp.stateConfirmed') AS confirmed
        FROM evidence
        WHERE mode = 'live' AND status = 'completed'
          AND kind IN ('text', 'discover', 'segment', 'lamp', 'placement')`,
      )
      .all();
    return {
      text: kinds.some((r) => r.kind === 'text'),
      discover: kinds.some((r) => r.kind === 'discover'),
      segment: kinds.some((r) => r.kind === 'segment' && isMugConcept(String(r.concept))),
      // Proof of the lamp: a light turned on, not a switch, a fan or a light turned off.
      lamp: kinds.some(
        (r) =>
          (r.kind === 'lamp' && String(r.entity).startsWith('light.') && r.action !== 'off') ||
          (r.kind === 'placement' && r.confirmed === 1),
      ),
    };
  }
  /**
   * Delete evidence runs, jobs and their files older than `maxAgeMs`, except any
   * run the desk still leans on: a run whose id appears in desk memory or a
   * setting is kept, and so is whatever a kept run names in turn (an item's
   * segment, a brush's previous frame). Only `<dir>/evidence/<run>` is removed;
   * captured rooms live elsewhere and are never touched.
   */
  prune(maxAgeMs: number, now = Date.now()): { runs: number; jobs: number; bytes: number } {
    const cutoff = new Date(now - maxAgeMs).toISOString();
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    const idsIn = (text: string) => text.match(uuid) ?? [];
    const keep = new Set<string>();
    const queue: string[] = [];
    const hold = (text: string) => {
      for (const id of idsIn(text)) if (!keep.has(id)) (keep.add(id), queue.push(id));
    };
    for (const sql of ['SELECT payload AS v FROM desk_memory', 'SELECT value AS v FROM settings'])
      for (const row of this.db.query<{ v: string }, []>(sql).all()) hold(row.v);
    // What a newer run names stays too (a follow-up's previous run).
    for (const row of this.db
      .query<Payload, [string]>('SELECT payload FROM evidence WHERE created_at >= ?')
      .all(cutoff))
      hold(row.payload);
    const named = this.db.query<Payload, [string]>('SELECT payload FROM evidence WHERE id = ?');
    for (let id = queue.pop(); id; id = queue.pop()) {
      const row = named.get(id);
      if (row) hold(row.payload);
    }
    const old = this.db
      .query<{ id: string }, [string]>('SELECT id FROM evidence WHERE created_at < ?')
      .all(cutoff)
      .map((r) => r.id)
      .filter((id) => !keep.has(id));
    let bytes = 0;
    const sizeOf = (path: string): number => {
      try {
        const info = statSync(path);
        return info.isDirectory()
          ? readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0)
          : info.size;
      } catch {
        return 0;
      }
    };
    for (const id of old) {
      if (!/^[a-z0-9-]+$/.test(id)) continue;
      const path = join(this.dir, 'evidence', id);
      bytes += sizeOf(path);
      rmSync(path, { recursive: true, force: true });
      this.db.run('DELETE FROM evidence WHERE id = ?', [id]);
    }
    const jobs = this.db.run('DELETE FROM jobs WHERE created_at < ?', [cutoff]).changes;
    return { runs: old.length, jobs, bytes };
  }
  close(): void {
    this.db.close();
  }
}
