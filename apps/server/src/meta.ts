import OpenAI from 'openai';
import { z } from 'zod';
import {
  sceneSchema,
  sceneGuessSchema,
  presetCatalog,
  ARCHETYPES,
  ITEM_MATERIALS,
  itemClassSchema,
  fixtureClassSchema,
  fixtureScanSchema,
  pictureFindSchema,
  sculptSchemaOf,
  MAX_SCAN_THINGS,
  itemCheckSchema,
  sceneDraftSchema,
  templateCatalog,
  photoInventorySchema,
  setupInventorySchema,
  photoCheckSchema,
  photoCatalog,
  sparkCeiling,
  sparkCost,
  META_PRICES,
  RECIPE_ROLES,
  factSourceSchema,
  factsFromLookup,
  productLookupSchema,
  sparkIntentSchema,
  describeContext,
  opCatalog,
  PROP_FORMS,
  type IntentContext,
  type FixtureRecipe,
  type RecipeCheck,
  type FactNeed,
  type FactSource,
  type ProductFacts,
  type Usage,
  type Segmentation,
} from '@livinglayer/domain';
import type { Config, Fetcher } from './config.js';
import { LabError, ident, isTimeout } from './errors.js';
import type { EvidenceStore } from './store.js';
import { buildObjectPrompt, type PromptBox } from '@meta-sam/parser';
import { decodeSegmentation, type SamEvent } from './sam.js';

export interface ProviderResult<T> {
  output: T;
  model: string;
  requestId: string | null;
  usage: Usage | null;
  raw?: string;
}
type ProviderUsage = { input_tokens: number; output_tokens: number; total_tokens: number };
const usageOf = (u?: ProviderUsage | null): Usage | null =>
  u
    ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens, totalTokens: u.total_tokens }
    : null;
/**
 * Output-token ceilings per call. Spark reasons before it answers and the
 * reasoning counts against the ceiling, so a busy photo needs room: at 4096 a
 * full office desk ran out mid-inventory. Only tokens used are billed.
 */
const DEFAULT_SPARK_TIMEOUT_MS = 30_000;
export const SPARK_CALLS = {
  text: { tokens: 1024, timeoutMs: DEFAULT_SPARK_TIMEOUT_MS },
  discover: { tokens: 8192, timeoutMs: DEFAULT_SPARK_TIMEOUT_MS },
  classify: { tokens: 8192, timeoutMs: DEFAULT_SPARK_TIMEOUT_MS },
  layout: { tokens: 16384, timeoutMs: DEFAULT_SPARK_TIMEOUT_MS },
  itemClass: { tokens: 4096, timeoutMs: DEFAULT_SPARK_TIMEOUT_MS },
  fixtureClass: { tokens: 8192, timeoutMs: DEFAULT_SPARK_TIMEOUT_MS },
  // A whole busy frame: Spark's one finished scan took 27 s, and the next two ran past 30.
  fixtureScan: { tokens: 12288, timeoutMs: 90_000, effort: 'low' },
  pictureFind: { tokens: 6144, timeoutMs: DEFAULT_SPARK_TIMEOUT_MS },
  sculpt: { tokens: 16384, timeoutMs: 150_000 },
  itemCheck: { tokens: 4096, timeoutMs: DEFAULT_SPARK_TIMEOUT_MS },
  photoInventory: { tokens: 16384, timeoutMs: DEFAULT_SPARK_TIMEOUT_MS },
  // Spark's checks of a whole photo have taken 18 to 26 s, and three ran past 30.
  photoCheck: { tokens: 12288, timeoutMs: 90_000 },
  productLookup: { tokens: 8192, timeoutMs: 90_000, effort: 'low' },
  // Spark's answers with a crop have taken 7 to 51 s for 2,000 to 5,000 tokens, and once ran past 60.
  intent: { tokens: 8192, timeoutMs: 90_000 },
  // Spark reasons over the photo and the model's parts first: 8192 ran out before it answered.
  refine: { tokens: 16384, timeoutMs: 150_000 },
} as const;
export type SparkCallKind = keyof typeof SPARK_CALLS;
/**
 * How hard Spark thinks before answering, where a call sets it. Nearly all of
 * its time is reasoning: a one-line answer took 16 s by default, 7 s at low and
 * 3 s at minimal, with the same answer.
 */
const reasoningOf = (kind: SparkCallKind) => {
  const limit: { tokens: number; effort?: 'minimal' | 'low' | 'medium' | 'high' } =
    SPARK_CALLS[kind];
  return limit.effort ? { reasoning: { effort: limit.effort } } : {};
};
export const CALL_LIMITS = {
  ...SPARK_CALLS,
  segment: { tokens: null, timeoutMs: DEFAULT_SPARK_TIMEOUT_MS },
  illustrate: { tokens: null, timeoutMs: 120_000 },
} as const;
export type CallKind = keyof typeof CALL_LIMITS;

