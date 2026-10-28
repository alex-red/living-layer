import OpenAI from 'openai';
import { z } from 'zod';
import {
  sceneSchema,
  sceneGuessSchema,
  presetCatalog,
  ARCHETYPES,
  ITEM_MATERIALS,
  itemClassSchema,
  itemCheckSchema,
  sceneDraftSchema,
  templateCatalog,
  type Usage,
  type Segmentation,
} from '@livinglayer/domain';
import type { Config, Fetcher } from './config.js';
import { LabError } from './errors.js';
import type { EvidenceStore } from './store.js';
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
  private reserve() {
    if (!this.config.modelApiKey || !this.config.metaEnabled)
      throw new LabError('meta_not_ready', 'Live Meta calls are not enabled on the server.', 409);
    this.store.reserveRequest(this.config.maxRequests);
  }
  async text(): Promise<ProviderResult<{ text: string }>> {
    this.reserve();
    const response = await this.client.responses.create({
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
    this.reserve();
    const response = await this.client.responses.create({
      model: this.config.sparkModel,
      store: false,
      max_output_tokens: 4096,
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
    if (response.status !== 'completed')
      throw new LabError('incomplete_response', 'Spark did not complete scene discovery.', 502);
    let data: unknown;
    try {
      data = JSON.parse(response.output_text);
    } catch {
      throw new LabError('invalid_scene', 'Spark did not return a JSON scene.', 502);
    }
    const result = sceneSchema.safeParse(data);
    if (!result.success)
      throw new LabError(
        'invalid_scene',
        'Spark returned a scene outside the bounded object contract.',
        502,
      );
    return {
      output: result.data,
      model: response.model,
      requestId: response._request_id ?? null,
      usage: usageOf(response.usage),
    };
  }
  /** Which isometric preset fits the photo, and which of its optional props are visible. */
  async classify(imageDataUrl: string) {
    this.reserve();
    const response = await this.client.responses.create({
      model: this.config.sparkModel,
      store: false,
      max_output_tokens: 4096,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Pick the scene preset that best matches this photo: office (a room with a desk), desk (a close view of a desktop), or fridge (the inside of a fridge). Then list which of that preset's optional props are visible, using only these ids:\n${presetCatalog()}\nDescribe only what is visible, in one short sentence.`,
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
    if (response.status !== 'completed')
      throw new LabError('incomplete_response', 'Spark did not complete the scene guess.', 502);
    let data: unknown;
    try {
      data = JSON.parse(response.output_text);
    } catch {
      throw new LabError('invalid_scene', 'Spark did not return a JSON scene guess.', 502);
    }
    const result = sceneGuessSchema.safeParse(data);
    if (!result.success)
      throw new LabError('invalid_scene', 'Spark returned a scene outside the preset list.', 502);
    return {
      output: result.data,
      model: response.model,
      requestId: response._request_id ?? null,
      usage: usageOf(response.usage),
    };
  }
  /**
   * A whole room laid out from the template palette: which templates stand
   * where on a grid, as Spark reads the photo. Geometry comes from the
   * templates, never from the model.
   */
  async layout(imageDataUrl: string) {
    this.reserve();
    const response = await this.client.responses.create({
      model: this.config.sparkModel,
      store: false,
      max_output_tokens: 4096,
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
    if (response.status !== 'completed')
      throw new LabError('incomplete_response', 'Spark did not complete the scene draft.', 502);
    let data: unknown;
    try {
      data = JSON.parse(response.output_text);
    } catch {
      throw new LabError('invalid_scene', 'Spark did not return a JSON scene draft.', 502);
    }
    const result = sceneDraftSchema.safeParse(data);
    if (!result.success)
      throw new LabError(
        'invalid_scene',
        'Spark returned a layout outside the template list.',
        502,
      );
    return {
      output: result.data,
      model: response.model,
      requestId: response._request_id ?? null,
      usage: usageOf(response.usage),
    };
  }
  /**
   * Name the object's archetype and material from its masked crop. Spark
   * classifies; the fitter measures every number from the mask itself.
   */
  async itemClass(cropDataUrl: string, label: string) {
    this.reserve();
    const response = await this.client.responses.create({
      model: this.config.sparkModel,
      store: false,
      max_output_tokens: 1024,
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
    return this.parsed(response, itemClassSchema, 'item class');
  }
  /**
   * Spark compares the photo with the model rendered from the same camera and
   * suggests bounded corrections. The fitter keeps them only if the
   * silhouette still matches the mask at least as well.
   */
  async itemCheck(cropDataUrl: string, renderDataUrl: string, summary: string) {
    this.reserve();
    const response = await this.client.responses.create({
      model: this.config.sparkModel,
      store: false,
      max_output_tokens: 1024,
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
    return this.parsed(response, itemCheckSchema, 'item check');
  }
  private parsed<T>(
    response: OpenAI.Responses.Response & { _request_id?: string | null },
    schema: z.ZodType<T>,
    what: string,
  ): ProviderResult<T> {
    if (response.status !== 'completed')
      throw new LabError('incomplete_response', `Spark did not complete the ${what}.`, 502);
    let data: unknown;
    try {
      data = JSON.parse(response.output_text);
    } catch {
      throw new LabError('invalid_item', `Spark did not return a JSON ${what}.`, 502);
    }
    const result = schema.safeParse(data);
    if (!result.success)
      throw new LabError('invalid_item', `Spark returned a ${what} outside the contract.`, 502);
    return {
      output: result.data,
      model: response.model,
      requestId: response._request_id ?? null,
      usage: usageOf(response.usage),
    };
  }
  async segment(
    imageDataUrl: string,
    concept: string,
    width: number,
    height: number,
  ): Promise<ProviderResult<Segmentation> & { raw: string }> {
    this.reserve();
    const response = await this.client.responses
      .create(
        {
          model: this.config.samModel,
          store: false,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: concept },
                { type: 'input_image', image_url: imageDataUrl, detail: 'auto' },
              ],
            },
          ],
          stream: true,
        },
        { timeout: this.config.timeoutMs, signal: AbortSignal.timeout(this.config.timeoutMs) },
      )
      .withResponse();
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
    const decoded = await decodeSegmentation(tapped(), concept, width, height);
    return { ...decoded, model, requestId: response.request_id ?? null, usage };
  }
}
