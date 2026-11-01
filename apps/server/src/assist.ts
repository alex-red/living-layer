import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import {
  adoptPreset,
  applyRecipeOps,
  calibrationOf,
  ISO_PRESETS,
  isoSceneSchema,
  pinOf,
  sceneWithRecipe,
  settleFixtures,
  type IsoScene,
  type ZoneOnSurface,
  assembleRecipe,
  checkRecipe,
  clipMask,
  META_PRICES,
  modeSchema,
  newBits,
  photoBox,
  photoColor,
  placeOfGroup,
  RECIPE_OPS,
  readIntent,
  refineRecipe,
  roomMask,
  selectionBox,
  selectionMask,
  selectionShapeSchema,
  sizeDisagreement,
  sparkCeiling,
  demoFrame,
  type Bits,
  type BuildRound,
  type FixtureRecipe,
  type IntentContext,
  type Mode,
  type ProductFacts,
  type PropForm,
  type RecipeOp,
  type Refiner,
  type Resolved,
  type Segmentation,
  type SelectionShape,
  type Usage,
  type AssistDraft,
} from '@livinglayer/domain';
import { sparkRefiner } from './build.js';
import { demoPng } from './demo.js';
import { demoIntent } from './demo-intent.js';
import { LabError, parseInput } from './errors.js';
import { NOT_CALIBRATED } from './photo.js';
import { around } from './fixture.js';
import { validateImage } from './images.js';
import type { Runner } from './item.js';
import { following, jobs } from './jobs.js';
import { SEARCH_CEILING, SPARK_BUDGET, type MetaAdapter } from './meta.js';
import { BUNDLED_CATALOG, Catalog, research, type Researcher } from './research.js';
import { selectionRoom } from './select.js';
import type { EvidenceStore } from './store.js';

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
  { id: 'check', label: 'Check it against the camera' },
];

/** The most one request can cost live: reading it, SAM, a lookup with searches, two refinements. */
export const assistCeiling = () =>
  sparkCeiling(SPARK_BUDGET.intent, 1) +
  META_PRICES.samPerImage +
  sparkCeiling(SPARK_BUDGET.productLookup, 0) +
  SEARCH_CEILING * META_PRICES.webSearchPerQuery +
  2 * sparkCeiling(SPARK_BUDGET.refine, 1);

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
const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
const addUsage = (a: Usage | null, b: Usage | null | undefined): Usage | null =>
  !b
    ? a
    : {
        inputTokens: (a?.inputTokens ?? 0) + b.inputTokens,
        outputTokens: (a?.outputTokens ?? 0) + b.outputTokens,
        totalTokens: (a?.totalTokens ?? 0) + b.totalTokens,
      };
/** Ops that change a model's shape: after them the camera check runs again. */
const SHAPES: RecipeOp['op'][] = ['resize', 'add_part', 'remove_part'];

