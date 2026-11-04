/**
 * One way to get a Thing's model for a script, from wherever it is kept:
 *
 *   fixture:<id|label>         a fixture or tracked object in desk memory (`--mode`, live by default)
 *   fixture:<id|label>@<state> one of its states' models (`expandStates` lists them all)
 *   draft:<id|label>:<n>       one of its earlier models, newest first (0 is the last replaced)
 *   save:<name>:<id|label>     the same fixture in a named save
 *   run:<id|latest>            the model a fit, fixture or sculpt run made
 *   starter:<template>[:state] a starter, as the Add fixture panel builds it
 *   stock:<label>              what a thing of that name is drawn as before it is modelled
 *   <file>.json                an item, a saved item, or Spark's sculpt (its prints set in type)
 *   <file>.ts                  a module whose default export is an item (or a promise of one)
 *
 * Every source comes back as a plain `IsoItem` with a name for its picture.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import sharp from 'sharp';
import {
  STARTER_TEMPLATES,
  detailResolution,
  ISO_TILE,
  ITEM_SPRITES,
  roomSpriteLook,
  fromSculpt,
  renderSprite,
  sculptPrints,
  voxelize,
  starterTemplateModel,
  stockModel,
  storedItem,
  type DeskMemory,
  type Fixture,
  type IsoItem,
  type ItemSpritePreset,
  type Mode,
  type Sculpt,
  type Sprite,
  type StarterTemplate,
} from '@livinglayer/domain';
import { inkPrints } from '../../apps/server/src/print-ink.js';
import { dataDir, openEvidence } from './evidence.js';
import type { Share } from './image.js';

export interface LoadedModel {
  /** A short name for the picture and the file. */
  name: string;
  item: IsoItem;
  /** Its box in the room, in tiles, when it is a fixture: the room draws it at its width. */
  size?: { w: number; d: number; h: number };
}

const SOURCES =
  'fixture:<id|label>, draft:<id|label>:<n>, save:<name>:<id|label>, run:<id>, starter:<template>, stock:<label>, <file>.json or <file>.ts';

export function fixtureIn(memory: DeskMemory | undefined, ref: string): Fixture {
  const all = memory?.fixtures ?? [];
  const want = ref.toLowerCase();
  const found =
    all.find((f) => f.id === ref || f.id.startsWith(ref)) ??
    all.find((f) => f.label.toLowerCase() === want) ??
    all.find((f) => f.label.toLowerCase().includes(want));
  if (!found)
    throw new Error(
      `No fixture "${ref}"; there are: ${all.map((f) => f.label).join(', ') || 'none'}`,
    );
  return found;
}
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'model';

/** A JSON model of any shape we keep: an item, a saved item, or a sculpt. */
async function fromJson(raw: unknown, name: string): Promise<IsoItem> {
  const obj = raw as { label?: string; parts?: unknown[]; note?: string };
  if (!Array.isArray(obj.parts)) throw new Error(`${name}: no parts`);
  if (typeof obj.note === 'string') {
    const sculpt = obj as Sculpt;
    const item = fromSculpt(obj.label ?? name, sculpt, await inkPrints(sculptPrints(sculpt)));
    if (!item) throw new Error(`${name}: no part of the sculpt is usable`);
    return item;
  }
  return storedItem({ label: obj.label ?? name, parts: obj.parts });
}

/** `label@state` as its label and state; no state for a plain label. */
function splitState(ref: string): [string, string | null] {
  const at = ref.lastIndexOf('@');
  return at > 0 ? [ref.slice(0, at), ref.slice(at + 1)] : [ref, null];
}
/**
 * A source and, for a fixture, one source for each of its states, so a
 * picture shows them side by side; any other source as it is.
 */
