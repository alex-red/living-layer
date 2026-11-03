/**
 * A colour audit of props as the room draws them: pixels in a colour from a
 * tone none of the prop's parts uses. A metal highlight that snaps to the
 * cream of paper (white specks on a chair's hub) or a see-through material
 * that comes out black shows up here before anyone has to spot it.
 * Report-only: `bun run sheet --audit` and `bun run verify` print it.
 */
import {
  TONE_PALETTE,
  hexLab,
  propModel,
  renderPropSprite,
  type IsoProp,
  type IsoTone,
} from '@livinglayer/domain';

export interface Audit {
  name: string;
  pixels: number;
  /** Pixels per tone the prop doesn't use, most first. */
  foreign: [IsoTone, number][];
  /** Foreign pixels much lighter than anything else in the prop: specks. */
  specks: number;
}
/** Which tones a palette colour belongs to. */
const owners = new Map<string, Set<IsoTone>>();
for (const [tone, hexes] of Object.entries(TONE_PALETTE) as [IsoTone, string[]][])
  for (const hex of hexes) owners.set(hex, new Set([...(owners.get(hex) ?? []), tone]));
const hexOf = (r: Uint8ClampedArray, i: number) =>
  `#${[0, 1, 2].map((k) => r[i + k]!.toString(16).padStart(2, '0')).join('')}`;

export function auditProps(name: string, props: IsoProp[]): Audit {
  const foreign = new Map<IsoTone, number>();
  let pixels = 0;
  let specks = 0;
  for (const prop of props) {
    const own = new Set(propModel(prop)?.map((p) => p.tone) ?? [prop.tone]);
    // The lightest colour the prop's own tones can be: anything well above it is a speck.
    const ceiling = Math.max(...[...own].flatMap((t) => TONE_PALETTE[t].map((h) => hexLab(h)[0])));
    const s = renderPropSprite(prop, false);
    for (let i = 0; i < s.rgba.length; i += 4) {
      if (s.rgba[i + 3]! < 255) continue;
      pixels++;
      const hex = hexOf(s.rgba, i);
      const tones = owners.get(hex);
      if (!tones || [...tones].some((t) => own.has(t))) continue;
      const tone = [...tones][0]!;
      foreign.set(tone, (foreign.get(tone) ?? 0) + 1);
      if (hexLab(hex)[0] > ceiling + 0.08) specks++;
    }
  }
  return { name, pixels, foreign: [...foreign].sort((a, b) => b[1] - a[1]), specks };
}
/**
 * Highlights we mean, by template: listed with the reason, they're shown
 * but not flagged. Dark foreign pixels never are: a shade snapping to a
 * neighbouring dark tone (wood's shadow to soil) is how the palette works.
 */
const MEANT: Record<string, string> = {
  lamp: "the shade's gloss highlight, as in the reference",
  fridge: "the glass door bins' glint, a pixel or two at a corner",
};
/** One line per audit; flags a prop with specks it isn't meant to have. Returns how many. */
export function printAudit(audits: Audit[]) {
  console.log('\ncolour audit       pixels  foreign  specks  foreign tones');
  let flagged = 0;
  for (const a of audits) {
    const total = a.foreign.reduce((n, [, c]) => n + c, 0);
    const share = a.pixels ? total / a.pixels : 0;
    const meant = MEANT[a.name.split(' ')[0]!];
    const flag = a.specks >= 3 && !meant;
    if (flag) flagged++;
    console.log(
      [
        a.name.padEnd(18),
        String(a.pixels).padEnd(7),
        `${(share * 100).toFixed(1)}%`.padEnd(8),
        String(a.specks).padEnd(7),
        a.foreign
          .slice(0, 3)
          .map(([t, c]) => `${t} ${c}`)
          .join(', '),
        flag ? '  ← specks: look' : a.specks >= 3 && meant ? `  (meant: ${meant})` : '',
      ].join(' '),
    );
  }
  console.log(
    "(foreign: pixels in a tone the prop doesn't use; specks: those much lighter than its own tones)",
  );
  return flagged;
}
