import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import {
  ILLUSTRATION_PROMPT,
  deskIllustrationPrompt,
  META_PRICES,
  MAX_SPRITES,
  alignCorners,
  fixtureBox,
  inRoomView,
  fixtureInPicture,
  pictureLayerRef,
  sparkCeiling,
  isoSurface,
  modeSchema,
  pictureDesk,
  type DeskMemory,
  type Detection,
  type EvidenceRun,
  type Mode,
  type PictureFind,
  type PictureSprite,
  type Quad,
  type SceneIllustration,
  type Segmentation,
} from '@livinglayer/domain';
import { PROJECT_ROOT } from './config.js';
import { LabError, parseInput } from './errors.js';
import { validateImage } from './images.js';
import type { Runner } from './item.js';
import {
  basePrompt,
  cutSprite,
  fillLocally,
  hullDetection,
  keyBackground,
  liftedMask,
  onBlack,
  outlineFits,
} from './layers.js';
import { roomPhotoBytes } from './fixture.js';
import { jobs, stoppedError, type JobTracker } from './jobs.js';
import { SPARK_BUDGET, type MetaAdapter } from './meta.js';
import type { EvidenceStore } from './store.js';

/**
 * The illustrated demo desk as Muse Image redrew it, and where SAM found its
 * top, so demo mode shows a picture without any model call.
 */
const DEMO_PICTURE = resolve(PROJECT_ROOT, 'apps/server/assets/demo-illustration.webp');
/** The top's corners, as shares of the picture's width and height, in the order the demo pin's corners take. */
export const DEMO_PICTURE_DESK: Quad = [
  { x: 0.0505, y: 0.639 },
  { x: 0.668, y: 0.293 },
  { x: 0.949, y: 0.517 },
  { x: 0.311, y: 0.879 },
];
/** The illustrated desk redrawn close up in the demo picture's style; it keeps the demo frame's composition. */
const DEMO_DESK_PICTURE = resolve(PROJECT_ROOT, 'apps/server/assets/demo-desk-illustration.webp');
const DEMO_FRAME = { width: 960, height: 640 };
/** What drawing the room reports while it runs, and how big its previews are. */
const ROOM_STEPS = [
  { id: 'photo', label: 'Send the photo' },
  { id: 'draw', label: 'Muse Image redraws the room' },
  { id: 'outline', label: 'SAM outlines the desk' },
  { id: 'save', label: 'Tie the picture to the pinned desk' },
];
const DESK_STEPS = [
  { id: 'photo', label: 'Send the close frame' },
  { id: 'draw', label: 'Muse Image redraws the desk' },
  { id: 'save', label: 'Save the desk picture' },
];
const PREVIEW = 640;
/** The picture with the desk top found on it outlined, for the page to show. */
async function withDesk(png: Buffer, desk: Quad, frame: { width: number; height: number }) {
  const points = desk.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const stroke = Math.max(2, Math.round(Math.max(frame.width, frame.height) / 240));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}"><polygon points="${points}" fill="rgb(111 211 224 / 0.18)" stroke="#6fd3e0" stroke-width="${stroke}" stroke-linejoin="round"/></svg>`;
  return sharp(png)
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
}
/** Run a job's steps; a stop ends it with a plain message, a failure shows on the step that failed. */
async function following<T>(job: JobTracker, steps: () => Promise<T>): Promise<T> {
  try {
    const result = await steps();
    job.check();
    return result;
  } catch (error) {
    if (job.stopped) throw stoppedError();
    job.fail(error instanceof Error ? error.message : 'Drawing failed.');
    throw error;
  }
}
const areaOf = (d: Detection) =>
  (d.mask.foregroundPixels * d.box.width * d.box.height) / (d.mask.width * d.mask.height);

export interface Illustrated {
  /** The picture's run, and the SAM run that outlined its desk (live only). */
  run: EvidenceRun<{ illustration: SceneIllustration }>;
  segment: EvidenceRun<Segmentation> | null;
  illustration: SceneIllustration;
  memory: DeskMemory;
}

