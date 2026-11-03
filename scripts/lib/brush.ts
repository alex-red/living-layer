/**
 * The AI brush from the shell ([plan](../../docs/plans/agent-tooling.md#c-brush-tooling)):
 * a selection and a sentence in, what the panel and the request each made
 * of it out, with the job's steps and pictures to look at. One harness for
 * `bun run brush`, `bun run bench:brush` and the tests.
 *
 * Demo mode runs in process (`buildApp` with a throwaway DATA_DIR, called
 * with `app.inject`), so it needs no server and never touches the dev
 * server's data. Live mode posts to the running server with a snapshot of
 * the saved camera, and reads the run's pictures from its data folder
 * (read-only).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import {
  floorSolid,
  renderRoom,
  roomMask,
  sceneSolids,
  sceneWithRecipe,
  selectionMask,
  type AssistDraft,
  type Bits,
  type DeskMemory,
  type EvidenceRun,
  type Job,
  type Mode,
  type Segmentation,
  type SelectionShape,
  type SelectResolve,
  type SelectionTarget,
} from '@livinglayer/domain';
import { buildApp } from '../../apps/server/src/app.js';
import { pngMask } from '../../apps/server/src/assist.js';
import { parseConfig } from '../../apps/server/src/config.js';
import { demoPng } from '../../apps/server/src/demo.js';
import { selectionRoom } from '../../apps/server/src/select.js';
import { dataDir } from './evidence.js';

/** The dev server, as `.env` runs it. */
export const LIVE_SERVER = `http://127.0.0.1:${process.env.PORT ?? 43431}`;
/**
 * What the brush is held to, in the tests and `bun run bench:brush`:
 * - `agree`: the share of selections where the panel and the request name the same target (all).
 * - `wholeNamed`: the share of things that a box around their drawing names.
 */
export const BRUSH_TARGETS = { agree: 1, wholeNamed: 0.8, samIoU: 0.5, sizeGap: 0.35 } as const;
/** Padding around a group's drawing for `{ around }`, as a share of its size on each side. */
export const AROUND_PAD = 0.1;

/**
 * What is selected: a box or a polygon in thousandths of the frame, or a
 * box around how the room's calibrated camera draws a group (`'desk'`) or a
 * fixture (`'fixture:<id>'`), padded by `pad` (a share of its size on each
 * side). A negative `pad` boxes only part of it: -0.2 is its middle 60%.
 */
export type BrushSelect =
  | { box: { x1: number; y1: number; x2: number; y2: number } }
  | { polygon: { x: number; y: number }[] }
  | { around: string; pad?: number };

export interface BrushOptions {
  mode: Mode;
  select: BrushSelect;
  prompt: string;
  /** Follow-ups, each on the request before it, as typed in the same panel. */
  follow?: string[];
  /** Put the last model in the room (`/api/assist/save`). */
  save?: boolean;
  /** An app to call in process (tests pass their own); demo mode builds one when left out. */
  app?: FastifyInstance;
  /** That app's DATA_DIR, to read its runs' pictures. */
  appDataDir?: string;
  /** Live, with no `app`: the running server. */
  server?: string;
  /** Live: the frame the selection is drawn on; else a snapshot of the saved camera. */
  frame?: Buffer;
}
export interface BrushTurn {
  prompt: string;
  /** The request's run: its draft, usage and assets. */
  run: EvidenceRun<AssistDraft>;
  /** Its job, with each step's state and detail (pictures left out). */
  steps: Job['steps'];
  /** What the request worked on: the selection's outline, as the run kept it. */
  outline: Bits | null;
}
export interface BrushResult {
  mode: Mode;
  shape: SelectionShape;
  frame: Buffer;
  /** What the panel shows on release (`/api/select/resolve`). */
  resolve: SelectResolve;
  turns: BrushTurn[];
  /** A request that failed, ending the turns: its status, error and how far its job got. */
  failed: { prompt: string; status: number; message: string; steps: Job['steps'] } | null;
  /** The group the model was saved as, or the thing a variant was kept on, with `save`. */
  saved: string | null;
  /** Whether the panel and every request name the same target. */
  agrees: boolean;
  /** The room as it was asked, to draw a turn's model through its camera. */
  room: ReturnType<typeof selectionRoom>;
}

/** One HTTP call to the lab, in process or over the network, answering its status and JSON. */
type Call = <T>(method: 'GET' | 'POST', url: string, payload?: object) => Promise<T>;
export class BrushError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`${url}: ${status} ${body.slice(0, 400)}`);
  }
}

/** The same target, or both none. */
export const sameTarget = (a: SelectionTarget | null, b: SelectionTarget | null) =>
  a?.kind === b?.kind && a?.id === b?.id;
export const targetName = (t: SelectionTarget | null) =>
  t ? `${t.label} (${t.kind} ${t.id})` : 'nothing the room has';

