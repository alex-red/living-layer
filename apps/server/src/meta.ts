import OpenAI from 'openai';
import { z } from 'zod';
import { sceneSchema, type Usage, type Segmentation } from '@livinglayer/domain';
import type { Config } from './config.js';
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
    fetcher?: typeof fetch,
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
