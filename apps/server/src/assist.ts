import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import {
  runOutput,
  assistBodySchema,
  assistSaveBodySchema,
  adoptPreset,
  applyRecipeOps,
  calibrationOf,
  ISO_PRESETS,
  isoSceneSchema,
  pinOf,
  sceneWithRecipe,
  fitGroup,
  fitKept,
  mirrorRecipe,
  ISO_TILE_CM,
  maskBits,
  settleFixtures,
  type IsoScene,
  type ZoneOnSurface,
  assembleRecipe,
  checkRecipe,
  clipMask,
  META_PRICES,
  newBits,
  photoBox,
  photoColor,
  placeOfGroup,
  groupBounds,
  ridersOf,
  RECIPE_OPS,
  readIntent,
  resolveSelection,
  refineRecipe,
  roomMask,
  selectionBox,
  selectionMask,
  sizeDisagreement,
  sparkCeiling,
  demoFrame,
  filledRows,
  formOfName,
  furnitureSpec,
  type Bits,
  type BuildRound,
  type FixtureRecipe,
  type IntentContext,
  type ProductFacts,
  type PropForm,
  type RecipeCheck,
  type RecipeOp,
  type RecipePlace,
  type Refiner,
  type Resolved,
  type Segmentation,
  type SelectionShape,
  type Usage,
  type AssistDraft,
  addUsage,
} from '@livinglayer/domain';
import { sparkRefiner } from './build.js';
import { shapeFromPhoto, type Shaped } from './brush-sculpt.js';
import { demoPng } from './demo.js';
import { demoIntent } from './demo-intent.js';
import { LabError, liveImage, parseInput, requireCalibration } from './errors.js';
import { around } from './fixture.js';
import { toDataUrl, requireFrame, validateImage } from './images.js';
import type { RouteDeps } from './route-deps.js';
import { following } from './jobs.js';
import { SEARCH_CEILING, SPARK_BUDGET } from './meta.js';
import { BUNDLED_CATALOG, Catalog, research, type Researcher } from './research.js';
import { selectionRoom } from './select.js';

/**
 * The AI brush ([plan](../../../docs/plans/ai-brush.md#7-orchestration-and-cost)):
 * a selection on the camera's frame and a sentence in, a checked draft out,
 * as one job the page follows step by step and one `assist` run kept as
 * evidence. Nothing is saved to the room: the person reviews the draft. A
 * follow-up names the run before it and reuses its frame, selection and
 * model, so "now make it green" costs one reading.
 */
const STEPS = [
  { id: 'frame', label: 'Hold the frame' },
  { id: 'select', label: 'Find what you selected' },
  { id: 'read', label: 'Read your request' },
  { id: 'lookup', label: 'Look it up' },
  { id: 'build', label: 'Build the model' },
  { id: 'shape', label: 'Shape it from the photo' },
  { id: 'check', label: 'Check it against the camera' },
];

/** The most one request can cost live: reading it, SAM twice, a lookup with searches, two looks at the photo. */
const assistCeiling = () =>
  sparkCeiling(SPARK_BUDGET.intent, 1) +
  2 * META_PRICES.samPerImage +
  sparkCeiling(SPARK_BUDGET.productLookup, 0) +
  SEARCH_CEILING * META_PRICES.webSearchPerQuery +
  2 * Math.max(sparkCeiling(SPARK_BUDGET.refine, 1), sparkCeiling(SPARK_BUDGET.sculpt, 2));

/** A mask as a black and white PNG, to keep with the run for follow-ups and replays. */
const maskPng = (m: Bits) =>
  sharp(Buffer.from(m.data.map((v) => (v ? 255 : 0))), {
    raw: { width: m.width, height: m.height, channels: 1 },
  })
    .png()
    .toBuffer();
export async function pngMask(png: Buffer): Promise<Bits> {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const bits = newBits(info.width, info.height);
  for (let i = 0; i < bits.data.length; i++) bits.data[i] = data[i * info.channels]! > 127 ? 1 : 0;
  return bits;
}
const dataUrl = toDataUrl;
/** Ops that change a model's shape: after them the camera check runs again. */
const SHAPES: RecipeOp['op'][] = ['resize', 'add_part', 'remove_part'];