export function expandStates(source: string, { mode = 'live' }: { mode?: Mode } = {}): string[] {
  if (!source.startsWith('fixture:') || source.includes('@')) return [source];
  const ev = openEvidence();
  try {
    const f = fixtureIn(ev.memory(mode), source.slice('fixture:'.length));
    return [source, ...Object.keys(f.states ?? {}).map((s) => `${source}@${s}`)];
  } finally {
    ev.close();
  }
}
export async function loadModel(
  source: string,
  { mode = 'live' }: { mode?: Mode } = {},
): Promise<LoadedModel> {
  const [kind, ...rest] = source.split(':');
  const arg = rest.join(':');
  if (source.endsWith('.json') && existsSync(source))
    return {
      name: slug(basename(source, '.json')),
      item: await fromJson(JSON.parse(readFileSync(source, 'utf8')), basename(source)),
    };
  if (source.endsWith('.ts') && existsSync(source)) {
    const mod = (await import(resolve(source))) as { default: IsoItem | Promise<IsoItem> };
    return { name: slug(basename(source, '.ts')), item: storedItem(await mod.default) };
  }
  switch (kind) {
    case 'fixture':
    case 'draft': {
      const ev = openEvidence();
      try {
        const [ref, n] =
          kind === 'draft' ? [arg.replace(/:\d+$/, ''), arg.match(/:(\d+)$/)?.[1]] : [arg];
        if (kind === 'fixture') {
          const [label, state] = splitState(ref!);
          const f = fixtureIn(ev.memory(mode), label);
          if (!state) return { name: slug(f.label), item: storedItem(f.model), size: f.size };
          const s = f.states?.[state];
          if (!s)
            throw new Error(
              `${f.label} has no state "${state}"; it has: ${Object.keys(f.states ?? {}).join(', ') || 'none'}`,
            );
          return {
            name: slug(`${f.label}-${state}`),
            item: storedItem(s.model),
            size: s.size ?? f.size,
          };
        }
        const f = fixtureIn(ev.memory(mode), ref!);
        const drafts = [...(f.drafts ?? [])].reverse();
        const d = drafts[Number(n ?? 0)];
        if (!d) throw new Error(`${f.label} has ${drafts.length} earlier models`);
        return { name: `${slug(f.label)}-draft-${n ?? 0}`, item: storedItem(d.model) };
      } finally {
        ev.close();
      }
    }
    case 'save': {
      const [saveName, ref] = [
        arg.slice(0, arg.lastIndexOf(':')),
        arg.slice(arg.lastIndexOf(':') + 1),
      ];
      const db = new Database(resolve(dataDir(), 'livinglayer.sqlite'), { readonly: true });
      try {
        const row = db
          .query<{ payload: string }, [string]>('SELECT payload FROM saves WHERE name = ?1')
          .get(saveName);
        if (!row) throw new Error(`No save "${saveName}"`);
        const save = JSON.parse(row.payload) as { desks: Partial<Record<Mode, DeskMemory>> };
        const f = fixtureIn(save.desks[mode], ref);
        return { name: `${slug(saveName)}-${slug(f.label)}`, item: storedItem(f.model) };
      } finally {
        db.close();
      }
    }
    case 'run': {
      const ev = openEvidence();
      try {
        const run = ev.run<{ item?: IsoItem; model?: IsoItem }>(arg || 'latest');
        const item = run.output?.item ?? run.output?.model;
        if (!item?.parts) throw new Error(`Run ${run.id} (${run.kind}) made no model`);
        return { name: `run-${run.id.slice(0, 8)}`, item: storedItem(item) };
      } finally {
        ev.close();
      }
    }
    case 'starter': {
      const [template, state] = arg.split(':');
      if (!STARTER_TEMPLATES.includes(template as StarterTemplate))
        throw new Error(`No starter "${template}"; there are: ${STARTER_TEMPLATES.join(', ')}`);
      const item = starterTemplateModel(template as StarterTemplate, { state: state ?? null });
      return { name: slug(`${template}${state ? `-${state}` : ''}`), item: storedItem(item) };
    }
    case 'stock':
      return { name: `stock-${slug(arg)}`, item: storedItem(stockModel(arg || 'Mug')) };
    default:
      throw new Error(`Don't know the model "${source}": use ${SOURCES}`);
  }
}

