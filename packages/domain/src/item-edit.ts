import type { IsoItem } from './iso-item.js';
import { renderSprite, voxelize, type Sprite } from './iso-voxel.js';
import { detailResolution, ITEM_SPRITES } from './sprite-presets.js';

/** The colours the demo's edits know by name. */
const COLOURS: Record<string, string> = {
  red: '#c8423b',
  orange: '#e07b2e',
  yellow: '#e8c33a',
  green: '#4f9a55',
  blue: '#3d6fc4',
  purple: '#7d55b5',
  pink: '#e08aa8',
  brown: '#7a5233',
  black: '#26262b',
  white: '#f2f0ea',
  grey: '#8d8f96',
  gray: '#8d8f96',
};
const said = (words: string, name: string) =>
  new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\b`).test(words);

/**
 * The demo's answer to an AI edit, with no model call: a colour named in the
 * request paints the parts it names ("make the handle red"), else the parts
 * the person brushed (`focus`), else every part ("paint it blue"). Null for
 * anything else, which only Spark can do.
 */
export function demoEdit(
  item: IsoItem,
  request: string,
  focus: readonly string[] = [],
): { item: IsoItem; note: string } | null {
  const words = request.toLowerCase();
  const colour = Object.keys(COLOURS).find((c) => said(words, c));
  if (!colour) return null;
  const open = item.parts.filter((p) => !p.locked);
  const named = open.filter((p) => said(words, p.id.toLowerCase()));
  const brushed = open.filter((p) => focus.includes(p.id));
  const chosen = named.length ? named : brushed;
  const painted = new Set((chosen.length ? chosen : open).map((p) => p.id));
  if (!painted.size) return null;
  return {
    item: {
      ...item,
      parts: item.parts.map((p) => (painted.has(p.id) ? { ...p, color: COLOURS[colour]! } : p)),
    },
    note: chosen.length
      ? `Painted the ${chosen.map((p) => p.id).join(' and ')} ${colour}.`
      : `Painted it ${colour}.`,
  };
}

/** A model as the editor draws it, without its shadow. */
function editorSprite({ parts }: IsoItem): Sprite {
  const { scale, resolution } = ITEM_SPRITES.editor;
  return renderSprite(voxelize(parts, { resolution: detailResolution(parts, resolution) }), {
    scale,
    finish: 'clean',
    shadow: false,
  });
}
/**
 * Whether an edit changes the model as the editor draws it. An edit can change
 * parts and still move no voxel (a floor lamp's base given a rounder edge a
 * fraction of a voxel deep), which the editor would show as nothing done.
 */
function editShows(before: IsoItem, after: IsoItem): boolean {
  const a = editorSprite(before);
  const b = editorSprite(after);
  if (a.width !== b.width || a.height !== b.height || a.x !== b.x || a.y !== b.y) return true;
  for (let i = 0; i < a.rgba.length; i++) if (a.rgba[i] !== b.rgba[i]) return true;
  return false;
}
/**
 * What an edit says it did: its own note, unless it changed parts the editor
 * draws no differently, which it says rather than claim a change no one sees.
 * Parts given back unchanged keep the note, which says why.
 */
export function editNote(before: IsoItem, after: IsoItem, note: string): string {
  if (JSON.stringify(before.parts) === JSON.stringify(after.parts) || editShows(before, after))
    return note;
  return `${note.replace(/\.?\s*$/, '.')} Nothing changed that shows at this size: ask for a bigger change, or one to a larger part.`;
}