export async function assistRoutes(
  app: FastifyInstance,
  {
    store,
    meta,
    run,
    entities,
    productsDir,
    jobs,
  }: Pick<RouteDeps, 'store' | 'meta' | 'run' | 'jobs' | 'entities' | 'productsDir'>,
) {
  app.post('', async (request) => {
    const input = parseInput(assistBodySchema, request.body);
    const { mode } = input;
    const live = mode === 'live';
    const before = input.previous ? store.getRun(input.previous) : undefined;
    if (input.previous && (!before || before.kind !== 'assist' || before.mode !== mode))
      throw new LabError('assist_previous', 'That earlier request isn’t one of this mode’s.', 404);
    const last = before?.status === 'completed' ? (runOutput(before, 'assist') ?? null) : null;
    if (input.previous && !last)
      throw new LabError('assist_previous', 'That earlier request didn’t finish.', 409);
    const shape = input.shape ?? last?.shape;
    if (!shape) throw new LabError('invalid_request', 'Select something first.', 400);
    liveImage(mode, input.imageDataUrl);
    if (live && !last && !input.imageDataUrl)
      throw new LabError('invalid_request', 'Send the frame the selection was drawn on.', 400);
    const room = selectionRoom(store.memory(mode));
    if (live) meta.mustAfford(assistCeiling(), 'This request');
    const job = jobs.start(input.jobId, STEPS, {
      title: 'Working on your selection',
      mode,
    });
    return following(job, async () => {
      const done = await run('assist', mode, async (id) => {
        job.link(id);
        let usage: Usage | null = null;
        let model: string | undefined;
        let requestId: string | null = null;
        const assets: string[] = [];
        const note = (r: { usage: Usage | null; model: string; requestId: string | null }) => {
          usage = addUsage(usage, r.usage);
          model = r.model;
          requestId = r.requestId ?? requestId;
        };

        // 1. The frame: the one the selection was drawn on, or the last request's.
        job.run('frame');
        let png: Buffer;
        if (last && !input.shape) {
          png = store.readAsset(`${input.previous}/frame.png`)!;
          if (!png) throw new LabError('assist_previous', 'The earlier frame is gone.', 409);
        } else if (live) {
          const image = await validateImage(input.imageDataUrl);
          requireFrame(image, room.frame);
          png = image.bytes;
        } else png = await demoPng();
        assets.push(store.asset(id, 'frame.png', png));
        await job.done('frame', last && !input.shape ? 'From your last request' : undefined, png);
        job.check();

        // 2. What the selection is of, sharpened by its outline (SAM live, the render in the demo).
        job.run('select');
        let outline: Bits;
        // What a new model's place is fitted to: SAM's whole outline live, the room's drawing in the demo.
        let whole: Bits | null = null;
        let resolved: Resolved;
        let samMissed: string | null = null;
        let byName = false;
        const crop = await around(png, selectionBox(shape, room.frame));
        if (last && !input.shape) {
          outline =
            (await pngMask(
              store.readAsset(`${input.previous}/outline.png`) ?? Buffer.alloc(0),
            ).catch(() => null)) ?? selectionMask(shape, room.frame);
          resolved = {
            target: last.target,
            candidates: last.candidates,
            ambiguous: last.ambiguous,
          };
        } else {
          // The request points at what the panel showed: the selection through the room.
          resolved = room.resolve(selectionMask(shape, room.frame));
          if (live) {
            const sam = await samOutline(png, shape, room.frame, id);
            let open: boolean;
            ({ outline, samMissed, open } = keepOutline(room, shape, resolved.target, sam.cut));
            // Only when the cut outline was SAM's own, of the target: else it outlined something else.
            if (!samMissed) whole = open && sam.whole ? filledRows(sam.whole) : sam.whole;
            else if (resolved.target) {
              // A loose box leaks onto what looks like the thing (a wood floor under a wood
              // desk), and the room's drawing may be what is wrong: SAM is asked for it by name.
              const named = await samNamed(
                png,
                shape,
                room.frame,
                resolved.target,
                drawnOf(room, resolved.target),
                id,
                job.signal,
              ).catch((e: unknown) => {
                // A second look that fails leaves the room's drawing, as before it was asked.
                if (job.signal.aborted) throw e;
                return null;
              });
              if (named) {
                ({ cut: outline, whole } = named);
                samMissed = null;
                byName = true;
              }
            }
          } else {
            // The demo outlines what its fixed frame draws there.
            outline = demoOutline(shape, room.frame, drawnOf(room, resolved.target));
            whole = drawnOf(room, resolved.target);
          }
        }
        assets.push(store.asset(id, 'outline.png', await maskPng(outline)));
        if (whole) assets.push(store.asset(id, 'whole.png', await maskPng(whole)));
        assets.push(store.asset(id, 'crop.png', crop));
        await job.done(
          'select',
          (resolved.target ? resolved.target.label : 'Something the room doesn’t have yet') +
            (samMissed ? ` (SAM outlined ${samMissed}; outlined from the room instead)` : '') +
            (byName ? ' (outlined by SAM from its name)' : ''),
          crop,
        );
        job.check();

        // 3. What the sentence asks for.
        job.run('read');
        const targetProp = resolved.target?.kind === 'prop' ? resolved.target.id : null;
        const ownRecipe =
          room.scene.props.find((p) => p.group === targetProp && p.recipe)?.recipe ?? null;
        const ctx: IntentContext = {
          target: resolved.target,
          recipe: last?.recipe ?? ownRecipe,
          entities: entities(mode),
        };
        let raw;
        if (live) {
          const r = await meta.intent(input.prompt, ctx, dataUrl(crop), job.signal);
          note(r);
          raw = r.output;
        } else raw = demoIntent(input.prompt);
        const intent = readIntent(raw, ctx);
        const question =
          intent.ops.length === 1 && intent.ops[0]!.op === 'clarify'
            ? intent.ops[0]!.question
            : null;
        await job.done('read', question ?? intent.ops.map((o) => o.op).join(', '));
        job.check();

        const draft: AssistDraft = {
          shape,
          prompt: input.prompt,
          previous: input.previous ?? null,
          frame: room.frame,
          ...resolved,
          intent,
          question,
          facts: last?.facts ?? null,
          photo: last?.photo ?? { sizeCm: null, color: null },
          disagreement: [],
          recipe: ctx.recipe,
          place: last?.place ?? null,
          check: last?.check ?? null,
          rounds: [],
        };
        if (question) {
          for (const s of ['lookup', 'build', 'shape', 'check'])
            await job.done(s, 'Waiting for your answer');
          return { output: draft, assets, usage, model, requestId };
        }

        // 4–6. What is known of it, the model, and the camera check.
        const researchers: Researcher[] = [
          new Catalog(live ? [productsDir, BUNDLED_CATALOG] : [BUNDLED_CATALOG]),
        ];
        if (live && intent.product)
          // The web, with its cost and model noted on this run.
          researchers.push({
            kind: 'web',
            lookup: async (q, need) => {
              const r = await meta.lookupProduct(q, need, job.signal);
              note(r);
              return r.output.facts;
            },
          });
        await finishDraft(draft, {
          room,
          outline,
          whole,
          rgba: (await rgbaOf(png)).data,
          researchers,
          refiner: live ? sparkRefiner(meta, dataUrl(crop), job.signal) : null,
          shaper: live
            ? async (recipe, place, against, check) => {
                const shaped = await shapeFromPhoto({
                  meta,
                  camera: room.camera,
                  scene: room.scene,
                  place,
                  recipe,
                  frame: png,
                  against,
                  request: input.prompt,
                  check,
                  onCall: note,
                  signal: job.signal,
                });
                if (shaped) assets.push(store.asset(id, 'shaped.png', shaped.render));
                return shaped;
              }
            : null,
          steps: job,
          signal: job.signal,
        });
        return { output: draft, assets, usage, model, requestId };
      });
      job.finish();
      return done;
    });
  });

  /**
   * Put a reviewed draft's model in the room as furniture: in place of the
   * group it was checked against, or standing where the camera found it.
   * A preset room becomes the person's own scene first (`adoptPreset`); a
   * room calibrated on a preset while another scene of theirs exists is
   * refused rather than overwritten. What stood on the replaced thing (the
   * monitor, the pin, fixtures, zones) moves onto the new model's top. Live,
   * a looked-up product is kept in the catalog with its model.
   */
  app.post('/save', async (request) => {
    const { mode, runId } = parseInput(assistSaveBodySchema, request.body);
    const done = store.getRun(runId);
    if (!done || done.kind !== 'assist' || done.mode !== mode || done.status !== 'completed')
      throw new LabError('assist_previous', 'That request isn’t one of this mode’s.', 404);
    const draft = runOutput(done, 'assist')!;
    if (!draft.recipe || !draft.place)
      throw new LabError('assist_nothing', 'That request has no model to put in the room.', 409);
    let memory = store.memory(mode);
    const calibration = requireCalibration(memory);
    if (calibration.scene !== 'custom') {
      if (memory.scene)
        throw new LabError(
          'assist_scene',
          `The room’s camera is calibrated on the ${ISO_PRESETS[calibration.scene].label} preset, and you have a scene of your own. Calibrate the camera on your scene first.`,
          409,
        );
      memory = adoptPreset(memory, calibration.scene);
    }
    const before = memory.scene!;
    const replaced = draft.place.replaces;
    // An edited model keeps its group id, so what refers to it still does; anything else gets one from its name.
    const g =
      replaced && before.props.some((p) => p.group === replaced && p.recipe)
        ? replaced
        : freshRecipeGroup(before, draft.recipe.label);
    const scene = sceneWithRecipe(before, draft.recipe, draft.place, g);
    const checked = isoSceneSchema.safeParse(scene);
    if (!checked.success)
      throw new LabError('assist_place', 'The model doesn’t fit in the room there.', 422);
    // Whatever was on the replaced thing's top is now on the new model's.
    const top = scene.surfaces.find((x) => x.propId === g) ?? null;
    const moved = (surfaceId: string) =>
      replaced && top && surfaceId.startsWith(`${replaced}:`) ? top.id : surfaceId;
    memory.scene = checked.data as IsoScene;
    if (memory.fixtures)
      memory.fixtures = settleFixtures(
        memory.fixtures.map((f) =>
          f.scene === 'custom' && f.surfaceId ? { ...f, surfaceId: moved(f.surfaceId) } : f,
        ),
        memory.scene,
      );
    const onTop = <T extends { onSurface?: ZoneOnSurface }>(z: T): T =>
      z.onSurface?.scene === 'custom'
        ? {
            ...z,
            onSurface: {
              ...z.onSurface,
              surfaceId: moved(z.onSurface.surfaceId),
            },
          }
        : z;
    if (memory.zone) memory.zone = onTop(memory.zone);
    if (memory.rules) memory.rules = memory.rules.map((r) => ({ ...r, zone: onTop(r.zone) }));
    // The pin follows its surface; with none (the demo's is built in, not kept), a
    // replaced desk's new top is pinned through the camera, as auto-pin would.
    const camera = calibrationOf(memory)!.camera;
    const pinned =
      memory.surface?.scene === 'custom'
        ? memory.scene.surfaces.find((x) => x.id === moved(memory.surface!.surfaceId))
        : !memory.surface &&
            replaced &&
            before.surfaces.some((x) => x.id.startsWith(`${replaced}:`))
          ? top
          : undefined;
    if (pinned !== undefined) {
      const pin = pinned ? pinOf(camera, pinned, camera.frame) : null;
      memory.surface = pin ? { ...pin, scene: 'custom' } : null;
    }
    // The catalog first: if it fails, the room is unchanged and a retry doesn't add a second model.
    if (mode === 'live' && draft.facts && draft.intent.product)
      new Catalog([productsDir, BUNDLED_CATALOG]).save(
        { ...draft.facts, query: draft.intent.product },
        draft.recipe,
      );
    store.saveMemory(memory);
    return { memory, group: g };
  });

  /**
   * SAM's outline of the boxed thing, cut to the selection (the selection
   * itself when SAM finds none), and whole: SAM often outlines all of it.
   */
  async function samOutline(
    png: Buffer,
    shape: SelectionShape,
    frame: Segmentation['frame'],
    runId: string,
  ): Promise<{ cut: Bits; whole: Bits | null }> {
    const b = selectionBox(shape, frame);
    const outlined = await meta.segmentBoxes(
      dataUrl(png),
      [
        {
          id: 1,
          box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
        },
      ],
      frame.width,
      frame.height,
    );
    store.asset(runId, 'sam-output.txt', outlined.raw);
    return { cut: samMask(outlined.output, shape, frame), whole: samWhole(outlined.output, frame) };
  }
  /** SAM's outline of the target found by its name (`namedOutline`); null when it isn't one. */
  async function samNamed(
    png: Buffer,
    shape: SelectionShape,
    frame: Segmentation['frame'],
    target: NonNullable<Resolved['target']>,
    drawn: Bits | null,
    runId: string,
    signal?: AbortSignal,
  ): Promise<{ cut: Bits; whole: Bits } | null> {
    const found = await meta.segment(
      dataUrl(png),
      samConcept(target.label),
      frame.width,
      frame.height,
      {
        ...(signal ? { signal } : {}),
      },
    );
    store.asset(runId, 'sam-named-output.txt', found.raw);
    return namedOutline(found.output, shape, frame, drawn);
  }
}