/**
 * Draw a person's room as a clean isometric picture. Muse Image redraws the
 * photo (one image, $0.01), SAM outlines the desk in the picture (one call),
 * and the surface fitter finds its top, which is tied to the pinned surface so
 * the mug and the zones can be drawn on the picture. The scene and its pin
 * stay what they were; the picture is how the room is shown.
 */
export function illustrationRoutes(
  app: FastifyInstance,
  { store, meta, run }: { store: EvidenceStore; meta: MetaAdapter; run: Runner },
) {
  app.post('/api/scene/illustrate', async (request): Promise<Illustrated> => {
    const input = parseInput(
      z
        .object({
          mode: modeSchema,
          imageDataUrl: z.string().max(7_000_000).optional(),
          /** The room, from its photo; or its desk, from a close camera frame. */
          view: z.enum(['room', 'desk']).default('room'),
          /** Report the steps under this id while the call runs, so the page can follow and stop it. */
          jobId: z.string().uuid().optional(),
        })
        .strict(),
      request.body,
    );
    const { mode, view } = input;
    const live = mode === 'live';
    if (!live && input.imageDataUrl)
      throw new LabError('demo_image', 'Demo mode uses only the bundled illustrated desk.');
    const memory = store.memory(mode);
    const pin = memory.surface;
    if (
      !memory.scene ||
      !pin ||
      pin.scene !== 'custom' ||
      !isoSurface('custom', pin.surfaceId, memory.scene)
    )
      throw new LabError(
        'illustration_pin',
        'Draft your room from a photo and pin its desk first: the picture is tied to the pinned desk.',
        409,
      );
    if (view === 'desk') return drawDesk(input.imageDataUrl, mode, pin.surfaceId, input.jobId);
    if (live && !meta.canAfford(META_PRICES.imagePerImage + META_PRICES.samPerImage))
      throw new LabError(
        'spend_limit',
        "Drawing the room would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.",
        429,
      );
    const job = jobs.start(input.jobId, ROOM_STEPS, { title: 'Drawing the room', mode });
    return following(job, async () => {
      // Live, the room is drawn from the photo sent, else from the room's own photo.
      job.run('photo');
      const saved = live && !input.imageDataUrl ? roomPhotoBytes(memory, store) : null;
      const image = live
        ? await validateImage(
            input.imageDataUrl ??
              (saved ? `data:image/png;base64,${saved.toString('base64')}` : undefined),
          )
        : null;
      if (image) await job.done('photo', `${image.width} × ${image.height}`, image.bytes, PREVIEW);
      else await job.done('photo', 'Demo: the bundled picture, no model call');
      job.check();

      // 1. The picture, its plain background made transparent.
      job.run('draw');
      let png: Buffer = Buffer.alloc(0);
      const drawn = await run('illustration', mode, async (id) => {
        job.link(id);
        const result = image
          ? await meta.illustrate([image.dataUrl], ILLUSTRATION_PROMPT, 'auto', job.signal)
          : { output: readFileSync(DEMO_PICTURE), model: 'demo', requestId: null, usage: null };
        job.check();
        png = await keyBackground(await sharp(result.output).png().toBuffer());
        const asset = store.asset(id, 'illustration.png', png);
        return {
          ...result,
          output: { asset },
          assets: [asset, ...(image ? [store.asset(id, 'source.png', image.bytes)] : [])],
        };
      });
      const asset = (drawn.output as { asset: string }).asset;
      const size = await sharp(png).metadata();
      const frame = { width: size.width!, height: size.height! };
      await job.done('draw', `${frame.width} × ${frame.height}`, png, PREVIEW);
      job.check();

      // 2. Its desk top, tied to the pin.
      job.run('outline');
      let segment: EvidenceRun<Segmentation> | null = null;
      let desk: Quad | null;
      if (!live)
        desk = DEMO_PICTURE_DESK.map((p) => ({
          x: p.x * frame.width,
          y: p.y * frame.height,
        })) as Quad;
      else {
        const dataUrl = await onBlack(png);
        segment = (await run('segment', mode, async (id) => {
          job.link(id);
          const result = await meta.segment(dataUrl, 'desk', frame.width, frame.height, {
            signal: job.signal,
          });
          return { ...result, assets: [store.asset(id, 'sam-output.txt', result.raw)] };
        })) as EvidenceRun<Segmentation>;
        const top = [...(segment.output.detections ?? [])].sort((a, b) => areaOf(b) - areaOf(a))[0];
        const found = top ? pictureDesk(top, frame) : null;
        desk = found && alignCorners(found, pin.corners);
      }
      if (desk)
        await job.done('outline', 'Found its top', await withDesk(png, desk, frame), PREVIEW);
      else await job.done('outline', 'No desk found on the picture');
      // Past here nothing more is spent; a stop still keeps the old picture.
      job.check();

      job.run('save');
      const illustration: SceneIllustration = {
        asset,
        frame,
        surfaceId: pin.surfaceId,
        desk,
        createdAt: new Date().toISOString(),
      };
      store.saveMemory({ ...store.memory(mode), illustration });
      await job.done('save', desk ? 'The mug and zones sit on its desk' : 'Saved without a desk');
      job.finish();
      return {
        memory: store.memory(mode),
        run: { ...drawn, output: { illustration } } as EvidenceRun<{
          illustration: SceneIllustration;
        }>,
        segment,
        illustration,
      };
    });
  });
  /**
   * The desk close up: a close camera frame redrawn by Muse Image (one image,
   * $0.01) in the room picture's style when there is one, shaped like the
   * frame and keeping its composition. What the camera tracks in frames of
   * that size maps onto it by scale, so it needs no SAM call.
   */
  async function drawDesk(
    imageDataUrl: string | undefined,
    mode: Mode,
    surfaceId: string,
    jobId?: string,
  ): Promise<Illustrated> {
    const live = mode === 'live';
    if (live && !meta.canAfford(META_PRICES.imagePerImage))
      throw new LabError(
        'spend_limit',
        "Drawing the desk would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.",
        429,
      );
    const job = jobs.start(jobId, DESK_STEPS, { title: 'Drawing the desk', mode });
    return following(job, async () => {
      job.run('photo');
      const image = live ? await validateImage(imageDataUrl) : null;
      if (image) await job.done('photo', `${image.width} × ${image.height}`, image.bytes, PREVIEW);
      else await job.done('photo', 'Demo: the bundled desk, no model call');
      job.check();
      const room = store.memory(mode).illustration;
      const style = room ? store.readAsset(room.asset) : null;
      job.run('draw', style ? 'In the room picture’s style' : undefined);
      let png: Buffer = Buffer.alloc(0);
      const drawn = await run('illustration', mode, async (id) => {
        job.link(id);
        const references = style
          ? [
              `data:image/jpeg;base64,${(await sharp(style).resize(1280, 1280, { fit: 'inside' }).jpeg().toBuffer()).toString('base64')}`,
            ]
          : [];
        const result = image
          ? await meta.illustrate(
              [image.dataUrl, ...references],
              deskIllustrationPrompt(Boolean(style)),
              `${image.width}x${image.height}`,
              job.signal,
            )
          : {
              output: readFileSync(DEMO_DESK_PICTURE),
              model: 'demo',
              requestId: null,
              usage: null,
            };
        job.check();
        png = await keyBackground(await sharp(result.output).png().toBuffer());
        const asset = store.asset(id, 'illustration.png', png);
        return {
          ...result,
          output: { asset },
          assets: [asset, ...(image ? [store.asset(id, 'source.png', image.bytes)] : [])],
        };
      });
      const size = await sharp(png).metadata();
      await job.done('draw', `${size.width} × ${size.height}`, png, PREVIEW);
      job.check();
      job.run('save');
      const illustration: SceneIllustration = {
        asset: (drawn.output as { asset: string }).asset,
        frame: { width: size.width!, height: size.height! },
        surfaceId,
        desk: null,
        drawnFrom: image ? { width: image.width, height: image.height } : DEMO_FRAME,
        createdAt: new Date().toISOString(),
      };
      store.saveMemory({ ...store.memory(mode), deskIllustration: illustration });
      await job.done('save', 'Sightings in frames this size show on it');
      job.finish();
      return {
        memory: store.memory(mode),
        run: { ...drawn, output: { illustration } } as EvidenceRun<{
          illustration: SceneIllustration;
        }>,
        segment: null,
        illustration,
      };
    });
  }
  /**
   * Lift the room's fixtures off its picture, so they can be moved on it.
   * SAM outlines each where its box shows (one call, live; the demo uses the
   * box's silhouette), and each is cut out as a sprite. The base they are
   * drawn over is the picture redrawn by Muse Image with only its furniture
   * (one image, $0.01), its background made transparent like the picture's;
   * the demo fills the places they leave from around them instead.
   */
  app.post('/api/scene/separate', async (request) => {
    const { mode } = parseInput(z.object({ mode: modeSchema }).strict(), request.body);
    const live = mode === 'live';
    const memory = store.memory(mode);
    const picture = memory.illustration;
    const pin = memory.surface;
    if (!picture?.desk || picture.drawnFrom || !pin)
      throw new LabError(
        'separate_picture',
        'Draw the room as a picture first, with its desk found: the fixtures are lifted off it.',
        409,
      );
    const custom = memory.scene ?? null;
    const wanted = (memory.fixtures ?? [])
      .filter((f) => f.scene === pin.scene)
      .flatMap((f) => {
        // The room's picture shows each where the room's own view puts it.
        const box = fixtureBox(inRoomView(f), custom);
        const at = fixtureInPicture(pin, picture, custom, box);
        return at ? [{ f, size: { w: box.size.w, d: box.size.d }, ...at }] : [];
      })
      .slice(0, MAX_SPRITES);
    if (!wanted.length)
      throw new LabError(
        'separate_none',
        'No fixture of this room shows on its picture. Scan or add fixtures first.',
        409,
      );
    if (
      live &&
      !meta.canAfford(
        sparkCeiling(SPARK_BUDGET.pictureFind, 1) +
          META_PRICES.samPerImage +
          META_PRICES.imagePerImage,
      )
    )
      throw new LabError(
        'spend_limit',
        "Lifting the fixtures would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.",
        429,
      );
    const png = store.readAsset(picture.asset);
    if (!png) throw new LabError('illustration_missing', 'This picture is gone.', 404);
    const { width, height } = picture.frame;
    // The models read the picture on the black it was drawn on.
    const dataUrl = await onBlack(png);

    // 1. Where each fixture is drawn. Live, Spark finds it by name, near where the layout
    // expects it; in the demo, the layout's box is taken as it is.
    let finder: EvidenceRun<PictureFind> | null = null;
    let where: ({ x: number; y: number; width: number; height: number } | null)[] = wanted.map(
      (w) => w.box,
    );
    if (live) {
      const k = (v: number, of: number) => Math.round(Math.min(1000, Math.max(0, (v / of) * 1000)));
      finder = (await run('fixture', mode, async () =>
        meta.pictureFind(
          dataUrl,
          wanted.map((w) => ({
            label: w.f.label,
            near: {
              x1: k(w.box.x, width),
              y1: k(w.box.y, height),
              x2: k(w.box.x + w.box.width, width),
              y2: k(w.box.y + w.box.height, height),
            },
          })),
        ),
      )) as EvidenceRun<PictureFind>;
      const answers = finder.output.found;
      where = wanted.map((_, i) => {
        const a = answers.find((x) => x.index === i + 1);
        if (!a?.seen || a.box.x2 <= a.box.x1 || a.box.y2 <= a.box.y1) return null;
        return {
          x: (a.box.x1 / 1000) * width,
          y: (a.box.y1 / 1000) * height,
          width: ((a.box.x2 - a.box.x1) / 1000) * width,
          height: ((a.box.y2 - a.box.y1) / 1000) * height,
        };
      });
    }

    // 2. Each one's outline: SAM inside where it was found (live), or its box's silhouette in
    // the demo. An outline that doesn't fit what was found isn't lifted.
    let segment: EvidenceRun<Segmentation> | null = null;
    let outlines: (Detection | null)[] = wanted.map((w) => hullDetection(w.corners, w.f.id));
    if (live) {
      const asked = where.flatMap((b, i) => (b ? [{ i, b }] : []));
      outlines = wanted.map(() => null);
      if (asked.length) {
        // A little room around Spark's box, so SAM sees the thing's whole edge.
        const pad = (b: { x: number; y: number; width: number; height: number }) => {
          const p = 0.06 * Math.max(b.width, b.height);
          return {
            left: Math.max(0, Math.floor(b.x - p)),
            top: Math.max(0, Math.floor(b.y - p)),
            right: Math.min(width, Math.ceil(b.x + b.width + p)),
            bottom: Math.min(height, Math.ceil(b.y + b.height + p)),
          };
        };
        segment = (await run('segment', mode, async (id) => {
          const result = await meta.segmentBoxes(
            dataUrl,
            asked.map(({ i, b }) => ({ id: i + 1, box: pad(b) })),
            width,
            height,
          );
          return { ...result, assets: [store.asset(id, 'sam-output.txt', result.raw)] };
        })) as EvidenceRun<Segmentation>;
        const detections = segment.output.detections ?? [];
        for (const { i, b } of asked) {
          const best = [...detections.filter((d) => d.objectId === String(i + 1))].sort(
            (x, y) => y.mask.foregroundPixels - x.mask.foregroundPixels,
          )[0];
          outlines[i] = best && outlineFits(best, b) ? best : null;
        }
      }
    }
    const skipped = wanted.filter((_, i) => !outlines[i]).map((w) => w.f.label);

    // 3. The sprites, and the base they are drawn over.
    const sprites: PictureSprite[] = [];
    const lifted: Detection[] = [];
    const drawn = await run('illustration', mode, async (id) => {
      const assets: string[] = [];
      for (const [i, w] of wanted.entries()) {
        const outline = outlines[i];
        if (!outline) continue;
        const cut = await cutSprite(png, outline).catch(() => null);
        if (!cut) continue;
        const asset = store.asset(id, `sprite-${i + 1}.png`, cut.png);
        assets.push(asset);
        lifted.push(outline);
        sprites.push({
          fixtureId: w.f.id,
          asset,
          box: { x: cut.left, y: cut.top, width: cut.width, height: cut.height },
          anchor: w.anchor,
          size: w.size,
        });
      }
      if (!sprites.length)
        throw new LabError(
          'separate_none',
          'None of the fixtures could be outlined cleanly on the picture, so nothing was lifted.',
        );
      // Live, the base is the picture redrawn with only its furniture: one whole drawing, so
      // nothing is patched. The demo has no model, so it fills the places from around them.
      const result = live
        ? await meta.illustrate(
            [dataUrl],
            basePrompt(wanted.map((w) => w.f.label)),
            `${width}x${height}`,
          )
        : null;
      const base = result
        ? await keyBackground(
            await sharp(result.output).resize(width, height, { fit: 'fill' }).png().toBuffer(),
          )
        : await fillLocally(png, await liftedMask(lifted, width, height), width, height);
      const asset = store.asset(id, 'base.png', base);
      return {
        ...(result ?? { model: 'demo', requestId: null, usage: null }),
        output: { base: asset, sprites: sprites.length, skipped },
        assets: [asset, ...assets],
      };
    });
    const layers = {
      base: (drawn.output as { base: string }).base,
      sprites,
      createdAt: new Date().toISOString(),
    };
    store.saveMemory({ ...store.memory(mode), illustration: { ...picture, layers } });
    return {
      memory: store.memory(mode),
      run: drawn,
      finder,
      segment,
      lifted: sprites.length,
      skipped,
    };
  });
  /** Put the fixtures back into the picture: it is shown whole again. */
  app.post('/api/scene/separate/undo', async (request) => {
    const { mode } = parseInput(z.object({ mode: modeSchema }).strict(), request.body);
    const memory = store.memory(mode);
    if (memory.illustration?.layers) {
      const { layers: _, ...whole } = memory.illustration;
      store.saveMemory({ ...memory, illustration: whole });
    }
    return { memory: store.memory(mode) };
  });
  /** A room's picture, or one of its layers. */
  app.get('/api/scene/illustration', async (request, reply) => {
    const { asset } = parseInput(z.object({ asset: pictureLayerRef }).strict(), request.query);
    const png = store.readAsset(asset);
    if (!png) throw new LabError('illustration_missing', 'This picture is gone.', 404);
    return reply.type('image/png').header('cache-control', 'no-cache').send(png);
  });
}
