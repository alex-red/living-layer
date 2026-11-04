/**
 * One way to get a Thing's model for a script, from wherever it is kept:
 *
 *   fixture:<id|label>         a fixture or tracked object in desk memory (`--mode`, live by default)
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
  ITEM_SPRITES,
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
  type StarterTemplate,
} from '@livinglayer/domain';
import { inkPrints } from '../../apps/server/src/print-ink.js';
import { dataDir, openEvidence } from './evidence.js';

export interface LoadedModel {
  /** A short name for the picture and the file. */
  name: string;
  item: IsoItem;
}

const SOURCES =
  'fixture:<id|label>, draft:<id|label>:<n>, save:<name>:<id|label>, run:<id>, starter:<template>, stock:<label>, <file>.json or <file>.ts';

function fixtureIn(memory: DeskMemory | undefined, ref: string): Fixture {
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
        const f = fixtureIn(ev.memory(mode), ref!);
        if (kind === 'fixture') return { name: slug(f.label), item: storedItem(f.model) };
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
}
/** A model drawn as the app draws it at a preset, enlarged by whole pixels, on white. */
export async function spritePng(
  item: IsoItem,
  look: SpriteLook = {},
): Promise<{ png: Buffer; width: number; height: number }> {
  const preset = ITEM_SPRITES[look.preset ?? 'editor'] as { scale?: number; resolution: number };
  const s = renderSprite(
    voxelize(item.parts, {
      resolution: detailResolution(item.parts, look.resolution ?? preset.resolution),
    }),
    {
      scale: look.scale ?? preset.scale ?? 3,
      pixel: look.pixel ?? 1,
      finish: look.finish ?? 'clean',
      shadow: look.shadow ?? false,
    },
  );
  const zoom = look.zoom ?? Math.max(1, Math.floor((look.cell ?? 360) / s.height));
  const png = await sharp(Buffer.from(s.rgba), {
    raw: { width: s.width, height: s.height, channels: 4 },
  })
    .resize({ width: s.width * zoom, kernel: 'nearest' })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  return { png, width: s.width, height: s.height };
}
