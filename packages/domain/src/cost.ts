import type { BilledKind, CostEstimate, EvidenceRun, Usage } from './api.js';

/**
 * Meta's published list prices in USD, from dev.meta.ai/docs/pricing-rate-limits.
 * Every Standard Spark version costs the same; SAM bills per image, not per token.
 */
export const META_PRICES = {
  checked: '2026-10-29',
  sparkPerMillion: { input: 1.25, output: 4.25 },
  samPerImage: 0.0025,
  /** Muse Image bills per image returned, whatever the reasoning or tools. */
  imagePerImage: 0.01,
  /** Spark's `web_search` tool, per query it makes, on top of its tokens. */
  webSearchPerQuery: 0.0025,
} as const;
/**
 * Spark usage to assume before any live run exists. Meta doesn't publish how
 * many tokens an image costs, so the discover guess allows for a ~1280 px frame
 * plus reasoning output.
 */
const SPARK_GUESS = {
  text: { input: 40, output: 200 },
  discover: { input: 2_000, output: 1_500 },
};
/** What Spark usage costs at list price. */
export function sparkCost(usage: Usage | null | undefined): number {
  if (!usage) return 0;
  const { input, output } = META_PRICES.sparkPerMillion;
  return (usage.inputTokens * input + usage.outputTokens * output) / 1_000_000;
}
/** Input tokens to allow per image before a call; a ~1280 px photo has measured ~1.5k. */
const SPARK_IMAGE_TOKENS = 3_000;
/**
 * The most one Spark call can cost: every output token it is allowed, and
 * generous input for its images and prompt. The spend limit refuses a call
 * when this could pass it, so the limit holds even if the call runs long.
 */
export function sparkCeiling(maxOutputTokens: number, images: number): number {
  return sparkCost({
    inputTokens: images * SPARK_IMAGE_TOKENS + 2_000,
    outputTokens: maxOutputTokens,
    totalTokens: 0,
  });
}
/** Estimated cost of one run from its recorded usage, or null when it isn't a billed call. */
export function runCost(run: Pick<EvidenceRun, 'kind' | 'mode' | 'usage'>): number | null {
  if (run.mode !== 'live') return null;
  if (run.kind === 'segment') return META_PRICES.samPerImage;
  if (run.kind === 'illustration') return META_PRICES.imagePerImage;
  if (
    !['text', 'discover', 'scene', 'layout', 'item', 'photo', 'fixture', 'assist'].includes(
      run.kind,
    ) ||
    !run.usage
  )
    return null;
  return sparkCost(run.usage);
}
/** Likely cost of the next call of a kind: the median of past live runs, else a guess. */
export function estimateCost(kind: BilledKind, history: EvidenceRun[]): CostEstimate {
  if (kind === 'segment') return { usd: META_PRICES.samPerImage, basis: 'list', samples: 0 };
  const costs = history
    .filter((r) => r.kind === kind)
    .map(runCost)
    .filter((c): c is number => c !== null)
    .sort((a, b) => a - b);
  if (!costs.length) {
    const { input, output } = META_PRICES.sparkPerMillion;
    const guess = SPARK_GUESS[kind];
    return {
      usd: (guess.input * input + guess.output * output) / 1_000_000,
      basis: 'guess',
      samples: 0,
    };
  }
  const mid = Math.floor(costs.length / 2);
  const usd = costs.length % 2 ? costs[mid]! : (costs[mid - 1]! + costs[mid]!) / 2;
  return { usd, basis: 'history', samples: costs.length };
}