/** A box in thousandths, clamped to the frame. */
export function rectShape(box: { x1: number; y1: number; x2: number; y2: number }): SelectionShape {
  const c = (v: number) => Math.round(Math.min(1000, Math.max(0, v)));
  return { kind: 'rect', box: { x1: c(box.x1), y1: c(box.y1), x2: c(box.x2), y2: c(box.y2) } };
}
/** A mask's bounding box in pixels, or null when it is empty. */
export function maskBox(m: Bits) {
  let [x1, y1, x2, y2] = [Infinity, Infinity, -1, -1];
  for (let i = 0; i < m.data.length; i++)
    if (m.data[i]) {
      const x = i % m.width;
      const y = Math.floor(i / m.width);
      [x1, y1, x2, y2] = [Math.min(x1, x), Math.min(y1, y), Math.max(x2, x), Math.max(y2, y)];
    }
  return x2 < 0 ? null : { x1, y1, x2: x2 + 1, y2: y2 + 1 };
}
/** A pixel box as a selection in thousandths of `frame`, padded by `pad` of its size on each side. */
export function pixelShape(
  b: { x1: number; y1: number; x2: number; y2: number },
  frame: Segmentation['frame'],
  pad = 0,
): SelectionShape {
  const w = b.x2 - b.x1;
  const h = b.y2 - b.y1;
  return rectShape({
    x1: ((b.x1 - w * pad) / frame.width) * 1000,
    y1: ((b.y1 - h * pad) / frame.height) * 1000,
    x2: ((b.x2 + w * pad) / frame.width) * 1000,
    y2: ((b.y2 + h * pad) / frame.height) * 1000,
  });
}
/** How the room's camera draws a group or `fixture:<id>`, as a pixel box; null when it isn't seen. */
export function drawnBox(room: Pick<ReturnType<typeof selectionRoom>, 'picture'>, id: string) {
  return maskBox(roomMask(room.picture, id));
}
/** The selection a `BrushSelect` stands for, in the room it is drawn on. */
export function shapeOf(
  select: BrushSelect,
  room: Pick<ReturnType<typeof selectionRoom>, 'picture' | 'frame'>,
): SelectionShape {
  if ('box' in select) return rectShape(select.box);
  if ('polygon' in select) return { kind: 'polygon', points: select.polygon };
  const b = drawnBox(room, select.around);
  if (!b) {
    throw new Error(
      `The room's camera doesn't see "${select.around}". It sees: ${seenIn(room).join(', ')}.`,
    );
  }
  return pixelShape(b, room.frame, select.pad ?? AROUND_PAD);
}

/** The demo room as its camera sees it, for selections in tests and scripts. */
export const demoRoom = () => selectionRoom({ mode: 'demo', lastDecision: null });
/** The groups and fixtures a room's camera sees, front to back as named. */
export const seenIn = (room: Pick<ReturnType<typeof selectionRoom>, 'picture'>) =>
  room.picture.names.filter((n) => n !== 'floor' && !n.startsWith('wall'));

