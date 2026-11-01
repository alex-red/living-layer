/**
 * The lab's stored runs, jobs and desk memory, for scripts: the SQLite file
 * and the evidence folder under DATA_DIR, opened read-only so a running
 * server is never disturbed (the store itself writes when it opens).
 * Nothing here calls a model. A run is found by its id, the start of its id
 * (as the log shows it), or `latest`.
 */
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DeskMemory, EvidenceRun, Job, Mode, RunKind } from '@livinglayer/domain';

const root = resolve(import.meta.dir, '../..');
/** The main checkout, when this is a worktree of it: where the running server keeps its data. */
function mainCheckout(): string | null {
  const git = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], { cwd: root });
  const common = git.success ? resolve(root, git.stdout.toString().trim()) : null;
  return common ? dirname(common) : null;
}
/**
 * Where the lab keeps its data: DATA_DIR from .env, as the server reads it.
 * In a worktree with no data of its own, the main checkout's, which the
 * running server uses (opened read-only here).
 */
export function dataDir() {
  if (process.env.DATA_DIR) return resolve(root, process.env.DATA_DIR);
  const own = resolve(root, '.data');
  if (existsSync(own)) return own;
  const main = mainCheckout();
  return main && existsSync(join(main, '.data')) ? join(main, '.data') : own;
}
/** Captured rooms for the rooms bench: local only, under the ignored data folder. */
export const roomsDir = () => process.env.ROOMS_DIR ?? join(dataDir(), 'rooms');

export interface Evidence {
  /** The latest runs, newest first. */
  runs(options?: { kind?: RunKind; mode?: Mode; limit?: number }): EvidenceRun[];
  /** One run by id, id prefix or `latest` (of `kind`, completed when `kind` is given). */
  run<T = unknown>(ref: string, kind?: RunKind): EvidenceRun<T>;
  /** The job that made a run, with its steps and their pictures. */
  jobOf(runId: string): Job | undefined;
  memory(mode: Mode): DeskMemory | undefined;
  asset(path: string): Buffer | null;
  close(): void;
}

export function openEvidence(dir = dataDir()): Evidence {
  const file = join(dir, 'livinglayer.sqlite');
  if (!existsSync(file))
    throw new Error(`No lab data at ${file}: run the app once, or set DATA_DIR.`);
  const db = new Database(file, { readonly: true });
  const parse = <T>(rows: { payload: string }[]) => rows.map((r) => JSON.parse(r.payload) as T);
  const runs: Evidence['runs'] = ({
    kind,
    mode,
    limit = 20,
  }: Parameters<Evidence['runs']>[0] = {}) =>
    parse<EvidenceRun>(
      db
        .query<{ payload: string }, [string | null, string | null, number]>(
          `SELECT payload FROM evidence
           WHERE (?1 IS NULL OR json_extract(payload, '$.kind') = ?1)
             AND (?2 IS NULL OR json_extract(payload, '$.mode') = ?2)
           ORDER BY rowid DESC LIMIT ?3`,
        )
        .all(kind ?? null, mode ?? null, limit),
    );
  return {
    runs,
    run<T>(ref: string, kind?: RunKind) {
      const found =
        ref === 'latest'
          ? runs({ ...(kind ? { kind } : {}), limit: 50 }).find(
              (r) => !kind || r.status === 'completed',
            )
          : parse<EvidenceRun>(
              db
                .query<{ payload: string }, [string]>(
                  'SELECT payload FROM evidence WHERE id LIKE ?1 ORDER BY rowid DESC LIMIT 2',
                )
                .all(`${ref}%`),
            ).filter((r, _, all) => all.length === 1 || r.id === ref)[0];
      if (!found) throw new Error(`No ${kind ?? ''} run "${ref}" in ${dir}`);
      if (kind && found.kind !== kind)
        throw new Error(`Run ${found.id} is a ${found.kind} run, not ${kind}`);
      return found as EvidenceRun<T>;
    },
    jobOf(runId) {
      return parse<Job>(
        db
          .query<{ payload: string }, [string]>(
            'SELECT payload FROM jobs WHERE payload LIKE ?1 ORDER BY created_at DESC LIMIT 1',
          )
          .all(`%${runId}%`),
      )[0];
    },
    memory(mode) {
      const row = db
        .query<{ payload: string }, [string]>('SELECT payload FROM desk_memory WHERE mode = ?1')
        .get(mode);
      return row ? (JSON.parse(row.payload) as DeskMemory) : undefined;
    },
    asset(path) {
      const [runId, name] = path.split('/');
      if (!runId || !name || !/^[a-z0-9-]+$/.test(runId) || !/^[a-z0-9.-]+$/.test(name))
        return null;
      try {
        return readFileSync(join(dir, 'evidence', runId, name));
      } catch {
        return null;
      }
    },
    close: () => db.close(),
  };
}
