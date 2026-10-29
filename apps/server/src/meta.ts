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
  itemCheckSchema,
  sceneDraftSchema,
  templateCatalog,
  photoInventorySchema,
  photoCheckSchema,
  photoCatalog,
  sparkCeiling,
  sparkCost,
  META_PRICES,
  type Usage,
  type Segmentation,
} from '@livinglayer/domain';
import type { Config, Fetcher } from './config.js';
import { LabError, ident } from './errors.js';
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
export const SPARK_BUDGET = {
  discover: 8192,
  classify: 8192,
  layout: 16384,
  itemClass: 4096,
  fixtureClass: 8192,
  itemCheck: 4096,
  photoInventory: 16384,
  photoCheck: 12288,
} as const;
/** The first few schema problems, as paths and messages, for the error shown. */
function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
    .join('; ');
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
  /** One Spark call under the spend limit, recording what it cost. */
  private async spark(
    images: number,
    body: OpenAI.Responses.ResponseCreateParamsNonStreaming & { max_output_tokens: number },
  ) {
    const settle = this.reserve(sparkCeiling(body.max_output_tokens, images));
    try {
      const response = await this.client.responses.create(body);
      settle(sparkCost(usageOf(response.usage)));
      return response;
    } catch (e) {
      settle(0);
      throw e;
    }
  }
  async text(): Promise<ProviderResult<{ text: string }>> {
    const response = await this.spark(0, {
      model: this.config.sparkModel,
      input: 'Reply with exactly: LivingLayer connection ready.',
      max_output_tokens: 1024,
      store: false,
    });
    if (response.status !== 'completed' || !response.output_text?.trim())
      throw new LabError('invalid_response', 'Spark returned no completed text response.', 502);
    return {
      output: { text: response.output_text },
      model: response.model,
      requestId: response._request_id ?? null,
      usage: usageOf(response.usage),
    };
  }
  async discover(imageDataUrl: string) {
    const response = await this.spark(1, {
      model: this.config.sparkModel,
      store: false,
      max_output_tokens: SPARK_BUDGET.discover,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Describe this desk scene. Return up to three visible, distinctive movable objects. Use short grounded labels and visual appearance only; do not infer identities, ownership, or actions. If no suitable objects are visible, return an empty objects list.',
            },
            { type: 'input_image', image_url: imageDataUrl, detail: 'auto' },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'desk_scene',
          strict: true,
          schema: z.toJSONSchema(sceneSchema),
        },
      },
    });
    return this.parsed(response, sceneSchema, 'scene discovery', SPARK_BUDGET.discover);
  }
  /** Which isometric preset fits the photo, and which of its optional props are visible. */
  async classify(imageDataUrl: string) {
    const response = await this.spark(1, {
      model: this.config.sparkModel,
      store: false,
      max_output_tokens: SPARK_BUDGET.classify,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Pick the scene preset that best matches this photo: office (a room with a desk), desk (an office desk: a close view of the desktop in an office), or fridge (the inside of a fridge). Then list which of that preset's optional props are visible, using only these ids:\n${presetCatalog()}\nDescribe only what is visible, in one short sentence.`,
            },
            { type: 'input_image', image_url: imageDataUrl, detail: 'auto' },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'scene_guess',
          strict: true,
          schema: z.toJSONSchema(sceneGuessSchema),
        },
      },
    });
    return this.parsed(response, sceneGuessSchema, 'scene guess', SPARK_BUDGET.classify);
  }
  /**
   * A whole room laid out from the template palette: which templates stand
   * where on a grid, as Spark reads the photo. Geometry comes from the
   * templates, never from the model.
   */
  async layout(imageDataUrl: string) {
    const response = await this.spark(1, {
      model: this.config.sparkModel,
      store: false,
      max_output_tokens: SPARK_BUDGET.layout,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                'Lay out the furniture and objects in this photo as a small isometric scene, using only these templates:',
                templateCatalog(),
                'Choose a grid from 4 to 14 tiles each way. x runs left to right across the photo, y from the back of the room toward the camera; (x, y) is the back-left corner of the template. turns rotates it by quarter turns.',
                'Put things that stand on a surface at the x and y of that surface; their height is worked out for you. Use at most 24 items, only for what is visible, and describe the scene in one short sentence.',
              ].join('\n'),
            },
            { type: 'input_image', image_url: imageDataUrl, detail: 'auto' },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'scene_draft',
          strict: true,
          schema: z.toJSONSchema(sceneDraftSchema),
        },
      },
    });
    return this.parsed(response, sceneDraftSchema, 'scene draft', SPARK_BUDGET.layout);
  }
  /**
   * Name the object's archetype and material from its masked crop. Spark
   * classifies; the fitter measures every number from the mask itself.
   */
  async itemClass(cropDataUrl: string, label: string) {
    const response = await this.spark(1, {
      model: this.config.sparkModel,
      store: false,
      max_output_tokens: SPARK_BUDGET.itemClass,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `This is a cropped photo of one object, a ${label}, with the background removed.`,
                `Pick the archetype that best describes its shape: ${ARCHETYPES.join(', ')}. Use generic only when none fits.`,
                `Pick its main surface material: ${ITEM_MATERIALS.join(', ')}.`,
                'Describe what you see in one short sentence (colours, print, handle side).',
                'If the photo hints at what the hidden back looks like, say so in backside; otherwise null.',
              ].join('\n'),
            },
            { type: 'input_image', image_url: cropDataUrl, detail: 'auto' },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'item_class',
          strict: true,
          schema: z.toJSONSchema(itemClassSchema),
        },
      },
    });
    return this.parsed(response, itemClassSchema, 'item class', SPARK_BUDGET.itemClass);
  }
  /**
   * Spark names the one thing in a reference photo for a fixture: what to
   * model it as, a loose box for SAM, whether it looks like a light or a
   * switch, and its usual size. It never gives the model's numbers.
   */
  async fixtureClass(imageDataUrl: string, hint?: string) {
    const response = await this.spark(1, {
      model: this.config.sparkModel,
      store: false,
      max_output_tokens: SPARK_BUDGET.fixtureClass,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
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
            },
            { type: 'input_image', image_url: imageDataUrl, detail: 'auto' },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'fixture_class',
          strict: true,
          schema: z.toJSONSchema(fixtureClassSchema),
        },
      },
    });
    return this.parsed(response, fixtureClassSchema, 'fixture class', SPARK_BUDGET.fixtureClass);
  }
  /**
   * Spark compares the photo with the model rendered from the same camera and
   * suggests bounded corrections. The fitter keeps them only if the
   * silhouette still matches the mask at least as well.
   */
  async itemCheck(cropDataUrl: string, renderDataUrl: string, summary: string) {
    const response = await this.spark(2, {
      model: this.config.sparkModel,
      store: false,
      max_output_tokens: SPARK_BUDGET.itemCheck,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                'The first image is a photo of an object; the second is a simple model of it, drawn from the same angle with flat colours.',
                `The model is: ${summary}.`,
                'Suggest corrections as multipliers between 0.8 and 1.2 (1 for no change): height, radius (width), handleReach (1 if there is no handle).',
                'If the model body colour is clearly wrong, give the right one as lowercase #rrggbb in body; otherwise null.',
                'Explain the main difference in one short sentence.',
              ].join('\n'),
            },
            { type: 'input_image', image_url: cropDataUrl, detail: 'auto' },
            { type: 'input_image', image_url: renderDataUrl, detail: 'auto' },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'item_check',
          strict: true,
          schema: z.toJSONSchema(itemCheckSchema),
        },
      },
    });
    return this.parsed(response, itemCheckSchema, 'item check', SPARK_BUDGET.itemCheck);
  }
  /**
   * What is in a photo and roughly where: one entry per thing, each a
   * template or an object archetype with a loose box. Spark gives no sizes,
   * tiles or turns; SAM and the layout measure those.
   */
  async photoInventory(imageDataUrl: string) {
    const response = await this.spark(1, {
      model: this.config.sparkModel,
      store: false,
      max_output_tokens: SPARK_BUDGET.photoInventory,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                'List the furniture and objects in this photo so they can be drawn as a small isometric scene.',
                photoCatalog(),
                'For each thing give: a short id (lowercase, like desk or mug-1); a short grounded label from what you see (no names, owners or brands); as, the closest template or object model; role: surface for what things stand on (a desk, a table, a cabinet top, a shelf), furniture for anything else that stands on the floor, object for small movable things; on, the id of what it stands on, or floor; and box, a loose box around it as x1, y1, x2, y2 from 0 to 1000 across and down the photo.',
                'Include the main surface if there is one. Use at most 16 things, only what is clearly visible, biggest first. Do not guess sizes or distances. Summarise the scene in one short sentence.',
              ].join('\n'),
            },
            { type: 'input_image', image_url: imageDataUrl, detail: 'auto' },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'photo_inventory',
          strict: true,
          schema: z.toJSONSchema(photoInventorySchema),
        },
      },
    });
    return this.parsed(
      response,
      photoInventorySchema,
      'photo inventory',
      SPARK_BUDGET.photoInventory,
    );
  }
  /**
   * Spark compares the photo with the drafted scene drawn from the same
   * camera, and names what is missing or should not be there. The layout
   * keeps an addition only when SAM can outline it.
   */
  async photoCheck(imageDataUrl: string, renderDataUrl: string, listing: string) {
    const response = await this.spark(2, {
      model: this.config.sparkModel,
      store: false,
      max_output_tokens: SPARK_BUDGET.photoCheck,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                'The first image is a photo; the second is a simple scene drawn from the same camera in flat colours.',
                `The scene has: ${listing}.`,
                photoCatalog(),
                'In missing, list up to four clearly visible things the scene lacks, in the same form (id, label, as, role, on, box from 0 to 1000). In extra, give the ids of things in the scene that are not in the photo. Explain the main difference in one short sentence.',
              ].join('\n'),
            },
            { type: 'input_image', image_url: imageDataUrl, detail: 'auto' },
            { type: 'input_image', image_url: renderDataUrl, detail: 'auto' },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'photo_check',
          strict: true,
          schema: z.toJSONSchema(photoCheckSchema),
        },
      },
    });
    return this.parsed(response, photoCheckSchema, 'photo check', SPARK_BUDGET.photoCheck);
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
    let data: unknown;
    try {
      data = JSON.parse(response.output_text);
    } catch {
      throw new LabError(
        'invalid_response',
        `Spark's ${what} was not valid JSON (${response.output_text.length.toLocaleString('en')} characters).`,
        502,
        { ...detail, reason: 'invalid_json' },
      );
    }
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
  ) {
    const prompt = buildObjectPrompt({
      size: { width, height },
      objects: boxes.map((b) => ({ id: b.id, prompts: [{ box: b.box }] })),
    });
    return this.segment(imageDataUrl, prompt, width, height, {
      concept: 'photo scene',
      maxMasks: 16,
    });
  }
  /**
   * Redraw a photo with Muse Image's edit endpoint: one image in, one PNG
   * out. Built-in search and tools are off, so the picture comes from the
   * photo and the prompt alone.
   */
  async illustrate(imageDataUrl: string, prompt: string): Promise<ProviderResult<Buffer>> {
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
            images: [{ image_url: imageDataUrl }],
            size: 'auto',
            output_format: 'png',
            tool_enablement: {
              enable_image_search: false,
              enable_web_search: false,
              enable_shell: false,
            },
          },
          timeout: Math.max(this.config.timeoutMs, 120_000),
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
  }
  async segment(
    imageDataUrl: string,
    prompt: string,
    width: number,
    height: number,
    options: { concept?: string; maxMasks?: number } = {},
  ): Promise<ProviderResult<Segmentation> & { raw: string }> {
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
        { timeout: this.config.timeoutMs, signal: AbortSignal.timeout(this.config.timeoutMs) },
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
  }
}
