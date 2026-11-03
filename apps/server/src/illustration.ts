import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import {
  ILLUSTRATION_NOTE_MAX,
  ILLUSTRATION_PROMPT,
  deskIllustrationPrompt,
  withNote,
  META_PRICES,
  MAX_SPRITES,
  fixtureBox,
  inRoomView,
  fixtureInPicture,
  pictureLayerRef,
  sparkCeiling,
  isoSurface,
  modeSchema,
  calibrationOf,
  floorSolid,
  renderRoom,
  sceneSolids,
  type DeskMemory,
  type EvidenceRun,
  type Mode,
  type PictureFind,
  type PictureSprite,
  type SceneIllustration,
  type Detection,
  type IsoScene,
  type RoomCamera,
  type Segmentation,
} from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import { samDataUrl, validateImage } from './images.js';
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
import { following, type Jobs } from './jobs.js';
import { listedPreview, outlinedPreview } from './scan-preview.js';
import { SPARK_BUDGET, type MetaAdapter } from './meta.js';
import type { EvidenceStore } from './store.js';

/** What drawing the room reports while it runs, and how big its previews are. */
const ROOM_STEPS = [
  { id: 'photo', label: 'Send the photo' },
  { id: 'draw', label: 'Muse Image redraws the room' },
  { id: 'save', label: 'Tie the picture to the room’s camera' },
];
const DESK_STEPS = [
  { id: 'photo', label: 'Send the close frame' },
  { id: 'draw', label: 'Muse Image redraws the desk' },
  { id: 'save', label: 'Save the desk picture' },
];
const PREVIEW = 640;
const LIFT_STEPS = [
  { id: 'find', label: 'Spark finds each fixture on the picture' },
  { id: 'outline', label: 'SAM outlines each one' },
  { id: 'cut', label: 'Cut each one out' },
  { id: 'base', label: 'Muse Image redraws the room without them' },
  { id: 'save', label: 'Save the layers' },
];
/** The room as its camera sees it, drawn from the scene: the demo's picture of it. */
async function roomPicture(scene: IsoScene, camera: RoomCamera) {
  const { width, height, rgba } = renderRoom(camera, [
    floorSolid(scene.grid),
    ...sceneSolids(scene),
  ]);
  return sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

export interface Illustrated {
  /** The picture's run; `segment` is always null now, kept for the page. */
  run: EvidenceRun<{ illustration: SceneIllustration }>;
  segment: EvidenceRun<Segmentation> | null;
  illustration: SceneIllustration;
  memory: DeskMemory;
}

/**
 * Draw a person's room as a clean picture. Muse Image redraws a frame of the
 * room's calibrated corner camera (one image, $0.01), keeping its framing, so
 * the room's camera maps the scene, the mug and the zones onto it with no
 * other call. The demo draws its saved room through the demo camera instead.
 * The scene and its pin stay what they were; the picture is how the room is
 * shown.
 */
export function illustrationRoutes(
  app: FastifyInstance,
  { store, meta, run, jobs }: { store: EvidenceStore; meta: MetaAdapter; run: Runner; jobs: Jobs },
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
          /** What to change this time, added to the prompt. */
          note: z.string().trim().max(ILLUSTRATION_NOTE_MAX).optional(),
        })
        .strict(),
      request.body,
    );
    const { mode, view } = input;
    const live = mode === 'live';
    if (!live && input.imageDataUrl)
      throw new LabError('demo_image', 'Demo mode uses only the demo room’s camera.');
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
    if (view === 'desk') {
      if (!live)
        throw new LabError(
          'demo_image',
          'The demo has only its corner camera: draw the room as a picture instead.',
        );
      return drawDesk(input.imageDataUrl, mode, pin.surfaceId, input.jobId, input.note);
    }
    const calibration = calibrationOf(memory);
    if (!calibration)
      throw new LabError(
        'not_calibrated',
        'Calibrate the room’s corner camera first: the picture redraws one of its frames.',
        409,
      );
    const from = calibration.camera.frame;
    if (pin.frame.width !== from.width || pin.frame.height !== from.height)
      throw new LabError(
        'illustration_pin',
        'The desk was pinned on frames of another size than the room’s camera: pin it again.',
        409,
      );
    if (live && !meta.canAfford(META_PRICES.imagePerImage))
      throw new LabError(
        'spend_limit',
        "Drawing the room would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.",
        429,
      );
    const job = jobs.start(input.jobId, ROOM_STEPS, { title: 'Drawing the room', mode });
    return following(job, async () => {
      // Live, the room is drawn from the frame sent, else from the room's own photo.
      job.run('photo');
      const saved = live && !input.imageDataUrl ? roomPhotoBytes(memory, store) : null;
      const image = live
        ? await validateImage(
            input.imageDataUrl ??
              (saved ? `data:image/png;base64,${saved.toString('base64')}` : undefined),
          )
        : null;
      if (image && (image.width !== from.width || image.height !== from.height))
        throw new LabError(
          'not_calibrated',
          `This frame is ${image.width} × ${image.height}, but the room’s camera was calibrated on ${from.width} × ${from.height} frames.`,
          409,
        );
      if (image) await job.done('photo', `${image.width} × ${image.height}`, image.bytes, PREVIEW);
      else await job.done('photo', 'Demo: the saved room through the demo camera, no model call');
      job.check();

      // The picture, its plain background made transparent, the frame's size and framing.
      job.run('draw');
      let png: Buffer = Buffer.alloc(0);
      const drawn = await run('illustration', mode, async (id) => {
        job.link(id);
        const result = image
          ? await meta.illustrate(
              [await samDataUrl(image)],
              withNote(ILLUSTRATION_PROMPT, input.note),
              `${image.width}x${image.height}`,
              job.signal,
            )
          : {
              output: await roomPicture(memory.scene!, calibration.camera),
              model: 'demo',
              requestId: null,
              usage: null,
            };
        job.check();
        png = await keyBackground(
          await sharp(result.output)
            .resize(from.width, from.height, { fit: 'fill' })
            .png()
            .toBuffer(),
        );
        const asset = store.asset(id, 'illustration.png', png);
        return {
          ...result,
          output: { asset },
          assets: [asset, ...(image ? [store.asset(id, `source.${image.ext}`, image.bytes)] : [])],
        };
      });
      const asset = (drawn.output as { asset: string }).asset;
      await job.done('draw', `${from.width} × ${from.height}`, png, PREVIEW);
      // Past here nothing more is spent; a stop still keeps the old picture.
      job.check();

      job.run('save');
      const illustration: SceneIllustration = {
        asset,
        frame: { ...from },
        surfaceId: pin.surfaceId,
        desk: null,
        drawnFrom: { ...from },
        createdAt: new Date().toISOString(),
      };
      store.saveMemory({ ...store.memory(mode), illustration });
      await job.done('save', 'The mug and zones show on it through the room’s camera');
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
    note?: string,
  ): Promise<Illustrated> {
    if (!meta.canAfford(META_PRICES.imagePerImage))
      throw new LabError(
        'spend_limit',
        "Drawing the desk would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.",
        429,
      );
    const job = jobs.start(jobId, DESK_STEPS, { title: 'Drawing the desk', mode });
    return following(job, async () => {
      job.run('photo');
      const image = await validateImage(imageDataUrl);
      await job.done('photo', `${image.width} × ${image.height}`, image.bytes, PREVIEW);
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
        const result = await meta.illustrate(
          [await samDataUrl(image), ...references],
          deskIllustrationPrompt(Boolean(style), note),
          `${image.width}x${image.height}`,
          job.signal,
        );
        job.check();
        png = await keyBackground(await sharp(result.output).png().toBuffer());
        const asset = store.asset(id, 'illustration.png', png);
        return {
          ...result,
          output: { asset },
          assets: [asset, ...(image ? [store.asset(id, `source.${image.ext}`, image.bytes)] : [])],
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
        drawnFrom: { width: image.width, height: image.height },
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
    const { mode, jobId } = parseInput(
      z
        .object({
          mode: modeSchema,
          /** The page's id for following the steps as they go. */
          jobId: z.string().uuid().optional(),
        })
        .strict(),
      request.body,
    );
    const live = mode === 'live';
    const memory = store.memory(mode);
    const picture = memory.illustration;
    const pin = memory.surface;
    if (!picture?.drawnFrom || !pin)
      throw new LabError(
        'separate_picture',
        'Draw the room as a picture first: the fixtures are lifted off it.',
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
    const shown = await sharp(png).flatten({ background: '#0a0c12' }).png().toBuffer();
    const frame = { width, height };
    const labels = wanted.map((w) => w.f.label);
    const job = jobs.start(jobId, LIFT_STEPS, { title: 'Lifting the fixtures', mode });
    return following(job, async () => {
      job.run('find', live ? undefined : 'Demo: where the layout puts each one, no model call');

      // 1. Where each fixture is drawn. Live, Spark finds it by name, near where the layout
      // expects it; in the demo, the layout's box is taken as it is.
      let finder: EvidenceRun<PictureFind> | null = null;
      let where: ({ x: number; y: number; width: number; height: number } | null)[] = wanted.map(
        (w) => w.box,
      );
      if (live) {
        const k = (v: number, of: number) =>
          Math.round(Math.min(1000, Math.max(0, (v / of) * 1000)));
        finder = (await run('fixture', mode, async (id) => {
          job.link(id);
          return meta.pictureFind(
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
            job.signal,
          );
        })) as EvidenceRun<PictureFind>;
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

      job.check();
      const thousandths = (b: { x: number; y: number; width: number; height: number }) => ({
        x1: (b.x / width) * 1000,
        y1: (b.y / height) * 1000,
        x2: ((b.x + b.width) / width) * 1000,
        y2: ((b.y + b.height) / height) * 1000,
      });
      const found = where.filter(Boolean).length;
      await job.done(
        'find',
        `${found} of ${wanted.length} found on the picture`,
        await listedPreview(
          shown,
          frame,
          wanted.flatMap((w, i) => {
            const b = where[i];
            return b ? [{ label: w.f.label, box: thousandths(b) }] : [];
          }),
        ),
        PREVIEW,
      );
      job.run('outline', live ? undefined : 'Demo: each box’s silhouette, no model call');
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
            job.link(id);
            const result = await meta.segmentBoxes(
              dataUrl,
              asked.map(({ i, b }) => ({ id: i + 1, box: pad(b) })),
              width,
              height,
              job.signal,
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
      job.check();
      await job.done(
        'outline',
        `${wanted.length - skipped.length} of ${wanted.length} outlined cleanly${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}`,
        await outlinedPreview(shown, frame, labels, outlines),
        PREVIEW,
      );

      // 3. The sprites, and the base they are drawn over.
      const sprites: PictureSprite[] = [];
      const lifted: Detection[] = [];
      const drawn = await run('illustration', mode, async (id) => {
        job.link(id);
        job.run('cut');
        const assets: string[] = [];
        for (const [i, w] of wanted.entries()) {
          const outline = outlines[i];
          if (!outline) continue;
          const cut = await cutSprite(png, outline).catch(() => null);
          if (!cut) continue;
          job.run('cut', w.f.label);
          await job.show('cut', cut.png);
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
        await job.done('cut', `${sprites.length} cut out`);
        job.check();
        // Live, the base is the picture redrawn with only its furniture: one whole drawing, so
        // nothing is patched. The demo has no model, so it fills the places from around them.
        job.run('base', live ? undefined : 'Demo: filled from around them, no model call');
        const result = live
          ? await meta.illustrate(
              [dataUrl],
              basePrompt(wanted.map((w) => w.f.label)),
              `${width}x${height}`,
              job.signal,
            )
          : null;
        const base = result
          ? await keyBackground(
              await sharp(result.output).resize(width, height, { fit: 'fill' }).png().toBuffer(),
            )
          : await fillLocally(png, await liftedMask(lifted, width, height), width, height);
        const asset = store.asset(id, 'base.png', base);
        job.check();
        await job.done(
          'base',
          live ? 'Only the furniture, the fixtures left out' : 'The places they leave, filled',
          await sharp(base).flatten({ background: '#0a0c12' }).png().toBuffer(),
          PREVIEW,
        );
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
      job.check();
      job.run('save');
      store.saveMemory({ ...store.memory(mode), illustration: { ...picture, layers } });
      await job.done('save', 'Drag a fixture on the picture to move it');
      job.finish();
      return {
        memory: store.memory(mode),
        run: drawn,
        finder,
        segment,
        lifted: sprites.length,
        skipped,
      };
    });
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
