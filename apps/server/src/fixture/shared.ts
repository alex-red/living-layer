import {
  linkedFixtures,
  withNewModel,
  type SavedItem,
  type DeskMemory,
  type Fixture,
  type ProductFacts,
} from '@livinglayer/domain';
import sharp from 'sharp';
import { type EvidenceStore } from '../store.js';

/** The part of a photo around a box, with a margin, for Spark and for review. */
export async function around(
  png: Buffer,
  box: { left: number; top: number; right: number; bottom: number },
): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(png).metadata();
  const mx = Math.round((box.right - box.left) * 0.15);
  const my = Math.round((box.bottom - box.top) * 0.15);
  const left = Math.max(0, box.left - mx);
  const top = Math.max(0, box.top - my);
  return sharp(png)
    .extract({
      left,
      top,
      width: Math.min(width, box.right + mx) - left,
      height: Math.min(height, box.bottom + my) - top,
    })
    .png()
    .toBuffer();
}

/**
 * The photo a drafted room's pin was set on: the one it was drafted from, or
 * for rooms saved before that photo was kept, the one its picture was drawn
 * from. Null for preset rooms, whose photos aren't kept.
 */
export function roomPhotoBytes(memory: DeskMemory, store: EvidenceStore): Buffer | null {
  if (memory.surface?.scene !== 'custom') return null;
  const drawn = memory.illustration?.asset.split('/')[0];
  for (const asset of [
    memory.scenePhoto,
    drawn && `${drawn}/source.webp`,
    drawn && `${drawn}/source.png`,
  ]) {
    const bytes = asset ? store.readAsset(asset) : null;
    if (bytes) return bytes;
  }
  return null;
}

/**
 * The fixtures with a new model for this one and its linked copies in other
 * scenes: their current state's model when it has states, else their own,
 * the one it replaces kept as an earlier draft.
 */
export function withModel(fixtures: Fixture[], fixture: Fixture, model: SavedItem): Fixture[] {
  const group = new Set([fixture.id, ...linkedFixtures(fixtures, fixture).map((f) => f.id)]);
  const now = new Date().toISOString();
  return fixtures.map((f) => {
    if (!group.has(f.id)) return f;
    if (!fixture.state) return { ...withNewModel(f, model, now), updatedAt: now };
    const state = fixture.state;
    return {
      ...f,
      states: { ...f.states, [state]: { ...f.states?.[state], model } },
      updatedAt: now,
    };
  });
}

export type Parsed<S extends { parse: (data: unknown) => unknown }> = ReturnType<S['parse']>;

/**
 * A looked-up product's size in tiles, laid the way the fixture stands (its
 * longer side along its own longer side), when the lookup is sure enough of
 * it and it is a size a fixture can be. Null otherwise.
 */
export function productSize(
  facts: Pick<ProductFacts, 'sizeCm' | 'confidence'>,
  current: { w: number; d: number },
): { w: number; d: number; h: number } | null {
  const cm = facts.sizeCm;
  if (!cm || facts.confidence < 0.5) return null;
  const same = current.w >= current.d === cm.w >= cm.d;
  const t = { w: (same ? cm.w : cm.d) / 30, d: (same ? cm.d : cm.w) / 30, h: cm.h / 30 };
  return [t.w, t.d, t.h].every((v) => v >= 0.1 && v <= 8) ? t : null;
}