export function assistRoutes(
  app: FastifyInstance,
  {
    store,
    meta,
    run,
    entities,
    productsDir,
  }: {
    store: EvidenceStore;
    meta: MetaAdapter;
    run: Runner;
    entities: (mode: Mode) => string[];
    /** Where accepted products are saved (`DATA_DIR/products`); live reads it before the web. */
    productsDir: string;
  },
) {
  app.post('/api/assist', async (request) => {
    const input = parseInput(
      z
        .object({
          mode: modeSchema,
          prompt: z.string().trim().min(1).max(400),
          /** The selection; a follow-up may leave it out to keep the last one. */
          shape: selectionShapeSchema.optional(),
          /** Live: the frame the selection was drawn on, from the camera it was drawn over. */
          imageDataUrl: z.string().max(7_000_000).optional(),
          /** The assist run this request follows. */
          previous: z.uuid().optional(),
          jobId: z.uuid().optional(),
        })
        .strict(),
      request.body,
    );
    const { mode } = input;
    const live = mode === 'live';
    const before = input.previous ? store.getRun(input.previous) : undefined;
    if (input.previous && (!before || before.kind !== 'assist' || before.mode !== mode))
      throw new LabError('assist_previous', 'That earlier request isn’t one of this mode’s.', 404);
    const last = before?.status === 'completed' ? (before.output as AssistDraft) : null;
    if (input.previous && !last)
      throw new LabError('assist_previous', 'That earlier request didn’t finish.', 409);
    const shape = input.shape ?? last?.shape;
    if (!shape) throw new LabError('invalid_request', 'Select something first.', 400);
    if (!live && input.imageDataUrl)
      throw new LabError('demo_image', 'Demo mode uses only the demo room’s camera.');
    if (live && !last && !input.imageDataUrl)
      throw new LabError('invalid_request', 'Send the frame the selection was drawn on.', 400);
    const room = selectionRoom(store.memory(mode));
    if (live && !meta.canAfford(assistCeiling()))
      throw new LabError(
        'spend_limit',
        `This request could cost up to $${assistCeiling().toFixed(3)}, which would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.`,
        429,
      );
    const job = jobs.start(input.jobId, STEPS, { title: 'Working on your selection', mode });
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
          if (image.width !== room.frame.width || image.height !== room.frame.height)
            throw new LabError(
              'not_calibrated',
              `This frame is ${image.width} × ${image.height}, but the room’s camera was calibrated on ${room.frame.width} × ${room.frame.height} frames.`,
              409,
            );
          png = image.bytes;
        } else png = await demoPng();
        assets.push(store.asset(id, 'frame.png', png));
        await job.done('frame', last && !input.shape ? 'From your last request' : undefined, png);
        job.check();

        // 2. What the selection is of, sharpened by its outline (SAM live, the render in the demo).
        job.run('select');
        let outline: Bits;
        let resolved: Resolved;
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
          const first = room.resolve(selectionMask(shape, room.frame));
          outline = live
            ? await samOutline(png, shape, room.frame, id)
            : demoOutline(shape, room.frame, first.target?.id ?? null);
          resolved = room.resolve(outline);
        }
        assets.push(store.asset(id, 'outline.png', await maskPng(outline)));
        assets.push(store.asset(id, 'crop.png', crop));
        await job.done(
          'select',
          resolved.target ? resolved.target.label : 'Something the room doesn’t have yet',
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
          for (const s of ['lookup', 'build', 'check'])
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
          rgba: (await rgbaOf(png)).data,
          researchers,
          refiner: live ? sparkRefiner(meta, dataUrl(crop), job.signal) : null,
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
  app.post('/api/assist/save', async (request) => {
    const { mode, runId } = parseInput(
      z.object({ mode: modeSchema, runId: z.uuid() }).strict(),
      request.body,
    );
    const done = store.getRun(runId);
    if (!done || done.kind !== 'assist' || done.mode !== mode || done.status !== 'completed')
      throw new LabError('assist_previous', 'That request isn’t one of this mode’s.', 404);
    const draft = done.output as AssistDraft;
    if (!draft.recipe || !draft.place)
      throw new LabError('assist_nothing', 'That request has no model to put in the room.', 409);
    let memory = store.memory(mode);
    const calibration = calibrationOf(memory);
    if (!calibration) throw new LabError('not_calibrated', NOT_CALIBRATED, 409);
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
    const g = freshRecipeGroup(before, draft.recipe.label);
    const replaced = draft.place.replaces;
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
        ? { ...z, onSurface: { ...z.onSurface, surfaceId: moved(z.onSurface.surfaceId) } }
        : z;
    if (memory.zone) memory.zone = onTop(memory.zone);
    if (memory.rules) memory.rules = memory.rules.map((r) => ({ ...r, zone: onTop(r.zone) }));
    if (memory.surface?.scene === 'custom') {
      const id = moved(memory.surface.surfaceId);
      const surface = memory.scene.surfaces.find((x) => x.id === id);
      const camera = calibrationOf(memory)!.camera;
      const pin = surface ? pinOf(camera, surface, camera.frame) : null;
      memory.surface = pin ? { ...pin, scene: 'custom' } : null;
    }
    store.saveMemory(memory);
    if (mode === 'live' && draft.facts && draft.intent.product)
      new Catalog([productsDir, BUNDLED_CATALOG]).save(
        { ...draft.facts, query: draft.intent.product },
        draft.recipe,
      );
    return { memory, group: g };
  });

  /** SAM's outline of the boxed thing, cut to the selection; the selection itself when SAM finds none. */
  async function samOutline(
    png: Buffer,
    shape: SelectionShape,
    frame: Segmentation['frame'],
    runId: string,
  ): Promise<Bits> {
    const b = selectionBox(shape, frame);
    const outlined = await meta.segmentBoxes(
      dataUrl(png),
      [{ id: 1, box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } }],
      frame.width,
      frame.height,
    );
    store.asset(runId, 'sam-output.txt', outlined.raw);
    const found = [...outlined.output.detections].sort(
      (a, c) => c.mask.foregroundPixels - a.mask.foregroundPixels,
    )[0];
    return (found && clipMask(found, shape, frame)) ?? selectionMask(shape, frame);
  }
}

