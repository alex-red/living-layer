import type { CostEstimate } from '@livinglayer/domain';

/** Fractions of a cent need more digits to mean anything. */
export function usd(n: number): string {
  if (n === 0) return '$0';
  return n >= 0.1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`;
}

/** "≈ $0.0089 per call", with where the number came from. */
export function estimateLabel(e: CostEstimate, unit = 'call'): string {
  if (e.basis === 'list') return `${usd(e.usd)} per ${unit} (list price)`;
  if (e.basis === 'guess') return `≈ ${usd(e.usd)} per ${unit} (rough guess until a live run)`;
  return `≈ ${usd(e.usd)} per ${unit} (median of ${e.samples} live run${e.samples === 1 ? '' : 's'})`;
}