/** A lab app in process with a throwaway DATA_DIR, for demo mode; `close` removes it. */
export async function demoApp() {
  const dir = mkdtempSync(join(tmpdir(), 'livinglayer-brush-'));
  const app = await buildApp(parseConfig({ DATA_DIR: dir }), { serveWeb: false });
  return {
    app,
    dir,
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function caller(app: FastifyInstance | undefined, server: string): Call {
  return async <T>(method: 'GET' | 'POST', url: string, payload?: object) => {
    let status: number;
    let body: string;
    if (app) {
      const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      [status, body] = [res.statusCode, res.body];
    } else {
      const res = await fetch(`${server}${url}`, {
        method,
        ...(payload
          ? { body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }
          : {}),
      });
      [status, body] = [res.status, await res.text()];
    }
    if (status >= 400) throw new BrushError(status, body, url);
    return JSON.parse(body) as T;
  };
}

/** A snapshot of the camera the live room is calibrated on: the first saved stream that has one. */
export async function liveSnapshot(call: Call, server: string): Promise<Buffer> {
  const { streams } = await call<{ streams: { name: string; snapshot?: string }[] }>(
    'GET',
    '/api/streams',
  );
  const stream = streams.find((s) => s.snapshot);
  if (!stream) throw new Error('No saved camera with a snapshot: add one in Setup.');
  const res = await fetch(`${server}${stream.snapshot}`);
  if (!res.ok) throw new Error(`${stream.name}: snapshot ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Send one brush request, its follow-ups, and optionally save, as the panel
 * does: resolve the selection, then `/api/assist` with a job id, reading the
 * job's steps once it ends.
 */
export async function runBrush(options: BrushOptions): Promise<BrushResult> {
  const { mode } = options;
  const own = !options.app && mode === 'demo' ? await demoApp() : null;
  const app = options.app ?? own?.app;
  const server = options.server ?? LIVE_SERVER;
  const call = caller(app, server);
  const assetsDir = options.appDataDir ?? own?.dir ?? (app ? null : dataDir());
  const asset = (path: string) => {
    if (!assetsDir) return null;
    try {
      return readFileSync(join(assetsDir, 'evidence', path));
    } catch {
      return null;
    }
  };
  try {
    const memory = await call<DeskMemory>('GET', `/api/desk/${mode}`);
    const room = selectionRoom(memory);
    const shape = shapeOf(options.select, room);
    const frame =
      mode === 'demo' ? await demoPng() : (options.frame ?? (await liveSnapshot(call, server)));
    const imageDataUrl =
      mode === 'live' ? `data:image/png;base64,${frame.toString('base64')}` : null;
    const resolve = await call<SelectResolve>('POST', '/api/select/resolve', { mode, shape });

    const turns: BrushTurn[] = [];
    let failed: BrushResult['failed'] = null;
    const stepsOf = async (jobId: string) =>
      ((await call<Job>('GET', `/api/jobs/${jobId}`).catch(() => null))?.steps ?? []).map(
        ({ image: _image, ...s }) => s,
      );
    for (const [i, prompt] of [options.prompt, ...(options.follow ?? [])].entries()) {
      const jobId = crypto.randomUUID();
      const previous = turns.at(-1)?.run.id;
      let run: EvidenceRun<AssistDraft>;
      try {
        run = await call<EvidenceRun<AssistDraft>>('POST', '/api/assist', {
          mode,
          prompt,
          jobId,
          ...(i === 0 ? { shape, ...(imageDataUrl ? { imageDataUrl } : {}) } : { previous }),
        });
      } catch (e) {
        // A request that fails ends the turns; its job says how far it got.
        if (!(e instanceof BrushError)) throw e;
        failed = { prompt, status: e.status, message: e.body, steps: await stepsOf(jobId) };
        break;
      }
      const outlinePng = asset(`${run.id}/outline.png`);
      turns.push({
        prompt,
        run,
        steps: await stepsOf(jobId),
        outline: outlinePng ? await pngMask(outlinePng) : null,
      });
    }
    let saved: string | null = null;
    const last = turns.at(-1);
    if (options.save && !failed && (last?.run.output.recipe || last?.run.output.variant)) {
      const kept = await call<{ group?: string; thing?: string }>('POST', '/api/assist/save', {
        mode,
        runId: last.run.id,
      });
      saved = kept.group ?? kept.thing ?? null;
    }
    return {
      mode,
      shape,
      frame,
      resolve,
      turns,
      saved,
      failed,
      agrees: turns.every((t) => sameTarget(t.run.output.target, resolve.target)),
      room,
    };
  } finally {
    await own?.close();
  }
}

const TINT = {
  selection: [255, 221, 51],
  outline: [64, 200, 255],
  model: [255, 80, 200],
} as const;
/**
 * The frame with the selection's edge (yellow), what the request outlined
 * (blue, tinted), and the turn's model drawn in place through the room's
 * camera in its own colours (pink edge).
 */
export async function brushOverlay(result: BrushResult, turn = result.turns.at(-1)) {
  const { room, frame } = result;
  const { width, height } = room.frame;
  const base = await sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (base.info.width !== width || base.info.height !== height)
    throw new Error(
      `The frame is ${base.info.width} × ${base.info.height}, the camera's ${width} × ${height}.`,
    );
  const px = base.data;
  const paint = (m: Bits | null, tint: readonly number[], fill: number) => {
    if (!m) return;
    for (let i = 0; i < m.data.length; i++) {
      if (!m.data[i]) continue;
      const edge = [1, -1, width, -width].some((d) => !m.data[i + d]);
      const a = edge ? 1 : fill;
      for (let k = 0; k < 3; k++) px[i * 4 + k] = px[i * 4 + k]! * (1 - a) + tint[k]! * a;
    }
  };
  const draft = turn?.run.output;
  if (draft?.recipe && draft.place) {
    const scene = sceneWithRecipe(room.scene, draft.recipe, draft.place);
    const solids = [floorSolid(scene.grid), ...sceneSolids(scene)];
    const model = roomMask(renderRoom(room.camera, solids, { labels: true }), 'candidate');
    // The model as the room draws it (labels come without colours), then its edge.
    const { rgba } = renderRoom(room.camera, solids);
    for (let i = 0; i < model.data.length; i++)
      if (model.data[i]) for (let k = 0; k < 3; k++) px[i * 4 + k] = rgba[i * 4 + k]!;
    paint(model, TINT.model, 0);
  }
  paint(turn?.outline ?? null, TINT.outline, 0.25);
  // The selection's edge only.
  paint(selectionMask(result.shape, room.frame), TINT.selection, 0);
  return sharp(px, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}