/** How a draft's steps are reported: the job live, the console in a replay. */
export interface DraftSteps {
  run(id: string, detail?: string): void;
  done(id: string, detail?: string): Promise<void>;
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
    rgba,
    researchers,
    refiner,
    steps,
    signal,
  }: {
    room: Pick<ReturnType<typeof selectionRoom>, 'camera' | 'scene'>;
    outline: Bits;
    rgba: Uint8Array | Uint8ClampedArray;
    researchers: Researcher[];
    refiner: Refiner | null;
    steps: DraftSteps;
    signal?: AbortSignal;
  },
): Promise<AssistDraft> {
  const { intent } = draft;
  const targetProp = draft.target?.kind === 'prop' ? draft.target.id : null;
  steps.run('lookup');
  const create = intent.ops.find((o) => o.op === 'create' || o.op === 'rebase');
  const box = photoBox(room.camera, outline, room.scene.grid);
  const color = photoColor(rgba, outline);
  draft.photo = {
    sizeCm: box ? { w: box.w, d: box.d, h: box.h } : null,
    color,
  };
  if (create) {
    const query = intent.product ?? draft.target?.label ?? 'furniture';
    const camera: Researcher = {
      kind: 'photo',
      lookup: async (): Promise<ProductFacts | null> =>
        box
          ? {
              query,
              sizeCm: { w: box.w, d: box.d, h: box.h },
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
    draft.disagreement = sizeDisagreement(found.facts.sizeCm, draft.photo.sizeCm);
    await steps.done(
      'lookup',
      found.asked.map((a) => `${a.kind}${a.found ? ' ✓' : ' –'}`).join(' · '),
    );
  } else await steps.done('lookup', 'Not needed');
  steps.check();

  // 5. The model: built from the facts for a new one, else the ops on the one there is.
  steps.run('build');
  let recipe = draft.recipe;
  if (create) {
    const form: PropForm =
      create.form ??
      room.scene.props.find((p) => p.group === targetProp && p.form)?.form ??
      'cabinet';
    recipe = assembleRecipe(
      form,
      { ...draft.facts!, ...(create.op === 'create' ? { name: create.label } : {}) },
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

  // 6. The camera check, and Spark's refinements of a new model (never of a size asked for).
  steps.run('check');
  const reshaped = Boolean(create) || edits.some((o) => SHAPES.includes(o.op));
  draft.place ??=
    (targetProp ? placeOfGroup(room.scene, targetProp) : null) ??
    (box ? { cx: box.cx, cy: box.cy, z: 0, turns: 0, replaces: null } : null);
  if (recipe && draft.place && (reshaped || !draft.check)) {
    const place = draft.place;
    const check = (r: FixtureRecipe) => checkRecipe(room.camera, room.scene, r, place, outline);
    // Only a new model is refined, and never away from a size the person asked for.
    const refine = create && !edits.some((o) => o.op === 'resize') ? refiner : null;
    const { best, history } = await refineRecipe(recipe, check, refine);
    draft.recipe = best.recipe;
    draft.check = best.check;
    draft.rounds = history.slice(1).map((h: BuildRound) => h.ops);
    await steps.done('check', best.check.report);
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
/** The demo's outline: what the render shows of the target inside the selection, else the selection. */
function demoOutline(
  shape: SelectionShape,
  frame: Segmentation['frame'],
  target: string | null,
): Bits {
  const inside = selectionMask(shape, frame);
  if (!target) return inside;
  const shown = roomMask(demoFrame(), target);
  let any = false;
  for (let i = 0; i < shown.data.length; i++) {
    shown.data[i] = shown.data[i]! & inside.data[i]!;
    any ||= shown.data[i] === 1;
  }
  return any ? shown : inside;
}
export async function rgbaOf(png: Buffer) {
  return sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