/** SAM's largest outline for a box prompt, cut to the selection; the selection itself when SAM found none. */
export function samMask(
  sam: Pick<Segmentation, 'detections'>,
  shape: SelectionShape,
  frame: Segmentation['frame'],
): Bits {
  const found = [...sam.detections].sort(
    (a, c) => c.mask.foregroundPixels - a.mask.foregroundPixels,
  )[0];
  return (found && clipMask(found, shape, frame)) ?? selectionMask(shape, frame);
}
/** SAM's largest outline for a box prompt, whole; null when it found none. */
export function samWhole(sam: Pick<Segmentation, 'detections'>, frame: Segmentation['frame']) {
  const found = [...sam.detections].sort(
    (a, c) => c.mask.foregroundPixels - a.mask.foregroundPixels,
  )[0];
  return found ? maskBits(found, frame, 1) : null;
}
/** How the room's camera draws a target (a prop's group or a fixture); null for a tracked object or nothing. */
export function drawnOf(
  room: Pick<ReturnType<typeof selectionRoom>, 'picture'>,
  t: Resolved['target'],
): Bits | null {
  return t && t.kind !== 'object'
    ? roomMask(room.picture, t.kind === 'fixture' ? `fixture:${t.id}` : t.id)
    : null;
}
/** How much of the room's drawing of a thing must lie inside SAM's outline for SAM's to be kept. */
const KEEP_SAM_OVER = 0.6;
/** How much better a new model's mirror image must match its outline to be taken over it as built. */
const MIRROR_MARGIN = 0.02;
/**
 * The outline a live request works on. SAM outlines what stands out in the
 * box, which can be what stands on the thing (a keyboard on a desk): its
 * outline is kept when the room reads it as the same target, or when the
 * room's drawing of the target lies mostly inside it (the thing drawn too
 * small, then kept with its rows filled across); else the room's drawing of the target inside the selection is
 * used, and `samMissed` says what SAM outlined instead.
 */
