/**
 * Set every starter's print in type and write the decals starters carry
 * (`packages/domain/src/starter-decals.ts`). Run again after changing a
 * print, the part it is on, or how prints are set; `tests/print.test.ts`
 * says when a decal no longer fits its part.
 *
 *   bun scripts/starter-prints.ts
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  STARTER_PRINTS,
  STARTER_TEMPLATES,
  partFingerprint,
  printDecal,
  printKey,
  starterTemplateModel,
  type StarterTemplate,
} from '@livinglayer/domain';
import { inkPrints } from '../apps/server/src/print-ink.js';

const OUT = resolve('packages/domain/src/starter-decals.ts');
const entries: string[] = [];
for (const [template, { part, print }] of Object.entries(STARTER_PRINTS)) {
  if (!STARTER_TEMPLATES.includes(template as StarterTemplate))
    throw new Error(`${template} is not a starter`);
  const model = starterTemplateModel(template as StarterTemplate);
  const target = model.parts.find((p) => p.id === part);
  if (!target) throw new Error(`${template} has no part ${part}`);
  const plain = { ...target, paint: target.paint?.filter((l) => l.kind !== 'decal') };
  const ink = (await inkPrints([print])).get(printKey(print));
  const decal = ink && printDecal(plain, print, ink);
  if (!decal) throw new Error(`${template}'s print set as nothing`);
  entries.push(
    `  ${JSON.stringify(template)}: ${JSON.stringify({ fingerprint: partFingerprint(plain), decal })},`,
  );
  console.log(`${template}: ${decal.w} × ${decal.h} on ${part}`);
}
writeFileSync(
  OUT,
  `import type { Decal } from './iso-item.js';

/** Starters' prints, set in type. Written by \`bun scripts/starter-prints.ts\`; don't edit. */
export const STARTER_DECALS: Record<string, { fingerprint: string; decal: Decal }> = {
${entries.join('\n')}
};
`,
);
console.log(`wrote ${OUT}`);
