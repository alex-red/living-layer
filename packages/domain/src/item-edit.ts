import type { IsoItem } from './iso-item.js';

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
 * request paints the parts it names ("make the handle red"), else every part
 * ("paint it blue"). Null for anything else, which only Spark can do.
 */
export function demoEdit(item: IsoItem, request: string): { item: IsoItem; note: string } | null {
  const words = request.toLowerCase();
  const colour = Object.keys(COLOURS).find((c) => said(words, c));
  if (!colour) return null;
  const named = item.parts.filter((p) => !p.locked && said(words, p.id.toLowerCase()));
  const painted = new Set(
    (named.length ? named : item.parts.filter((p) => !p.locked)).map((p) => p.id),
  );
  if (!painted.size) return null;
  return {
    item: {
      ...item,
      parts: item.parts.map((p) => (painted.has(p.id) ? { ...p, color: COLOURS[colour]! } : p)),
    },
    note: named.length
      ? `Painted the ${named.map((p) => p.id).join(' and ')} ${colour}.`
      : `Painted it ${colour}.`,
  };
}