export function keepOutline(
  room: Pick<ReturnType<typeof selectionRoom>, 'picture' | 'frame' | 'resolve'>,
  shape: SelectionShape,
  target: Resolved['target'],
  sam: Bits,
): { outline: Bits; samMissed: string | null; open: boolean } {
  const drawn = drawnOf(room, target);
  const of = room.resolve(sam).target;
  if (!drawn || (of?.kind === target!.kind && of.id === target!.id))
    return { outline: sam, samMissed: null, open: false };
  // The room's own drawing of it lying mostly inside SAM's outline is the same thing drawn
  // too small or a little off: the case a person selects it to put right, so SAM's is kept.
  // An open thing (a shelf's frame) is outlined with gaps, so its rows are filled across first.
  const envelope = filledRows(sam);
  let mine = 0;
  let shared = 0;
  for (let i = 0; i < drawn.data.length; i++) {
    mine += drawn.data[i]!;
    shared += drawn.data[i]! & envelope.data[i]!;
  }
  // Kept filled: the size, the place and the check all read an outline as the thing's solid shape.
  if (mine && shared / mine >= KEEP_SAM_OVER)
    return { outline: envelope, samMissed: null, open: true };
  const inside = selectionMask(shape, room.frame);
  for (let i = 0; i < drawn.data.length; i++) drawn.data[i] = drawn.data[i]! & inside.data[i]!;
  return { outline: drawn, samMissed: of?.label ?? 'nothing the room has', open: false };
}