/** Each Spark call's output-token ceiling, for the callers that reserve spend ahead. */
export const SPARK_BUDGET = Object.fromEntries(
  Object.entries(SPARK_CALLS)
    .filter(([kind]) => kind !== 'text')
    .map(([kind, limit]) => [kind, limit.tokens]),
) as { [K in Exclude<SparkCallKind, 'text'>]: (typeof SPARK_CALLS)[K]['tokens'] };
/** Search queries a product lookup reserves for: the model decides how many it makes. */
export const SEARCH_CEILING = 5;
/**
 * The pages a search answer cites, then the other results it read, as
 * sources: titles trimmed, only http(s) URLs, no repeats, at most eight.
 */
export function citedSources(response: OpenAI.Responses.Response): FactSource[] {
  const found: { title?: string | null; url?: string | null }[] = [];
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const c of item.content)
      if (c.type === 'output_text')
        for (const a of c.annotations) if (a.type === 'url_citation') found.push(a);
  }
  for (const item of response.output) {
    const results = (item as { type: string; results?: unknown }).results;
    if (item.type === 'web_search_call' && Array.isArray(results))
      found.push(...(results as { title?: string; url?: string }[]));
  }
  const sources: FactSource[] = [];
  for (const f of found) {
    const source = factSourceSchema.safeParse({
      kind: 'web',
      title: (f.title?.trim() || f.url || '').slice(0, 120),
      url: f.url,
    });
    if (
      source.success &&
      /^https?:\/\//.test(source.data.url ?? '') &&
      !sources.some((s) => s.url === source.data.url)
    )
      sources.push(source.data);
  }
  return sources.slice(0, 8);
}
/** The first few schema problems, as paths and messages, for the error shown. */
function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
    .join('; ');
}
function classifyCause(e: unknown): string {
  if (isTimeout(e)) return 'timeout';
  if (e instanceof LabError) return e.detail?.reason ?? e.code;
  return 'upstream_failure';
}
/**
 * The JSON a response answers with. With a tool such as web search, Spark can
 * say a sentence around it or answer in more than one message, so after the
 * whole text the last message is tried, then the outermost braces in each;
 * the schema still decides whether it is the answer. Undefined when none parse.
 */
function parsedJson(response: OpenAI.Responses.Response): unknown {
  const messages = response.output
    .filter((o): o is OpenAI.Responses.ResponseOutputMessage => o.type === 'message')
    .map((m) => m.content.map((c) => (c.type === 'output_text' ? c.text : '')).join(''))
    .reverse();
  for (const text of [response.output_text, ...messages]) {
    const braces = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    for (const candidate of [text, braces])
      try {
        if (candidate) return JSON.parse(candidate) as unknown;
      } catch {
        /* the next candidate */
      }
  }
  return undefined;
}

