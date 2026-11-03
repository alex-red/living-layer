import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../apps/server/src/store.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'livinglayer-prune-'));
  dirs.push(dir);
  return dir;
};
const DAY = 86_400_000;
const NOW = Date.parse('2026-06-30T12:00:00Z');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const run = (id: string, daysAgo: number, extra: Record<string, unknown> = {}) =>
  ({
    id,
    kind: 'segment',
    mode: 'live',
    status: 'completed',
    createdAt: new Date(NOW - daysAgo * DAY).toISOString(),
    output: {},
    assets: [],
    ...extra,
  }) as never;

describe('evidence indexes', () => {
  it('answers the latest segment and the status reads from the index', () => {
    const store = new EvidenceStore(tmp());
    store.save(run(uuid(1), 1));
    const db = (store as unknown as { db: Database }).db;
    const plan = db
      .query<{ detail: string }, []>(
        "EXPLAIN QUERY PLAN SELECT id FROM evidence WHERE mode = 'live' AND kind = 'segment' ORDER BY rowid DESC LIMIT 1",
      )
      .all()
      .map((r) => r.detail)
      .join(' ');
    expect(plan).toContain('evidence_mode_kind_status');
    expect(store.latestSegment('live')).toBe(uuid(1));
    store.updateRun(run(uuid(1), 1, { kind: 'text', output: { concept: 'x' } }));
    expect(store.latestSegment('live')).toBeUndefined();
    expect(store.liveEvidence().text).toBe(true);
    expect(store.liveEvidence().lamp).toBe(false);
    store.close();
  });

  it('lists jobs without their pictures, in SQL', () => {
    const store = new EvidenceStore(tmp());
    store.saveJob({
      id: uuid(9),
      createdAt: new Date(NOW).toISOString(),
      steps: [{ id: 'a', label: 'A', image: 'data:image/png;base64,AAAA' }],
    } as never);
    expect(store.listJobs()[0]!.steps[0]).toEqual({ id: 'a', label: 'A' } as never);
    expect(store.listJobs({ pictures: true })[0]!.steps[0]!.image).toBeTruthy();
    store.close();
  });
});

describe('pruning old evidence', () => {
  it('deletes old runs and their files, and keeps what desk memory leans on', () => {
    const dir = tmp();
    const store = new EvidenceStore(dir);
    const [old, oldKept, oldNamed, oldChain, fresh] = [1, 2, 3, 4, 5].map(uuid) as [
      string,
      string,
      string,
      string,
      string,
    ];
    store.save(run(old, 90));
    store.save(run(oldKept, 90));
    store.save(run(oldNamed, 90));
    store.save(run(oldChain, 90));
    // A newer run names an old one; an old kept run names another.
    store.save(run(fresh, 1, { output: { previous: oldNamed } }));
    store.saveMemory({
      mode: 'live',
      object: null,
      observation: null,
      zone: null,
      lastDecision: { segmentId: oldKept },
    } as never);
    store.updateRun(run(oldKept, 90, { output: { source: oldChain } }));
    for (const id of [old, oldKept, oldNamed, oldChain, fresh])
      store.asset(id, 'source.webp', 'xx');
    mkdirSync(join(dir, 'rooms', 'office'), { recursive: true });
    writeFileSync(join(dir, 'rooms', 'office', 'frame.png'), 'room');

    const gone = store.prune(30 * DAY, NOW);
    expect(gone.runs).toBe(1);
    expect(gone.bytes).toBe(2);
    expect(existsSync(join(dir, 'evidence', old))).toBe(false);
    expect(store.getRun(old)).toBeUndefined();
    for (const id of [oldKept, oldNamed, oldChain, fresh]) {
      expect(store.getRun(id)).toBeDefined();
      expect(existsSync(join(dir, 'evidence', id, 'source.webp'))).toBe(true);
    }
    expect(existsSync(join(dir, 'rooms', 'office', 'frame.png'))).toBe(true);
    store.close();
  });

  it('drops old jobs too', () => {
    const store = new EvidenceStore(tmp());
    store.saveJob({
      id: uuid(7),
      createdAt: new Date(NOW - 60 * DAY).toISOString(),
      steps: [],
    } as never);
    store.saveJob({ id: uuid(8), createdAt: new Date(NOW).toISOString(), steps: [] } as never);
    expect(store.prune(30 * DAY, NOW).jobs).toBe(1);
    expect(store.listJobs().map((j) => j.id)).toEqual([uuid(8)]);
    store.close();
  });
});