/**
 * A label as SAM's text prompt: a short noun phrase, so what comes before any
 * “with …”. SAM found nothing for “desk with drawers” and the desk for “light wood desk”.
 */
export function samConcept(label: string): string {
  return label
    .split(/\s+(?:with|on|in)\s+/i)[0]!
    .trim()
    .toLowerCase();
}
/** How much of each other SAM's outline found by name and the room's drawing of the thing must share. */
const NAMED_OVERLAP = 0.3;
/**
 * SAM's outline of a thing it found by name, filled across like a kept one:
 * of what it found, the one with most of itself in the selection, cut to the
 * selection and whole. The room's drawing may be well off (that is why it is
 * asked), so the two need only share `NAMED_OVERLAP` of each: a mug on a desk
 * shares almost none of the desk's drawing. Null when nothing passes.
 */
export function namedOutline(
  sam: Pick<Segmentation, 'detections'>,
  shape: SelectionShape,
  frame: Segmentation['frame'],
  drawn: Bits | null,
): { cut: Bits; whole: Bits } | null {
  const inside = selectionMask(shape, frame);
  let best: { whole: Bits; within: number } | null = null;
  for (const d of sam.detections) {
    const whole = filledRows(maskBits(d, frame, 1));
    let within = 0;
    for (let i = 0; i < whole.data.length; i++) within += whole.data[i]! & inside.data[i]!;
    if (within && (!best || within > best.within)) best = { whole, within };
  }
  if (!best) return null;
  if (drawn) {
    let mine = 0;
    let found = 0;
    let shared = 0;
    for (let i = 0; i < drawn.data.length; i++) {
      mine += drawn.data[i]!;
      found += best.whole.data[i]!;
      shared += drawn.data[i]! & best.whole.data[i]!;
    }
    if (!mine || shared / mine < NAMED_OVERLAP || shared / found < NAMED_OVERLAP) return null;
  }
  const cut = { ...best.whole, data: best.whole.data.map((v, i) => v & inside.data[i]!) };
  return { cut, whole: best.whole };
}