export interface SpriteLook {
  preset?: ItemSpritePreset;
  /** Overrides of the preset's numbers. */
  scale?: number;
  resolution?: number;
  /** Iso pixels per sprite pixel: 1, as the app draws. */
  pixel?: number;
  finish?: 'clean' | 'pixel';
  shadow?: boolean;
  /** Whole-pixel zoom; by default, as many as fit `cell` pixels tall. */
  zoom?: number;
  cell?: number;
  /** Keep only around these parts (by id), or a share of the picture (`x0,y0,x1,y1`). */
  focus?: readonly string[] | Share;
}
/** How much room is left around focused parts, as a share of their own size. */
const FOCUS_MARGIN = 0.2;
/** The sprite pixels the parts named `ids` draw, with a margin; the whole sprite when none shows. */
function partsBox(s: Sprite, item: IsoItem, ids: readonly string[]) {
  const want = new Set(item.parts.flatMap((p, i) => (ids.includes(p.id) ? [i] : [])));
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++)
      if (want.has(s.owner[x + y * s.width]!)) {
        [x0, y0] = [Math.min(x0, x), Math.min(y0, y)];
        [x1, y1] = [Math.max(x1, x + 1), Math.max(y1, y + 1)];
      }
  if (x1 < 0) return { left: 0, top: 0, width: s.width, height: s.height };
  const m = Math.ceil(Math.max(x1 - x0, y1 - y0) * FOCUS_MARGIN);
  const left = Math.max(0, x0 - m);
  const top = Math.max(0, y0 - m);
  return {
    left,
    top,
    width: Math.min(s.width, x1 + m) - left,
    height: Math.min(s.height, y1 + m) - top,
  };
}
/** A model drawn as the app draws it at a preset, enlarged by whole pixels, on white. */
export async function spritePng(
  item: IsoItem,
  look: SpriteLook = {},
): Promise<{ png: Buffer; width: number; height: number }> {
  const preset = ITEM_SPRITES[look.preset ?? 'editor'] as { scale?: number; resolution: number };
  const scale = look.scale ?? preset.scale ?? 3;
  // In the room, as the room draws it at fit: a detailed model finer (`roomSpriteLook`).
  const room =
    look.preset === 'room' ? roomSpriteLook(item.parts, scale * ISO_TILE.width, 1) : null;
  const s = renderSprite(
    voxelize(item.parts, {
      resolution: detailResolution(
        item.parts,
        look.resolution ?? room?.resolution ?? preset.resolution,
      ),
    }),
    {
      scale,
      pixel: look.pixel ?? room?.pixel ?? 1,
      finish: look.finish ?? 'clean',
      shadow: look.shadow ?? false,
    },
  );
  const share = look.focus && typeof look.focus[0] === 'number' ? (look.focus as Share) : null;
  const box = share
    ? {
        left: Math.floor(share[0] * s.width),
        top: Math.floor(share[1] * s.height),
        width: Math.max(1, Math.ceil((share[2] - share[0]) * s.width)),
        height: Math.max(1, Math.ceil((share[3] - share[1]) * s.height)),
      }
    : look.focus
      ? partsBox(s, item, look.focus as readonly string[])
      : { left: 0, top: 0, width: s.width, height: s.height };
  box.width = Math.min(box.width, s.width - box.left);
  box.height = Math.min(box.height, s.height - box.top);
  const zoom = look.zoom ?? Math.max(1, Math.floor((look.cell ?? 360) / box.height));
  const png = await sharp(Buffer.from(s.rgba), {
    raw: { width: s.width, height: s.height, channels: 4 },
  })
    .extract(box)
    .resize({ width: box.width * zoom, kernel: 'nearest' })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  return { png, width: box.width, height: box.height };
}
