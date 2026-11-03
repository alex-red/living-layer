import type { IsoItem, ItemPart, Print } from './iso-item.js';
import { textHash } from './math.js';
import { STARTER_DECALS } from './starter-decals.js';

/**
 * Prints a starter carries: words on one of its parts. Setting type needs the
 * server's fonts, and starters are built in the browser too, so each print is
 * set once by `bun scripts/starter-prints.ts` into `starter-decals.ts`, with
 * a fingerprint of the part it was wrapped round. A part that has changed
 * since draws no print until the decals are made again (a test says so).
 */
export const STARTER_PRINTS: Record<string, { part: string; print: Print }> = {
  'tim-hortons-mug': {
    part: 'body',
    print: {
      text: 'Tim\nHortons',
      style: 'script',
      color: '#4a2219',
      around: 35,
      at: 0.47,
      size: 0.56,
      underline: true,
    },
  },
};

/** What a print's decal depends on in its part: its shape and size, not its colour. */
export function partFingerprint(p: ItemPart): string {
  return textHash(JSON.stringify([p.shape, p.size, p.shape === 'lathe' ? p.profile : null]));
}

/** A starter's model with its print, when it has one set for the part as it is now. */
export function withStarterPrint(template: string, item: IsoItem): IsoItem {
  const spec = STARTER_PRINTS[template];
  const set = STARTER_DECALS[template];
  if (!spec || !set) return item;
  return {
    ...item,
    parts: item.parts.map((p) =>
      p.id === spec.part && partFingerprint(p) === set.fingerprint
        ? { ...p, paint: [...(p.paint ?? []), set.decal].slice(0, 6) }
        : p,
    ),
  };
}