/**
 * Where a new model in an old one's place stands: moved to where the camera
 * sees the thing (`fitGroup`), as built or mirrored left for right, whichever
 * matches the outline better by `MIRROR_MARGIN`. Never turned half way round:
 * the room's turn says which way its front faces, which an outline can't, and
 * a desk turned round has its drawers facing the wall. Null when no place is
 * enough better than where the old one stood (`fitKept`).
 */
export function fitNewModel(
  room: Pick<ReturnType<typeof selectionRoom>, 'camera' | 'scene'>,
  recipe: FixtureRecipe,
  at: RecipePlace,
  whole: Bits,
): { recipe: FixtureRecipe; place: RecipePlace; fit: NonNullable<AssistDraft['fit']> } | null {
  const fitOf = (r: FixtureRecipe) =>
    fitGroup(room.camera, sceneWithRecipe(room.scene, r, at, 'candidate'), 'candidate', whole, {
      halfTurn: false,
    });
  const asBuilt = fitOf(recipe);
  const mirror = mirrorRecipe(recipe);
  const other = fitOf(mirror);
  const mirrored = Boolean(other && (!asBuilt || other.iou > asBuilt.iou + MIRROR_MARGIN));
  const fit = mirrored ? other : asBuilt;
  // Judged against the model as built where the old one stood.
  const from = asBuilt?.from ?? fit?.from ?? 0;
  if (!fit || !fitKept({ from, iou: fit.iou })) return null;
  return {
    recipe: mirrored ? mirror : recipe,
    place: { ...at, cx: at.cx + fit.moved.x, cy: at.cy + fit.moved.y },
    fit: {
      from,
      iou: fit.iou,
      movedCm: { x: fit.moved.x * ISO_TILE_CM, y: fit.moved.y * ISO_TILE_CM },
      turned: false,
      mirrored,
    },
  };
}

/**
 * The camera's box in the model's own axes: it is measured across the room,
 * and a model standing a quarter turned has its width along the room's depth
 * (a desk along the left wall), so its sizes are compared and used swapped.
 */
export function modelAxes<B extends { w: number; d: number }>(box: B | null, turns: number) {
  return box && turns % 2 ? { ...box, w: box.d, d: box.w } : box;
}

/** How a draft's steps are reported: the job live, the console in a replay. */
interface DraftSteps {
  run(id: string, detail?: string): void;
  done(id: string, detail?: string, image?: Buffer): Promise<void>;
  check(): void;
}
/**
 * Steps 4–6 of a request, once what it asks for is read: look up what a new
 * model needs (the researchers given, then the camera), build the model or
 * apply the edits to the one there is, and check it through the camera,
 * refined only when it is new and no size was asked for. Shared by the route
 * and by `bun run assist --replay`, which runs a stored request again.
 */