export class MetaAdapter {
  private client: OpenAI;
  constructor(
    private config: Config,
    private store: EvidenceStore,
    fetcher?: Fetcher,
  ) {
    this.client = new OpenAI({
      baseURL: 'https://api.meta.ai/v1',
      apiKey: config.modelApiKey || 'not-configured',
      timeout: config.timeoutMs,
      maxRetries: 0,
      ...(fetcher ? { fetch: fetcher } : {}),
    });
  }
  private async executeCall<T>(
    kind: CallKind,
    fn: (timeoutMs: number) => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    const limit = CALL_LIMITS[kind];
    const timeoutMs =
      limit.timeoutMs === DEFAULT_SPARK_TIMEOUT_MS
        ? this.config.timeoutMs
        : Math.max(this.config.timeoutMs, limit.timeoutMs);
    const maxOutputTokens = limit.tokens;
    const createdAt = new Date().toISOString();
    const start = performance.now();
    try {
      const result = await fn(timeoutMs);
      const durationMs = Math.round(performance.now() - start);
      this.store.recordCall({
        kind,
        createdAt,
        durationMs,
        outputTokens: result.usage?.outputTokens ?? null,
        maxOutputTokens,
        timeoutMs,
        cause: null,
      });
      return result;
    } catch (e) {
      const durationMs = Math.round(performance.now() - start);
      const cause = classifyCause(e);
      const outputTokens =
        (e as { detail?: { usage?: { outputTokens?: number } } })?.detail?.usage?.outputTokens ??
        null;
      this.store.recordCall({
        kind,
        createdAt,
        durationMs,
        outputTokens,
        maxOutputTokens,
        timeoutMs,
        cause,
      });
      throw e;
    }
  }
  /** The worst-case cost of calls still running, so two at once can't both pass the limit. */
  private pending = 0;
  /**
   * Refuse a call that could take today's spend past the limit, counting its
   * worst case until it ends. The returned function records what it really
   * cost (0 when the provider refused it) and releases the reservation.
   */
  private reserve(ceilingUsd: number): (actualUsd: number) => void {
    if (!this.config.modelApiKey || !this.config.metaEnabled)
      throw new LabError('meta_not_ready', 'Live Meta calls are not enabled on the server.', 409);
    const limit = this.store.spendLimit(this.config.spendLimitUsd);
    const spent = this.store.spentToday() + this.pending;
    if (spent + ceilingUsd > limit)
      throw new LabError(
        'spend_limit',
        `This call could cost up to $${ceilingUsd.toFixed(4)}, which would pass today's $${limit.toFixed(2)} Meta spending limit ($${spent.toFixed(4)} spent so far). Raise the limit in Setup, or wait for the next UTC day.`,
        429,
      );
    this.store.countRequest();
    this.pending += ceilingUsd;
    let settled = false;
    return (actualUsd) => {
      if (settled) return;
      settled = true;
      this.pending -= ceilingUsd;
      this.store.addSpend(actualUsd);
    };
  }
  /** Whether calls costing up to `usd` would still fit under today's limit. */
  canAfford(usd: number): boolean {
    return (
      this.store.spentToday() + this.pending + usd <=
      this.store.spendLimit(this.config.spendLimitUsd)
    );
  }
  /**
   * One Spark call under the spend limit, recording what it cost. A long
   * answer (a whole model) may be given longer than the usual timeout. A
   * call with web search reserves for up to `SEARCH_CEILING` queries and is
   * billed for the ones it made.
   */
  private async spark(
    images: number,
    body: OpenAI.Responses.ResponseCreateParamsNonStreaming & { max_output_tokens: number },
    timeout = this.config.timeoutMs,
    signal?: AbortSignal,
    search = false,
  ) {
    const searchCost = search ? META_PRICES.webSearchPerQuery : 0;
    const settle = this.reserve(
      sparkCeiling(body.max_output_tokens, images) + SEARCH_CEILING * searchCost,
    );
    try {
      const response = await this.client.responses.create(body, {
        timeout,
        ...(signal ? { signal } : {}),
      });
      const searches = search
        ? response.output.filter((o) => o.type === 'web_search_call').length
        : 0;
      settle(sparkCost(usageOf(response.usage)) + searches * searchCost);
      return response;
    } catch (e) {
      settle(0);
      throw e;
    }
  }
  /**
   * The one structured Spark call: `text` and then `images` as one user
   * message, answered in `schema` as strict JSON. Output tokens and timeout
   * come from `SPARK_CALLS`, as does the reasoning effort (`effort` overrides
   * it for one call). `finish` maps the parsed answer with the whole response.
   */
  private structured<T, U = T>(
    kind: SparkCallKind,
    o: {
      name: string;
      schema: z.ZodType<T>;
      /** What the answer is, for the error shown when it fails. */
      what: string;
      text: string;
      images?: string[];
      signal?: AbortSignal | undefined;
      effort?: 'minimal' | 'low' | 'medium' | 'high' | undefined;
      /** With Spark's `web_search` tool, and the prompt as plain text. */
      web?: boolean;
      finish?: (output: T, response: OpenAI.Responses.Response) => U;
    },
  ): Promise<ProviderResult<U>> {
    const images = o.images ?? [];
    return this.executeCall(kind, async (timeoutMs) => {
      const response = await this.spark(
        images.length,
        {
          model: this.config.sparkModel,
          store: false,
          max_output_tokens: SPARK_CALLS[kind].tokens,
          ...(o.effort ? { reasoning: { effort: o.effort } } : reasoningOf(kind)),
          ...(o.web
            ? {
                tools: [{ type: 'web_search' }],
                include: ['web_search_call.results'] as OpenAI.Responses.ResponseIncludable[],
              }
            : {}),
          input: o.web
            ? o.text
            : [
                {
                  role: 'user',
                  content: [
                    { type: 'input_text', text: o.text },
                    ...images.map((image_url) => ({
                      type: 'input_image' as const,
                      image_url,
                      detail: 'auto' as const,
                    })),
                  ],
                },
              ],
          text: {
            format: {
              type: 'json_schema',
              name: o.name,
              strict: true,
              schema: z.toJSONSchema(o.schema),
            },
          },
        },
        timeoutMs,
        o.signal,
        o.web,
      );
      const parsed = this.parsed(response, o.schema, o.what, SPARK_CALLS[kind].tokens);
      return o.finish
        ? { ...parsed, output: o.finish(parsed.output, response) }
        : (parsed as unknown as ProviderResult<U>);
    });
  }
  /**
   * Look a product up on the web: Spark with its `web_search` tool, asked
   * for the product's size, parts, colours and materials as JSON. Sources
   * are read from the search's citations and results, never from the
   * model's text. Each search query is billed on top of the tokens, so the
   * call reserves for up to `SEARCH_CEILING` of them.
   */
  async lookupProduct(
    query: string,
    need: readonly FactNeed[],
    signal?: AbortSignal,
  ): Promise<ProviderResult<{ facts: ProductFacts | null; searches: number }>> {
    return this.structured('productLookup', {
      name: 'product_lookup',
      schema: productLookupSchema,
      what: 'product lookup',
      web: true,
      signal,
      text: [
        'Look this product up on the web, preferring the maker’s own product page: ' +
          JSON.stringify(query) +
          '.',
        `What is needed: ${need.join(', ')}.`,
        'found: false when you can’t find this exact product.',
        'name: its full product name as the maker gives it.',
        'sizeCm: its overall width, depth and height in centimetres, as listed.',
        `parts: its visible parts (a desktop, a drawer unit, legs, a shelf), each with a role from: ${RECIPE_ROLES.join(', ')}; its size in cm when listed; how many.`,
        'colors: the colour it was bought in, if the request says, else its usual one, as a hex value.',
        `materials: from ${ITEM_MATERIALS.join(', ')}.`,
        'confidence: how sure you are that these are facts of this exact product, 0 to 1.',
      ].join('\n'),
      finish: (output, response) => ({
        facts: factsFromLookup(query, output, citedSources(response)),
        searches: response.output.filter((o) => o.type === 'web_search_call').length,
      }),
    });
  }
  /**
   * What a sentence typed beside a selection asks for, as ops from the
   * closed list (`opCatalog`), with the selection's crop when there is one.
   * Spark only reads the request; `readIntent` decides what can be done.
   */
  async intent(sentence: string, ctx: IntentContext, cropDataUrl?: string, signal?: AbortSignal) {
    return this.structured('intent', {
      name: 'edit_intent',
      schema: sparkIntentSchema,
      what: 'request',
      images: cropDataUrl ? [cropDataUrl] : [],
      signal,
      text: [
        'A person selected part of their room camera’s picture and typed a request about it. Read the request as a short list of ops (at most four), in the order to do them.',
        `The request: ${JSON.stringify(sentence)}`,
        describeContext(ctx),
        'The ops you may use:',
        opCatalog(),
        'Fill only the fields an op needs and leave the others null or empty. parts picks parts of the model by names, roles and materials it has (empty lists for no filter), minus exceptNames and exceptRoles; parts null means the whole model.',
        'color is a hex value (#rrggbb) for the colour asked for. sizeCm is in centimetres; leave axes not mentioned null.',
        `form is one of: ${PROP_FORMS.join(', ')}.`,
        'product: the product named, with its brand, model and kind (“IKEA Alex desk”), or null.',
        'needs: what must be looked up to build it: size, parts, colors, materials. Empty unless the request makes a model.',
        'targetDisagrees: if the crop clearly shows something other than the selection named above, what it shows; else null.',
        'If the request is unclear, or asks for anything the ops can’t do, answer one clarify op with a short question.',
      ].join('\n'),
    });
  }
  /**
   * Ops that bring a model closer to what the camera sees: the model's
   * parts, how its drawing missed the selection's outline (`check.report`),
   * and the crop when there is one. Answered in the request's own schema;
   * the caller keeps only recipe ops.
   */
  async refineRecipe(
    recipe: FixtureRecipe,
    check: RecipeCheck,
    cropDataUrl?: string,
    signal?: AbortSignal,
  ) {
    const ctx: IntentContext = {
      target: { kind: 'fixture', id: 'draft', label: recipe.label },
      recipe,
      entities: [],
    };
    return this.structured('refine', {
      name: 'recipe_refine',
      schema: sparkIntentSchema,
      what: 'model check',
      images: cropDataUrl ? [cropDataUrl] : [],
      signal,
      text: [
        'A model of a piece of furniture was drawn through the room camera and compared with the outline of the real thing in its picture.',
        describeContext(ctx),
        check.report,
        'Suggest at most four ops that bring the model closer to the real thing: resize the model or its parts, add or remove parts. Only these ops:',
        opCatalog(),
        'Fill only the fields an op needs and leave the others null or empty. Sizes are in centimetres, parts measured from the back-left-bottom corner, facing the room. If nothing would help, answer one clarify op.',
        'product: null. needs: empty. targetDisagrees: null.',
      ].join('\n'),
    });
  }
  async text(): Promise<ProviderResult<{ text: string }>> {
    return this.executeCall('text', async (timeoutMs) => {
      const response = await this.spark(
        0,
        {
          model: this.config.sparkModel,
          input: 'Reply with exactly: LivingLayer connection ready.',
          max_output_tokens: SPARK_CALLS.text.tokens,
          store: false,
        },
        timeoutMs,
      );
      if (response.status !== 'completed' || !response.output_text?.trim())
        throw new LabError('invalid_response', 'Spark returned no completed text response.', 502);
      return {
        output: { text: response.output_text },
        model: response.model,
        requestId: response._request_id ?? null,
        usage: usageOf(response.usage),
      };
    });
  }
  async discover(imageDataUrl: string) {
    return this.structured('discover', {
      name: 'desk_scene',
      schema: sceneSchema,
      what: 'scene discovery',
      images: [imageDataUrl],
      text: 'Describe this desk scene. Return up to three visible, distinctive movable objects. Use short grounded labels and visual appearance only; do not infer identities, ownership, or actions. If no suitable objects are visible, return an empty objects list.',
    });
  }
  /** Which isometric preset fits the photo, and which of its optional props are visible. */
  async classify(imageDataUrl: string) {
    return this.structured('classify', {
      name: 'scene_guess',
      schema: sceneGuessSchema,
      what: 'scene guess',
      images: [imageDataUrl],
      text: `Pick the scene preset that best matches this photo: office (a room with a desk), desk (an office desk: a close view of the desktop in an office), or fridge (the inside of a fridge). Then list which of that preset's optional props are visible, using only these ids:\n${presetCatalog()}\nDescribe only what is visible, in one short sentence.`,
    });
  }
  /**
   * A whole room laid out from the template palette: which templates stand
   * where on a grid, as Spark reads the photo. Geometry comes from the
   * templates, never from the model.
   */
  async layout(imageDataUrl: string) {
    return this.structured('layout', {
      name: 'scene_draft',
      schema: sceneDraftSchema,
      what: 'scene draft',
      images: [imageDataUrl],
      text: [
        'Lay out the furniture and objects in this photo as a small isometric scene, using only these templates:',
        templateCatalog(),
        'Choose a grid from 4 to 14 tiles each way. x runs left to right across the photo, y from the back of the room toward the camera; (x, y) is the back-left corner of the template. turns rotates it by quarter turns.',
        'Put things that stand on a surface at the x and y of that surface; their height is worked out for you. Use at most 24 items, only for what is visible, and describe the scene in one short sentence.',
      ].join('\n'),
    });
  }
  /**
   * Name the object's archetype and material from its masked crop. Spark
   * classifies; the fitter measures every number from the mask itself.
   */
  async itemClass(cropDataUrl: string, label: string) {
    return this.structured('itemClass', {
      name: 'item_class',
      schema: itemClassSchema,
      what: 'item class',
      images: [cropDataUrl],
      text: [
        `This is a cropped photo of one object, a ${label}, with the background removed.`,
        `Pick the archetype that best describes its shape: ${ARCHETYPES.join(', ')}. Use generic only when none fits.`,
        `Pick its main surface material: ${ITEM_MATERIALS.join(', ')}.`,
        'Describe what you see in one short sentence (colours, print, handle side).',
        'If the photo hints at what the hidden back looks like, say so in backside; otherwise null.',
      ].join('\n'),
    });
  }
  /**
   * Spark names the one thing in a reference photo for a fixture: what to
   * model it as, a loose box for SAM, whether it looks like a light or a
   * switch, and its usual size. It never gives the model's numbers.
   */
  async fixtureClass(imageDataUrl: string, hint?: string) {
    return this.structured('fixtureClass', {
      name: 'fixture_class',
      schema: fixtureClassSchema,
      what: 'fixture class',
      images: [imageDataUrl],
      text: [
        `This is a reference photo of one thing someone wants to add to a model of their room${hint ? `: ${hint}` : ''}.`,
        'Name the main thing in a few plain words (label).',
        `Pick the archetype that best describes its shape: ${ARCHETYPES.join(', ')}. Use generic only when none fits.`,
        `Pick its main surface material: ${ITEM_MATERIALS.join(', ')}.`,
        'control: light for a lamp, bulb or light strip; switch for anything else that turns on and off (a fan, a smart plug, a wall switch, a monitor); none for everything else.',
        'Describe what you see in one short sentence (colours, shape, details).',
        'box: a loose box around the whole thing, in thousandths of the image width (x1, x2) and height (y1, y2), top-left first.',
        'sizeCm: its usual real width, depth and height in centimetres.',
      ].join('\n'),
    });
  }
  /**
   * The things in a view's photo that stay put, for scan and map: each with
   * its shape, colour, a loose box and its usual size. The objects the camera
   * follows are named so they are left out.
   */
  async fixtureScan(
    imageDataUrl: string,
    tracked: string[],
    signal?: AbortSignal,
    /** What the room has already; with `only`, nothing else is listed. */
    { known = [], only = false }: { known?: string[]; only?: boolean } = {},
  ) {
    return this.structured('fixtureScan', {
      name: 'fixture_scan',
      schema: fixtureScanSchema,
      what: 'fixture scan',
      images: [imageDataUrl],
      signal,
      text: [
        'This photo shows part of a room someone is modelling. List the fixtures in it: things that stay put and could be placed in a model of the room, like a lamp, a monitor, a keyboard, a mouse, a speaker, a plant, a wall switch or a fan.',
        `Leave out furniture (desks, tables, chairs, shelves), walls and floors${tracked.length ? `, and these objects, which are followed separately: ${tracked.join(', ')}` : ''}.`,
        `For each give: a short grounded label (no names, owners or brands); the archetype that best describes its shape (${ARCHETYPES.join(', ')}; generic only when none fits); its main material (${ITEM_MATERIALS.join(', ')}); control: light for a lamp, bulb or light strip, switch for anything else that turns on and off, none for everything else; its main colour as lowercase #rrggbb; box, a loose box around it as x1, y1, x2, y2 from 0 to 1000 across and down the photo; and sizeCm, its usual real width, depth and height in centimetres.`,
        ...(known.length
          ? [
              only
                ? `List only these things, which the model already has, and nothing else: ${known.join(', ')}. Label each with its name from this list.`
                : `The model already has these; label any you see with its name from this list: ${known.join(', ')}.`,
            ]
          : []),
        `Use at most ${MAX_SCAN_THINGS} things, only what is clearly visible, biggest first. Return an empty list if there are none.`,
      ].join('\n'),
    });
  }
  /**
   * Spark models a thing in our own parts from its picture: the picture, a
   * render of the model it starts from, and that model's parts as JSON in;
   * the parts revised to match out.
   */
  async sculpt(
    pictureDataUrl: string,
    renderDataUrl: string,
    prompt: string,
    parts: string,
    signal?: AbortSignal,
    /** The most parts the answer may have: a fixture's 12, more for furniture. */
    maxParts = 12,
    /** How hard Spark thinks first: a fixture's model asks for low, to answer in seconds. */
    effort?: 'low' | 'medium',
  ) {
    return this.structured('sculpt', {
      name: 'sculpt',
      schema: sculptSchemaOf(maxParts),
      what: 'model',
      images: [pictureDataUrl, renderDataUrl],
      signal,
      effort,
      text: `${prompt}\n\nParts:\n${parts}`,
    });
  }
  /**
   * Spark finds the room's fixtures, by name, in the room's picture: a tight
   * box for each, or not seen. Each comes with where the room's layout
   * expects it, to tell like things apart; what is drawn wins.
   */
  async pictureFind(
    pictureDataUrl: string,
    things: { label: string; near: { x1: number; y1: number; x2: number; y2: number } }[],
    signal?: AbortSignal,
  ) {
    return this.structured('pictureFind', {
      name: 'picture_find',
      schema: pictureFindSchema,
      what: 'picture find',
      images: [pictureDataUrl],
      signal,
      text: [
        'This is an isometric illustration of a room. Find each of these things drawn in it. Each is numbered, with a box from 0 to 1000 across and down the picture where the room’s layout expects it; it may be drawn somewhat away from there, and what is drawn is what counts.',
        ...things.map(
          (t, i) =>
            `${i + 1}. ${t.label} (expected near ${t.near.x1}, ${t.near.y1}, ${t.near.x2}, ${t.near.y2})`,
        ),
        'For each number give: seen, whether it is clearly drawn; and box, a tight box around just that thing as x1, y1, x2, y2 from 0 to 1000. When two look alike, take the one nearer its expected box. When it is not drawn, set seen false and give its expected box.',
      ].join('\n'),
    });
  }
  /**
   * Spark compares the photo with the model rendered from the same camera and
   * suggests bounded corrections. The fitter keeps them only if the
   * silhouette still matches the mask at least as well.
   */
  async itemCheck(cropDataUrl: string, renderDataUrl: string, summary: string) {
    return this.structured('itemCheck', {
      name: 'item_check',
      schema: itemCheckSchema,
      what: 'item check',
      images: [cropDataUrl, renderDataUrl],
      text: [
        'The first image is a photo of an object; the second is a simple model of it, drawn from the same angle with flat colours.',
        `The model is: ${summary}.`,
        'Suggest corrections as multipliers between 0.8 and 1.2 (1 for no change): height, radius (width), handleReach (1 if there is no handle).',
        'If the model body colour is clearly wrong, give the right one as lowercase #rrggbb in body; otherwise null.',
        'Explain the main difference in one short sentence.',
      ].join('\n'),
    });
  }
  /**
   * What is in a photo and roughly where: one entry per thing, each a
   * template or an object archetype with a loose box, its real size, colour
   * and material. Spark gives no tiles or turns; the layout places each thing
   * where SAM's outline of it meets the floor or what it stands on.
   */
  async photoInventory(imageDataUrl: string, signal?: AbortSignal) {
    return this.inventory(imageDataUrl, photoInventorySchema, [], signal);
  }
  /**
   * The inventory, plus the room around the corner camera: how long the two
   * walls that meet at the far corner are, and how high the camera is. The
   * same one call; calibration checks the estimate against the floor.
   */
  async setupInventory(imageDataUrl: string, signal?: AbortSignal) {
    return this.inventory(
      imageDataUrl,
      setupInventorySchema,
      [
        'The photo is from a camera mounted high in one corner of the room, looking across at the far corner. Estimate the room in whole centimetres from things of known size (a desk is about 75 cm high, a door about 200 cm, a floor tile or board): rightWallCm, the length of the wall running to the right from the far corner; leftWallCm, the length of the wall running to the left from it; and cameraHeightCm, how high the camera is above the floor.',
      ],
      signal,
    );
  }
  private async inventory<T>(
    imageDataUrl: string,
    schema: z.ZodType<T>,
    extra: string[],
    signal?: AbortSignal,
  ) {
    return this.structured('photoInventory', {
      name: 'photo_inventory',
      schema,
      what: 'photo inventory',
      images: [imageDataUrl],
      signal,
      text: [
        'List the furniture and objects in this photo so they can be drawn as a small isometric scene.',
        photoCatalog(),
        'For each thing give: a short id (lowercase, like desk or mug-1); a short grounded label from what you see (no names, owners or brands); as, the closest template or object model; role: surface for what things stand on (a desk, a table, a cabinet top, a shelf), furniture for anything else that stands on the floor, object for small movable things; on, the id of what it stands on, or floor; box, a loose box around it as x1, y1, x2, y2 from 0 to 1000 across and down the photo; sizeCm, its real size in whole centimetres (w across its front, d from front to back, h its height), judged from things of known size (a desk is about 75 cm high, a mug about 10 cm); color, its main colour as lowercase #rrggbb; and material, what it is mostly made of.',
        'Include the main surface if there is one. Use at most 16 things, only what is clearly visible, biggest first. Summarise the scene in one short sentence.',
        ...extra,
      ].join('\n'),
    });
  }
  /**
   * Spark compares the photo with the drafted scene drawn from the same
   * camera, and names what is missing or should not be there. The layout
   * keeps an addition only when SAM can outline it.
   */
  async photoCheck(
    imageDataUrl: string,
    renderDataUrl: string,
    listing: string,
    signal?: AbortSignal,
  ) {
    return this.structured('photoCheck', {
      name: 'photo_check',
      schema: photoCheckSchema,
      what: 'photo check',
      images: [imageDataUrl, renderDataUrl],
      signal,
      text: [
        'The first image is a photo; the second is a simple scene drawn from the same camera in flat colours.',
        `The scene has: ${listing}.`,
        photoCatalog(),
        'In missing, list up to four clearly visible things the scene lacks, in the same form (id, label, as, role, on, box from 0 to 1000). In extra, give the ids of things in the scene that are not in the photo. Explain the main difference in one short sentence.',
      ].join('\n'),
    });
  }
  /**
   * A finished Spark response as the schema's type, or an error that says
   * exactly why not: the stop reason, the provider's own message, the tokens
   * used against the limit, or which fields broke the contract.
   */
  private parsed<T>(
    response: OpenAI.Responses.Response & { _request_id?: string | null },
    schema: z.ZodType<T>,
    what: string,
    maxOutputTokens: number,
  ): ProviderResult<T> {
    const usage = usageOf(response.usage);
    const detail = {
      provider: 'Spark' as const,
      step: what,
      model: response.model,
      requestId: response._request_id ?? null,
      usage,
      maxOutputTokens,
    };
    if (response.status !== 'completed') {
      // The stop reason and error code are enums; the provider's free text is never passed on.
      const reason = ident(response.incomplete_details?.reason ?? response.status) ?? 'unknown';
      const code = ident(response.error?.code);
      const used = usage ? ` after ${usage.outputTokens.toLocaleString('en')} output tokens` : '';
      const message =
        reason === 'max_output_tokens'
          ? `Spark ran out of room before finishing the ${what}: it hit its ${maxOutputTokens.toLocaleString('en')}-token output limit${used}. The answer was cut off, so nothing was kept.`
          : reason === 'content_filter'
            ? `Spark's content filter stopped the ${what}${used}. Try a different photo.`
            : response.status === 'failed'
              ? `Spark failed the ${what}${code ? ` with error ${code}` : ''}${used}.`
              : `Spark stopped the ${what} with status “${reason}”${used}.`;
      throw new LabError('incomplete_response', message, 502, {
        ...detail,
        reason,
        ...(code ? { providerCode: code } : {}),
      });
    }
    const data = parsedJson(response);
    if (data === undefined)
      throw new LabError(
        'invalid_response',
        `Spark's ${what} was not valid JSON (${response.output_text.length.toLocaleString('en')} characters).`,
        502,
        { ...detail, reason: 'invalid_json' },
      );
    const result = schema.safeParse(data);
    if (!result.success)
      throw new LabError(
        'invalid_response',
        `Spark's ${what} broke the expected shape: ${issues(result.error)}.`,
        502,
        { ...detail, reason: 'schema_mismatch' },
      );
    return {
      output: result.data,
      model: response.model,
      requestId: response._request_id ?? null,
      usage: usageOf(response.usage),
    };
  }
  /**
   * Outline up to 16 boxes in one SAM call. Each object comes back under its
   * own id, so a mask is labelled by the box that asked for it.
   */
  async segmentBoxes(
    imageDataUrl: string,
    boxes: { id: number; box: PromptBox }[],
    width: number,
    height: number,
    signal?: AbortSignal,
  ) {
    const prompt = buildObjectPrompt({
      size: { width, height },
      objects: boxes.map((b) => ({ id: b.id, prompts: [{ box: b.box }] })),
    });
    return this.segment(imageDataUrl, prompt, width, height, {
      concept: 'photo scene',
      maxMasks: 16,
      ...(signal ? { signal } : {}),
    });
  }
  /**
   * Redraw a photo with Muse Image's edit endpoint: the photo, and any style
   * references after it, in; one PNG out, shaped like `size` (`WxH`, an aspect
   * ratio) when given. Built-in search and tools are off, so the picture comes
   * from the images and the prompt alone.
   */
  async illustrate(
    images: string[],
    prompt: string,
    size = 'auto',
    signal?: AbortSignal,
  ): Promise<ProviderResult<Buffer>> {
    return this.executeCall('illustrate', async (timeoutMs) => {
      const settle = this.reserve(META_PRICES.imagePerImage);
      try {
        const response = await this.client
          .post<{
            data?: { b64_json?: string }[];
            usage?: ProviderUsage;
          }>('/images/edits', {
            body: {
              model: this.config.imageModel,
              prompt,
              images: images.map((image_url) => ({ image_url })),
              size,
              output_format: 'png',
              tool_enablement: {
                enable_image_search: false,
                enable_web_search: false,
                enable_shell: false,
              },
            },
            timeout: timeoutMs,
            ...(signal ? { signal } : {}),
          })
          .withResponse();
        const b64 = response.data.data?.[0]?.b64_json;
        if (!b64) {
          settle(0);
          throw new LabError('image_output', 'Muse Image returned no picture.', 502);
        }
        settle(META_PRICES.imagePerImage);
        return {
          output: Buffer.from(b64, 'base64'),
          model: this.config.imageModel,
          requestId: response.request_id ?? null,
          usage: usageOf(response.data.usage),
        };
      } catch (e) {
        settle(0);
        throw e;
      }
    });
  }
  async segment(
    imageDataUrl: string,
    prompt: string,
    width: number,
    height: number,
    options: { concept?: string; maxMasks?: number; signal?: AbortSignal } = {},
  ): Promise<ProviderResult<Segmentation> & { raw: string }> {
    return (await this.executeCall('segment', async (timeoutMs) => {
      const concept = options.concept ?? prompt;
      // SAM bills per image, so the reservation is also the cost once Meta accepts the call.
      const settle = this.reserve(META_PRICES.samPerImage);
      const response = await this.client.responses
        .create(
          {
            model: this.config.samModel,
            store: false,
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: prompt },
                  { type: 'input_image', image_url: imageDataUrl, detail: 'auto' },
                ],
              },
            ],
            stream: true,
          },
          {
            timeout: timeoutMs,
            signal: options.signal
              ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
              : AbortSignal.timeout(timeoutMs),
          },
        )
        .withResponse()
        .then(
          (r) => {
            settle(META_PRICES.samPerImage);
            return r;
          },
          (e) => {
            settle(0);
            throw e;
          },
        );
      let usage: Usage | null = null;
      let model = this.config.samModel;
      let length = 0;
      const stream = response.data;
      async function* tapped(): AsyncGenerator<SamEvent> {
        try {
          for await (const event of stream) {
            if (event.type === 'response.output_text.delta') {
              length += event.delta.length;
              if (length > 2_000_000)
                throw new LabError(
                  'output_limit',
                  'SAM output exceeded the local safety limit.',
                  502,
                );
            }
            if (event.type === 'response.completed') {
              usage = usageOf(event.response.usage);
              model = event.response.model;
            }
            yield event as unknown as SamEvent;
          }
        } finally {
          stream.controller.abort();
        }
      }
      const decoded = await decodeSegmentation(tapped(), concept, width, height, options.maxMasks);
      return { ...decoded, model, requestId: response.request_id ?? null, usage };
    })) as ProviderResult<Segmentation> & { raw: string };
  }
}
