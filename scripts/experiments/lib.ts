/**
 * What the SAM experiments share: a Meta adapter under the experiment's own
 * spending cap, and measures of a mask with no ground truth to hand.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maskBits, type Segmentation } from '@livinglayer/domain';
import { parseConfig } from '../../apps/server/src/config.js';
import { MetaAdapter } from '../../apps/server/src/meta.js';
import { EvidenceStore } from '../../apps/server/src/store.js';

/**
 * Live Meta calls for a script. The adapter keeps its spend in a throwaway
 * store: the lab's own is opened read-only by scripts, so a running server is
 * never disturbed. `spend` refuses a call that would pass `maxUsd` instead.
 */
export function capped(maxUsd: number) {
  let spent = 0;
  let meta: MetaAdapter | null = null;
  return {
    get meta() {
      meta ??= new MetaAdapter(
        parseConfig(process.env),
        new EvidenceStore(mkdtempSync(join(tmpdir(), 'sam-experiment-'))),
      );
      return meta;
    },
    spend(usd: number) {
      if (spent + usd > maxUsd + 1e-9)
        throw new Error(`Stopping: this call would take the experiment past --max-usd ${maxUsd}.`);
      spent += usd;
    },
    get spent() {
      return spent;
    },
  };
}
export const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

export type Bits = ReturnType<typeof maskBits>;
/** A detection's mask, by its id, or null when SAM gave none. */
export function bitsOf(seg: Segmentation, objectId: string | undefined): Bits | null {
  const d = objectId ? seg.detections.find((x) => x.objectId === objectId) : undefined;
  return d ? maskBits(d, seg.frame, 1) : null;
}
export function iou(a: Bits, b: Bits) {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] && b.data[i]) both++;
    if (a.data[i] || b.data[i]) either++;
  }
  return either ? both / either : 0;
}
export const area = (m: Bits) => m.data.reduce((s, v) => s + (v ? 1 : 0), 0);
/** Pieces of at least 20 pixels: a clean mask of one thing is one piece. */
export function pieces(m: Bits) {
  const seen = new Uint8Array(m.data.length);
  let count = 0;
  for (let i = 0; i < m.data.length; i++) {
    if (!m.data[i] || seen[i]) continue;
    let size = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      const x = j % m.width;
      for (const k of [j - 1, j + 1, j - m.width, j + m.width]) {
        if (k < 0 || k >= m.data.length || seen[k] || !m.data[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === m.width - 1)) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    if (size >= 20) count++;
  }
  return count;
}