export async function finishDraft(
  draft: AssistDraft,
  {
    room,
    outline,
    whole = null,
    rgba,
    researchers,
    refiner,
    shaper = null,
    steps,
    signal,
  }: {
    room: Pick<ReturnType<typeof selectionRoom>, 'camera' | 'scene'>;
    outline: Bits;
    /** SAM's outline of the whole thing, not cut to the selection: what a new model's place is fitted to. */
    whole?: Bits | null;
    rgba: Uint8Array | Uint8ClampedArray;
    researchers: Researcher[];
    refiner: Refiner | null;
    /** Spark reshapes the model from the photo, live; null in the demo. */
    shaper?:
      | ((
          recipe: FixtureRecipe,
          place: RecipePlace,
          against: Bits,
          check: (r: FixtureRecipe) => RecipeCheck,
        ) => Promise<Shaped | null>)
      | null;
    steps: DraftSteps;
    signal?: AbortSignal;
  },
): Promise<AssistDraft> {
  const { intent } = draft;
  const targetProp = draft.target?.kind === 'prop' ? draft.target.id : null;
  steps.run('lookup');
  const create = intent.ops.find((o) => o.op === 'create' || o.op === 'rebase');
  const turns =
    (draft.place ?? (targetProp ? placeOfGroup(room.scene, targetProp) : null))?.turns ?? 0;
  const box = modelAxes(photoBox(room.camera, outline, room.scene.grid), turns);
  const color = photoColor(rgba, outline);
  draft.photo = {
    sizeCm: box ? { w: box.w, d: box.d, h: box.h } : null,
    color,
  };
  // Spark names a form only when one is close; a mug's isn't, and the old default made it drawers.
  const named = [
    intent.product,
    create?.op === 'create' ? create.label : null,
    draft.target?.label,
  ];
  const form: PropForm =
    create?.form ??
    room.scene.props.find((p) => p.group === targetProp && p.form)?.form ??
    named.reduce<PropForm | null>((f, n) => f ?? (n ? formOfName(n) : null), null) ??
    'cabinet';
  // A thing running out of the top of the picture has no height the camera can measure: the camera
  // gives its footprint, and its height comes from a lookup or, failing one, its template.
  const seenH = box?.cutTop ? null : (box?.h ?? null);
  // From high in a corner, what stands on a thing (a monitor, a laptop, toys on a desk) hides its
  // back, and SAM's outline of it stops short: its depth isn't the camera's, but the room's own.
  const drawn = targetProp ? groupBounds(room.scene, targetProp) : null;
  const hidden = Boolean(targetProp && drawn && ridersOf(room.scene, targetProp).length);
  const seenD = hidden ? null : (box?.d ?? null);
  const drawnD = drawn && Math.round(modelAxes(drawn.size, turns)!.d * ISO_TILE_CM);
  if (create) {
    const query = intent.product ?? draft.target?.label ?? 'furniture';
    const camera: Researcher = {
      kind: 'photo',
      lookup: async (): Promise<ProductFacts | null> =>
        box
          ? {
              query,
              sizeCm: {
                w: box.w,
                d: seenD ?? drawnD ?? box.d,
                h: seenH ?? furnitureSpec(form).heightCm,
              },
              sources: [{ kind: 'photo', title: 'The room’s camera' }],
              confidence: Math.min(0.5, box.iou / 2),
            }
          : null,
    };
    const found = await research(
      query,
      intent.needs.length ? intent.needs : ['size'],
      [...researchers, camera],
      { ...(signal ? { signal } : {}) },
    );
    draft.facts = found.facts;
    draft.disagreement = sizeDisagreement(
      found.facts.sizeCm,
      box
        ? {
            w: box.w,
            ...(seenD === null ? {} : { d: seenD }),
            ...(seenH === null ? {} : { h: seenH }),
          }
        : null,
    );
    const fromPhoto = found.facts.origin.size === 'photo';
    const unseen = [
      ...(box?.cutTop
        ? [
            `its top is out of the picture, so its height isn’t the camera’s (${fromPhoto ? `the template’s ${furnitureSpec(form).heightCm} cm` : 'the lookup’s'})`,
          ]
        : []),
      ...(box && hidden
        ? [
            `what stands on it hides its back, so its depth isn’t the camera’s (${fromPhoto ? `the room’s ${drawnD} cm` : 'the lookup’s'})`,
          ]
        : []),
    ];
    await steps.done(
      'lookup',
      [found.asked.map((a) => `${a.kind}${a.found ? ' ✓' : ' –'}`).join(' · '), ...unseen].join(
        ' · ',
      ),
    );
  } else await steps.done('lookup', 'Not needed');
  steps.check();

  // 5. The model: built from the facts for a new one, else the ops on the one there is.
  steps.run('build');
  let recipe = draft.recipe;
  if (create) {
    recipe = assembleRecipe(
      form,
      {
        ...draft.facts!,
        ...(create.op === 'create' ? { name: create.label } : {}),
      },
      color,
    );
  }
  const edits = intent.ops.filter((o): o is RecipeOp => o.op in RECIPE_OPS);
  if (recipe && edits.length) {
    const applied = applyRecipeOps(recipe, edits);
    if (!applied.ok)
      throw new LabError('assist_op', `Couldn’t ${edits[applied.at]!.op}: ${applied.reason}`, 422);
    recipe = applied.recipe;
  }
  draft.recipe = recipe;
  await steps.done(
    'build',
    recipe ? `${recipe.label}: ${recipe.parts.length} parts` : 'No model to change',
  );
  steps.check();

  // 6. Where it stands: a new model in an old one's place stands where the camera sees the thing,
  // not where the old one stood. A follow-up keeps the place its first request found.
  const matchPhoto = intent.ops.some((o) => o.op === 'match_photo');
  const reshaped = Boolean(create) || matchPhoto || edits.some((o) => SHAPES.includes(o.op));
  draft.place ??=
    (targetProp ? placeOfGroup(room.scene, targetProp) : null) ??
    (box ? { cx: box.cx, cy: box.cy, z: 0, turns: 0, replaces: null } : null);
  if (!draft.previous && create && recipe && draft.place?.replaces && whole) {
    const fitted = fitNewModel(room, recipe, draft.place, whole);
    if (fitted) ({ recipe, place: draft.place, fit: draft.fit } = fitted);
    else draft.fit = null;
    draft.recipe = recipe;
  }
  // Checked against all of the thing once its place was fitted to it, not the part selected,
  // and against the photo's colours as well as its outline.
  const against = draft.fit && whole ? whole : outline;
  const place = draft.place;
  const check = (r: FixtureRecipe) =>
    checkRecipe(room.camera, room.scene, r, place!, against, rgba);

  // 7. A new model, or one asked to look like the photo, is shaped from the photo by Spark.
  steps.run('shape');
  let shaped: Shaped | null = null;
  if (recipe && place && shaper && (create || matchPhoto)) {
    const before = check(recipe);
    let failed: string | null = null;
    try {
      shaped = await shaper(recipe, place, against, check);
    } catch (e) {
      steps.check();
      failed = e instanceof Error ? e.message : 'it failed';
    }
    if (shaped) {
      draft.recipe = recipe = shaped.recipe;
      await steps.done(
        'shape',
        `${recipe.parts.length} parts, IoU ${shaped.check.iou.toFixed(2)} (as built ${before.iou.toFixed(2)}). ${shaped.note}`,
        shaped.render,
      );
    } else
      await steps.done(
        'shape',
        failed
          ? `Spark couldn’t shape it, so it is as built: ${failed}`
          : 'No usable model came back, so it is as built',
      );
  } else
    await steps.done(
      'shape',
      !shaper && (create || matchPhoto)
        ? 'Demo: built from its form, with no model calls'
        : 'Not needed',
    );
  steps.check();

  // 8. The camera check, and Spark's refinements of a new model not shaped from the photo
  // (never of a size asked for).
  steps.run('check');
  if (recipe && place && (reshaped || !draft.check)) {
    // Only a new model is refined, and never away from a size the person asked for.
    const refine = create && !shaped && !edits.some((o) => o.op === 'resize') ? refiner : null;
    // A refinement that fails (a timeout, an overloaded model) keeps the best model so far; a stop still stops.
    let failed: string | null = null;
    const { best, history } = await refineRecipe(
      recipe,
      check,
      refine &&
        (async (r, c) => {
          try {
            return await refine(r, c);
          } catch (e) {
            steps.check();
            failed = e instanceof Error ? e.message : 'It failed.';
            return [];
          }
        }),
    );
    draft.recipe = best.recipe;
    draft.check = best.check;
    draft.rounds = history.slice(1).map((h: BuildRound) => h.ops);
    const moved = draft.fit && Math.hypot(draft.fit.movedCm.x, draft.fit.movedCm.y);
    await steps.done(
      'check',
      (draft.fit
        ? `Moved ${Math.round(moved!)} cm${draft.fit.turned ? ' and turned round' : ''}${draft.fit.mirrored ? ', mirrored left for right,' : ''} to where the camera sees it. `
        : '') +
        best.check.report +
        (failed ? ` Spark’s refinement failed, so it is as built: ${failed}` : ''),
    );
  } else await steps.done('check', draft.place ? 'Unchanged' : 'Nowhere in the room to check it');
  return draft;
}

