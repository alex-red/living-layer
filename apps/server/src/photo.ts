import type { FastifyInstance } from 'fastify';
import { renderRoomAsync } from './workers/compute.js';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  sceneFromPhotoBodySchema,
  sceneSetupBodySchema,
  DEMO_CALIBRATION,
  ISO_PRESETS,
  ISO_TILE_CM,
  type CameraCrop,
  type DeskMemory,
  type IsoScene,
  type RoomEstimate,
  type RoomMarks,
  cleanInventory,
  draftModel,
  type DraftModelSource,
  demoSourceKey,
  DEMO_FRAME,
  calibrationOf,
  floorSolid,
  layoutRoom,
  refineWalls,
  sceneSolids,
  thingSolids,
  type LayoutInput,
  type RoomCalibration,
  promptBox,
  sparkCeiling,
  META_PRICES,
  uniqueParts,
  type EvidenceRun,
  type Mode,
  type PhotoDraft,
  type PhotoInventory,
  type PhotoLayout,
  type SavedItem,
  type Segmentation,
  type Usage,
  type PhotoCheck,
  addUsage,
} from '@livinglayer/domain';
import type { Config } from './config.js';
import { LabError, liveImage, parseInput } from './errors.js';
import { demoPhotoCheck, demoPhotoInventory, demoPhotoSegmentation } from './demo.js';
import {
  maskedCrop,
  mediaTypeOf,
  samDataUrl,
  toDataUrl,
  requireFrame,
  validateImage,
  type ValidatedImage,
} from './images.js';
import { demoPhoto, type Runner } from './item.js';
import { SPARK_BUDGET, type MetaAdapter } from './meta.js';
import type { EvidenceStore } from './store.js';
import { following, type JobTracker, type Jobs } from './jobs.js';
import { calibrateRoom, findFloorMarks, fitRoom } from './room.js';
import { listedPreview, outlinedPreview } from './scan-preview.js';

/** The setup's steps: the draft's, with the room measured and the camera calibrated after the listing. */
const setupSteps = (check: boolean) => {
  const steps = draftSteps(check);
  steps.splice(
    1,
    1,
    { id: 'list', label: 'Spark lists the room and estimates its size' },
    { id: 'walls', label: 'SAM outlines the floor and the walls' },
    { id: 'calibrate', label: 'Fit the corner camera to the walls' },
  );
  return steps;
};
/** How wide a step's picture is kept, so it reads in the dialog. */
const PREVIEW = 640;
/** A photo draft's steps, as the page follows them; Spark's check only when asked for. */
const draftSteps = (check: boolean) => [
  { id: 'photo', label: 'Send the photo' },
  { id: 'list', label: 'Spark lists what is in the room' },
  { id: 'outline', label: 'SAM outlines each thing' },
  { id: 'layout', label: 'Measure the room from the outlines' },
  ...(check ? [{ id: 'check', label: 'Spark compares the drafted room with the photo' }] : []),
  { id: 'models', label: 'Choose a model for each thing' },
];
/**
 * The drafted room as the room's camera would see it, with what is drawn as a
 * model as well as the templates: what Spark compares with the photo.
 */
const renderLayout = (layout: PhotoLayout, calibration: RoomCalibration) =>
  renderScene(layout.scene, calibration, layout.things);
/** A scene drawn through the room's camera, as a PNG. */
async function renderScene(
  scene: IsoScene,
  calibration: RoomCalibration,
  things: PhotoLayout['things'] = [],
) {
  const picture = await renderRoomAsync(calibration.camera, [
    floorSolid(scene.grid),
    ...sceneSolids(scene),
    ...thingSolids(things.filter((t) => t.status === 'object')),
  ]);
  return sharp(Buffer.from(picture.rgba), {
    raw: { width: picture.width, height: picture.height, channels: 4 },
  })
    .png()
    .toBuffer();
}
type ThingBox = PhotoInventory['things'][number]['box'];
/** How much two boxes in the frame share: their overlap over their union. */
function boxOverlap(a: ThingBox, b: ThingBox) {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (w <= 0 || h <= 0) return 0;
  const area = (r: ThingBox) => (r.x2 - r.x1) * (r.y2 - r.y1);
  return (w * h) / (area(a) + area(b) - w * h);
}
/** Why a frame can't be scanned without the room's camera. */
export const NOT_CALIBRATED =
  'Calibrate the room’s corner camera first: a scan places everything through it.';