/** A group id for a saved model, from its name, not yet in the scene: `ikea-alex-desk`, `-2`… */
function freshRecipeGroup(scene: IsoScene, label: string): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'model';
  const taken = new Set(scene.props.map((p) => p.group));
  let g = base;
  for (let n = 2; taken.has(g); n++) g = `${base}-${n}`;
  return g;
}
/**
 * The demo's stand-in for SAM: what the demo frame shows inside the
 * selection, read off its own labelled render, else the selection. Read from
 * the frame, not by the room's ids: once a model is saved, the room has
 * things the fixed demo frame doesn't show, and the frame is what SAM would
 * outline. Given where the room has the target (`near`), it is the thing the
 * frame draws most of there; otherwise the thing it shows most of, mostly inside.
 */
function demoOutline(shape: SelectionShape, frame: Segmentation['frame'], near: Bits | null): Bits {
  const inside = selectionMask(shape, frame);
  const picture = demoFrame();
  if (near)
    for (let i = 0; i < near.data.length; i++) near.data[i] = near.data[i]! & inside.data[i]!;
  const there = near?.data.some(Boolean)
    ? resolveSelection(near, picture, new Map()).candidates.toSorted((a, b) => b.fills - a.fills)[0]
    : null;
  const shown = there?.target ?? resolveSelection(inside, picture, new Map()).target;
  if (!shown) return inside;
  const mask = roomMask(picture, shown.id);
  for (let i = 0; i < mask.data.length; i++) mask.data[i] = mask.data[i]! & inside.data[i]!;
  return mask;
}
export async function rgbaOf(png: Buffer) {
  return sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