/** The most a live photo draft can cost: the inventory and SAM, then the check and SAM again. */
const photoDraftCeiling = (check: boolean) =>
  sparkCeiling(SPARK_BUDGET.photoInventory, 1) +
  META_PRICES.samPerImage +
  (check ? sparkCeiling(SPARK_BUDGET.photoCheck, 2) + META_PRICES.samPerImage : 0);
/** At most this many objects get a fitted model in one draft; the rest can be modelled later. */
export type { PhotoDraft };

/**
 * A scene from one frame of the room's calibrated corner camera. Spark lists
 * what is in it with loose boxes (one call), SAM outlines every box (one
 * call), and `layoutRoom` places each thing through the camera: where it
 * stands, its turn, and how well its drawing matches. Each object gets a
 * model from the local fitter. Spark may then look at the drawing beside the photo (one more call,
 * and one more SAM call for anything it says is missing). Nothing is saved to
 * desk memory until the person saves the review.
 */
export function photoRoutes(
  app: FastifyInstance,
  {
    store,
    meta,
    run,
    jobs,
  }: { store: EvidenceStore; meta: MetaAdapter; run: Runner; jobs: Jobs; config: Config },
) {
  /** Save the box-prompted segmentation as a segment run, like any other. */
  function saveSegment(
    mode: Mode,
    segmentation: Segmentation,
    photo: Buffer,
    raw: string | null,
    live: boolean,
  ): string {
    const sid = randomUUID();
    const segment: EvidenceRun<Segmentation> = {
      id: sid,
      kind: 'segment',
      mode,
      status: segmentation.detections.length ? 'completed' : 'no_match',
      createdAt: new Date().toISOString(),
      durationMs: 0,
      model: null,
      requestId: null,
      promptVersion: 'segment-boxes-v1',
      usage: null,
      output: {
        ...segmentation,
        sourceKey: live ? createHash('sha256').update(photo).digest('hex') : demoSourceKey(),
      },
      assets: live
        ? [
            store.asset(
              sid,
              `source.${mediaTypeOf(photo) === 'image/webp' ? 'webp' : 'png'}`,
              photo,
            ),
            store.asset(sid, 'sam-output.txt', raw ?? ''),
          ]
        : [store.asset(sid, 'synthetic-sam.txt', raw ?? '')],
    };
    store.save(segment);
    return sid;
  }
  /**
   * The rest of a draft once Spark has listed the frame: SAM outlines every
   * box, `layoutRoom` places each thing through the camera, Spark may check
   * the drawing, and each object gets a fitted model. Shared by the draft
   * and the room's setup, which calibrates the camera first.
   */
  async function draftThrough({
    job,
    id,
    mode,
    image,
    photo,
    frame,
    withCheck,
    inventory: listed,
    calibration: given,
    assists,
    assets,
    usage: spent,
  }: {
    job: JobTracker;
    id: string;
    mode: Mode;
    image: ValidatedImage | null;
    photo: Buffer;
    frame: { width: number; height: number };
    withCheck: boolean;
    inventory: PhotoInventory;
    calibration: RoomCalibration;
    assists: string[];
    assets: string[];
    usage: Usage | null;
  }): Promise<{ output: PhotoDraft; usage: Usage | null }> {
    const live = mode === 'live';
    let inventory = listed;
    let usage = spent;
    let calibration = given;
    const lay = (args: LayoutInput) => layoutRoom({ ...args, calibration });
    job.run('outline');

    // 2. One SAM call outlines every box.
    const prompts = inventory.things
      .map((t, i) => ({ thing: t.id, id: i + 1, box: promptBox(t, frame) }))
      .filter((p): p is typeof p & { box: NonNullable<typeof p.box> } => Boolean(p.box));
    let segmentation: Segmentation;
    let raw: string;
    if (image) {
      const result = await meta.segmentBoxes(
        await samDataUrl(image),
        prompts,
        frame.width,
        frame.height,
        job.signal,
      );
      // SAM bills per image through its own segment run, not by tokens here.
      segmentation = result.output;
      raw = result.raw;
    } else {
      segmentation = await demoPhotoSegmentation();
      raw = 'Synthetic box-prompted segmentation of the demo room’s render.';
    }
    const detections: Record<string, string> = {};
    for (const p of prompts)
      if (segmentation.detections.some((d) => d.objectId === String(p.id)))
        detections[p.thing] = String(p.id);
    assists.push(
      `SAM: ${Object.keys(detections).length} of ${inventory.things.length} outlined in one call`,
    );
    job.check();
    await job.done(
      'outline',
      `${Object.keys(detections).length} of ${inventory.things.length} outlined`,
      await outlinedPreview(
        photo,
        frame,
        prompts.map((p) => inventory.things.find((t) => t.id === p.thing)?.label ?? ''),
        prompts.map(
          (p) => segmentation.detections.find((d) => d.objectId === String(p.id)) ?? null,
        ),
      ),
      PREVIEW,
    );
    let segmentRunId = saveSegment(mode, segmentation, photo, image ? raw : null, live);

    // 3. Measure the scene from the masks. A wall whose floor line was hidden is
    // turned first to where the things standing against it say it is.
    job.run('layout');
    const refined = refineWalls({ inventory, segmentation, detections, calibration });
    if (refined) {
      calibration = { ...refined.calibration, calibratedAt: new Date().toISOString() };
      const { room, position } = calibration.camera;
      assists.push(
        `Turned the ${refined.wall === 'left' ? 'left' : 'right'} wall’s floor line ${Math.abs(refined.degrees)}° to the ${refined.witnesses.length} things standing behind it: the room is ${Math.round((room.w - 0.2) * ISO_TILE_CM)} × ${Math.round((room.d - 0.2) * ISO_TILE_CM)} cm, the camera ${Math.round(position[2] * ISO_TILE_CM)} cm up, off by ${calibration.error.toFixed(1)} px.`,
      );
    }
    let layout = lay({ inventory, segmentation, detections });
    assists.push(
      `Laid out through the calibrated room camera (fit ${calibration.error.toFixed(1)} px)`,
    );
    const drawn = await renderLayout(layout, calibration);
    await job.done(
      'layout',
      `${layout.things.filter((t) => t.status === 'placed').length} placed. ${refined ? `${assists.at(-2)} ` : ''}${assists.at(-1)}`,
      drawn ?? undefined,
      PREVIEW,
    );
    job.check();

    // 4. Spark looks at the drawing beside the photo.
    let check: PhotoDraft['check'] = null;
    let checkFailed = '';
    if (withCheck) job.run('check');
    if (withCheck) {
      assets.push(store.asset(id, 'scene-render.png', drawn));
      const listing = layout.things
        .filter((t) => t.status === 'placed' || t.status === 'object')
        .map((t) => `${t.id} (${t.label}, ${t.as})`)
        .join('; ');
      // The check only helps: when Spark fails at it, the draft goes on without it.
      let result: { output: PhotoCheck; usage: Usage | null } | null = null;
      try {
        result = image
          ? await meta.photoCheck(image.dataUrl, toDataUrl(drawn), listing, job.signal)
          : { output: demoPhotoCheck, usage: null };
      } catch (e) {
        // Stopped by the person: stop here, as any step does.
        job.check();
        checkFailed = e instanceof Error ? e.message : 'Spark’s check failed.';
        assists.push(`Spark check skipped: ${checkFailed}`);
      }
      if (result) {
        usage = addUsage(usage, result.usage);
        const added: string[] = [];
        let kept = false;
        const missing = cleanInventory({
          kind: inventory.kind,
          things: [...inventory.things, ...result.output.missing],
          summary: inventory.summary,
        })
          .things.slice(inventory.things.length)
          // Not what is listed already: the same kind of thing, its box over more than half of one listed.
          .filter(
            (m) => !inventory.things.some((t) => t.as === m.as && boxOverlap(t.box, m.box) > 0.5),
          );
        // Anything missing gets one more SAM call, only if today's spending limit has room.
        if (image && missing.length && meta.canAfford(META_PRICES.samPerImage)) {
          const more = missing
            .map((t, i) => ({
              thing: t.id,
              id: prompts.length + i + 1,
              box: promptBox(t, frame),
            }))
            .filter((p): p is typeof p & { box: NonNullable<typeof p.box> } => Boolean(p.box));
          if (more.length) {
            const extra = await meta.segmentBoxes(
              await samDataUrl(image),
              more,
              frame.width,
              frame.height,
              job.signal,
            );
            const nextInventory = { ...inventory, things: [...inventory.things, ...missing] };
            const nextSegmentation = {
              ...segmentation,
              detections: [...segmentation.detections, ...extra.output.detections],
            };
            const nextDetections = { ...detections };
            for (const p of more)
              if (extra.output.detections.some((d) => d.objectId === String(p.id))) {
                nextDetections[p.thing] = String(p.id);
                added.push(p.thing);
              }
            const next = lay({
              inventory: nextInventory,
              segmentation: nextSegmentation,
              detections: nextDetections,
            });
            // Keep what SAM outlined and the room has room for.
            kept = added.some((a) => next.things.find((t) => t.id === a)?.status !== 'unplaced');
            if (kept) {
              inventory = nextInventory;
              segmentation = nextSegmentation;
              Object.assign(detections, nextDetections);
              layout = next;
              // A new segment run holds every mask, so a sighting can point at any of them.
              raw = `${raw}\n${extra.raw}`;
              segmentRunId = saveSegment(mode, segmentation, photo, raw, live);
            }
          }
        }
        check = { ...result.output, kept, added: kept ? added : [] };
        assists.push(
          `Spark check (${kept ? `added ${added.join(', ')}` : 'nothing added'}): ${result.output.note}`,
        );
      }
    }
    if (withCheck) {
      job.check();
      await job.done(
        'check',
        check
          ? `${check.kept ? `Added ${check.added.join(', ')}. ` : 'Nothing added. '}${check.note}`
          : checkFailed
            ? `Skipped: ${checkFailed} The draft goes on without it.`
            : 'Nothing to compare',
        check?.kept ? await renderLayout(layout, calibration) : undefined,
        PREVIEW,
      );
    }

    // 5. A model for each thing a template doesn't draw, or that may be tracked: a
    // saved fixture's, the catalogue's, or a cube; never fitted. Its crop is kept,
    // so Spark can model it properly later.
    job.run('models');
    const items: Record<string, SavedItem> = {};
    const modelFrom: Record<string, DraftModelSource> = {};
    const crops: Record<string, string> = {};
    const library = store.memory(mode).fixtures ?? [];
    const modelled = layout.things.filter(
      (t) => t.status === 'object' || (t.status === 'placed' && t.role === 'object'),
    );
    for (const t of modelled) {
      const chosen = draftModel(t, t.as, library);
      items[t.id] = {
        ...uniqueParts(chosen.item),
        label: t.label,
        source: chosen.source === 'library' ? 'spark' : 'placeholder',
        segmentRunId,
        swatches: [{ hex: t.color, share: 1 }],
        updatedAt: new Date().toISOString(),
        fit: null,
      };
      modelFrom[t.id] = chosen.source;
      const detection = segmentation.detections.find((d) => d.objectId === t.detectionId);
      if (!detection) continue;
      try {
        const crop = await maskedCrop(photo, detection);
        crops[t.id] = store.asset(id, `crop-${t.id}.png`, crop.png);
      } catch {
        // Too small to crop: Spark can model it from a close photo instead.
      }
    }
    job.check();
    const count = (k: DraftModelSource) => Object.values(modelFrom).filter((v) => v === k).length;
    await job.done(
      'models',
      modelled.length
        ? `${count('catalog')} from the catalogue, ${count('library')} from saved fixtures, ${count('cube')} as cubes to model later; no model calls`
        : 'Nothing to model',
    );

    const output: PhotoDraft = {
      inventory,
      segmentRunId,
      segmentation,
      detections,
      layout,
      items,
      modelFrom,
      crops,
      check,
      assists,
      calibration,
    };
    return { output, usage };
  }
  app.post('/api/scene/from-photo', async (request) => {
    const input = parseInput(sceneFromPhotoBodySchema, request.body);
    const { mode } = input;
    const live = mode === 'live';
    liveImage(mode, input.imageDataUrl);
    if (!calibrationOf(store.memory(mode)))
      throw new LabError('not_calibrated', NOT_CALIBRATED, 409);
    // Refuse up front rather than stop halfway, with the inventory already paid for.
    if (live) meta.mustAfford(photoDraftCeiling(Boolean(input.check)), 'A photo draft');
    const job = jobs.start(input.jobId, draftSteps(Boolean(input.check)), {
      title: 'Drafting the room',
      mode,
    });
    return following(job, async () => {
      const drafted = await run('photo', mode, async (id) => {
        job.link(id);
        job.run('photo');
        const assists: string[] = [];
        let usage: Usage | null = null;
        let model: string | undefined;
        let requestId: string | null = null;
        const image = live ? await validateImage(input.imageDataUrl) : null;
        const photo = image ? image.bytes : await demoPhoto();
        const frame = image ? { width: image.width, height: image.height } : { ...DEMO_FRAME };
        // Everything is placed through the room's camera, so the frame must be one of its.
        const calibration = calibrationOf(store.memory(mode));
        if (!calibration) throw new LabError('not_calibrated', NOT_CALIBRATED, 409);
        const { width, height } = calibration.camera.frame;
        requireFrame(
          frame,
          { width, height },
          `This frame is ${frame.width} × ${frame.height}, but the room’s camera was calibrated on ${width} × ${height} frames. Send a frame from that camera, or calibrate again.`,
        );
        const assets = image ? [store.asset(id, `source.${image.ext}`, image.bytes)] : [];
        await job.done(
          'photo',
          image
            ? `${image.width} × ${image.height}`
            : 'Demo: the office from its corner camera, no model calls',
          photo,
          PREVIEW,
        );
        job.check();

        // 1. What is there, roughly where.
        job.run('list');
        let inventory: PhotoInventory;
        if (image) {
          const result = await meta.photoInventory(image.dataUrl, job.signal);
          inventory = cleanInventory(result.output);
          usage = addUsage(usage, result.usage);
          model = result.model;
          requestId = result.requestId;
        } else inventory = cleanInventory(demoPhotoInventory);
        assists.push(`Spark: ${inventory.things.length} things. ${inventory.summary}`);
        job.check();
        await job.done(
          'list',
          `${inventory.things.length} things. ${inventory.summary}`,
          await listedPreview(photo, frame, inventory.things),
          PREVIEW,
        );
        const drafted = await draftThrough({
          job,
          id,
          mode,
          image,
          photo,
          frame,
          withCheck: Boolean(input.check),
          inventory,
          calibration,
          assists,
          assets,
          usage,
        });
        const output = drafted.output;
        usage = drafted.usage;
        return { output, assets, usage, model, requestId };
      });
      job.finish();
      return drafted;
    });
  });
  /**
   * Set a room up from one frame of its corner camera, calibrated or not:
   * Spark lists what is there and estimates the room's size and the camera's
   * height (one call), SAM outlines the floor and walls (two calls), the
   * camera is fitted to them both ways round, and the better way decides
   * which wall is the room's back (its direction) and is saved. Then the
   * draft runs through the new camera as usual, for the person to review.
   */
  app.post('/api/scene/setup', async (request) => {
    const input = parseInput(sceneSetupBodySchema, request.body);
    const { mode } = input;
    const live = mode === 'live';
    liveImage(mode, input.imageDataUrl);
    const ceiling = photoDraftCeiling(Boolean(input.check)) + 2 * META_PRICES.samPerImage;
    if (live) meta.mustAfford(ceiling, 'Setting the room up');
    const job = jobs.start(input.jobId, setupSteps(Boolean(input.check)), {
      title: 'Setting up the room',
      mode,
    });
    return following(job, async () => {
      const drafted = await run('photo', mode, async (id) => {
        job.link(id);
        job.run('photo');
        const assists: string[] = [];
        let usage: Usage | null = null;
        let model: string | undefined;
        let requestId: string | null = null;
        const image = live ? await validateImage(input.imageDataUrl) : null;
        const photo = image ? image.bytes : await demoPhoto();
        const frame = image ? { width: image.width, height: image.height } : { ...DEMO_FRAME };
        const assets = image ? [store.asset(id, `source.${image.ext}`, image.bytes)] : [];
        await job.done(
          'photo',
          image
            ? `${image.width} × ${image.height}`
            : 'Demo: the office from its corner camera, no model calls',
          photo,
          PREVIEW,
        );
        job.check();

        // 1. What is there, and how big the room is.
        job.run('list');
        let inventory: PhotoInventory;
        let room: RoomEstimate;
        if (image) {
          const result = await meta.setupInventory(image.dataUrl, job.signal);
          const { room: estimate, ...listed } = result.output;
          inventory = cleanInventory(listed);
          room = estimate;
          usage = addUsage(usage, result.usage);
          model = result.model;
          requestId = result.requestId;
        } else {
          inventory = cleanInventory(demoPhotoInventory);
          room = demoRoomEstimate();
        }
        assists.push(
          `Spark: ${inventory.things.length} things, a room about ${room.rightWallCm} × ${room.leftWallCm} cm, the camera about ${room.cameraHeightCm} cm up. ${inventory.summary}`,
        );
        job.check();
        await job.done(
          'list',
          `${inventory.things.length} things. Room about ${room.rightWallCm} × ${room.leftWallCm} cm, camera about ${room.cameraHeightCm} cm up.`,
          await listedPreview(photo, frame, inventory.things),
          PREVIEW,
        );

        // A saved calibration through this frame and zoom is the person's (or an earlier
        // setup's): keep it rather than ask SAM again for walls it may not see.
        const saved = store.memory(mode).camera;
        const kept =
          saved &&
          saved.camera.frame.width === frame.width &&
          saved.camera.frame.height === frame.height &&
          sameCrop(saved.crop ?? null, input.crop ?? null)
            ? saved
            : null;
        const sceneOf = (memory: DeskMemory) =>
          input.scene === 'custom'
            ? (memory.scene ?? ISO_PRESETS.office)
            : ISO_PRESETS[input.scene];
        let calibration: RoomCalibration;
        let setup: NonNullable<PhotoDraft['setup']>;
        if (kept) {
          calibration = kept;
          const { room: tiles, position, f, frame: size } = kept.camera;
          setup = {
            room,
            floorCm: innerFloorCm(sceneOf(store.memory(mode)), tiles),
            fit: {
              error: kept.error,
              heightCm: Math.round(position[2] * ISO_TILE_CM),
              hfovDeg: Math.round((2 * Math.atan(size.width / 2 / f) * 180) / Math.PI),
            },
          };
          const note = `Kept the room’s calibration from ${new Date(kept.calibratedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}, off by ${kept.error.toFixed(1)} px`;
          assists.push(note);
          job.run('walls');
          await job.done('walls', 'Skipped: the room is already calibrated through this view');
          job.run('calibrate');
          await job.done(
            'calibrate',
            note,
            await renderScene(sceneOf(store.memory(mode)), kept),
            PREVIEW,
          );
        } else {
          // 2. Where the floor meets the walls.
          job.run('walls');
          const floor = await findFloorMarks({ store, meta, run }, mode, image);
          const floorCm = { w: room.rightWallCm, d: room.leftWallCm };
          // Where it can't go on by itself, the person places the corner, starting from what was found.
          const byHand = (message: string, found: RoomMarks | null) =>
            new LabError('calibrate_by_hand', message, 422, undefined, {
              marks: found,
              room: floorCm,
              heightCm: room.cameraHeightCm,
              frame,
            });
          const marks = floor.marks;
          if (!marks)
            throw byHand(
              'SAM found no floor where it meets the walls. Place the far corner and the walls’ floor lines by hand.',
              null,
            );
          // Both walls' floor lines, or the fit bends the camera to one line and looks right when it isn't.
          if (!marks.back.length || !marks.left.length)
            throw byHand(
              `Furniture hides the ${marks.back.length ? 'left' : 'right'} wall’s floor line, so the camera can’t be fitted by itself. Place the far corner and that wall’s line by hand.`,
              marks,
            );
          job.check();
          await job.done(
            'walls',
            `The far corner, ${marks.back.length} points along the right wall and ${marks.left.length} along the left`,
          );

          // 3. The camera, both ways round: the better fit says which wall is the back.
          // Spark's height is an estimate: it guides the fit without pinning it.
          job.run('calibrate');
          const memory = store.memory(mode);
          const heightSpreadCm = 20;
          const ways = [floorCm, { w: floorCm.d, d: floorCm.w }].map((size) => ({
            floorCm: size,
            error: fitRoom(
              {
                mode,
                marks,
                room: size,
                heightCm: room.cameraHeightCm,
                heightSpreadCm,
                scene: input.scene,
                crop: input.crop ?? null,
              },
              frame,
              memory,
            ).error,
          }));
          const best = ways.sort((a, b) => a.error - b.error)[0]!;
          const calibrated = await calibrateRoom(store, {
            mode,
            image,
            marks,
            room: best.floorCm,
            heightCm: room.cameraHeightCm,
            heightSpreadCm,
            scene: input.scene,
            crop: input.crop ?? null,
          }).catch((e: unknown) => {
            throw e instanceof LabError && e.code === 'calibrate_fit'
              ? byHand(`${e.message} Place the far corner by hand.`, marks)
              : e;
          });
          calibration = calibrationOf(calibrated.memory)!;
          setup = { room, floorCm: best.floorCm, fit: calibrated.fit };
          const turned = best.floorCm.w !== room.rightWallCm;
          assists.push(
            `Calibrated a ${best.floorCm.w} × ${best.floorCm.d} cm room${turned ? ' (turned: the left wall fits as the back)' : ''}, fit ${calibrated.fit.error.toFixed(1)} px`,
          );
          job.check();
          await job.done(
            'calibrate',
            `${best.floorCm.w} × ${best.floorCm.d} cm${turned ? ', turned' : ''}; the camera about ${calibrated.fit.heightCm} cm up and ${calibrated.fit.hfovDeg}° wide, off by ${calibrated.fit.error.toFixed(1)} px`,
            await renderScene(sceneOf(calibrated.memory), calibration),
            PREVIEW,
          );
        }

        const result = await draftThrough({
          job,
          id,
          mode,
          image,
          photo,
          frame,
          withCheck: Boolean(input.check),
          inventory,
          calibration,
          assists,
          assets,
          usage,
        });
        usage = result.usage;
        // A wall the draft turned changes the room's size and the camera's height.
        const drawn = result.output.calibration;
        if (drawn !== calibration)
          setup = {
            ...setup,
            floorCm: {
              w: Math.round((drawn.camera.room.w - 0.2) * ISO_TILE_CM),
              d: Math.round((drawn.camera.room.d - 0.2) * ISO_TILE_CM),
            },
            fit: {
              ...setup.fit,
              error: drawn.error,
              heightCm: Math.round(drawn.camera.position[2] * ISO_TILE_CM),
            },
          };
        const output: PhotoDraft = {
          ...result.output,
          setup,
        };
        return { output, assets, usage, model, requestId };
      });
      job.finish();
      return drafted;
    });
  });
}

/** The demo office's own size and camera, as Spark would estimate them. */
function demoRoomEstimate(): RoomEstimate {
  const { room, position } = DEMO_CALIBRATION.camera;
  const floor = innerFloorCm(ISO_PRESETS.office, room);
  return {
    rightWallCm: floor.w,
    leftWallCm: floor.d,
    cameraHeightCm: Math.round(position[2] * ISO_TILE_CM),
  };
}
/** A scene's floor inside its walls, in centimetres, when it spans `tiles` walls included. */
function innerFloorCm(scene: IsoScene, tiles: { w: number; d: number }) {
  const wall = (g: string) => scene.props.find((p) => p.group === g);
  return {
    w: Math.round((tiles.w - (wall('wall-left')?.size.w ?? 0)) * ISO_TILE_CM),
    d: Math.round((tiles.d - (wall('wall-back')?.size.d ?? 0)) * ISO_TILE_CM),
  };
}
/** Whether two zoomed views are the same, to the pixel or so. */
const sameCrop = (a: CameraCrop | null, b: CameraCrop | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    (['x', 'y', 'w', 'h'] as const).every((k) => Math.abs(a[k] - b[k]) < 1e-3));
