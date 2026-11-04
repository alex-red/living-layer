import type { FixtureInput } from './fixture.js';
import type { IsoProp, IsoScene, IsoSceneKind, IsoTone } from './iso.js';
import { ISO_PRESETS } from './iso-presets.js';
import { foodDefaults } from './food.js';
import { cm, propModel, type PropPart } from './iso-furniture.js';
import { MAX_ITEM_PARTS, type ItemMaterial } from './iso-item.js';
import { PROP_TONES } from './iso-prop-sprite.js';
import { fromSculpt, type SculptPart } from './item-sculpt.js';

/**
 * A tube's least radius as a thing: a floor lamp's pole (2.5 cm), so a scanned
 * lamp's pole and arm still show a voxel wide in its sprite.
 */
const THIN_TUBE = cm(2.5);
const TONE_MATERIAL: Partial<Record<IsoTone, ItemMaterial>> = {
  wood: 'wood',
  steel: 'metal',
  fabric: 'fabric',
  glass: 'glass',
  appliance: 'gloss',
  screen: 'gloss',
  ceramic: 'gloss',
};

/**
 * A prop of the layout made a thing of its own: its group out of the scene,
 * and a fixture in its place with the furniture model the layout drew,
 * standing where it stood (on the surface below it, or the floor), so it
 * can be named, followed and keep stats. A lamp keeps its light. Null when
 * the scene has no such group, or nothing of it can be drawn as a model.
 */
export function promoteGroup(
  scene: IsoScene,
  group: string,
): { scene: IsoScene; fixture: FixtureInput } | null {
  const props = scene.props.filter((p) => p.group === group);
  if (!props.length) return null;
  const x0 = Math.min(...props.map((p) => p.at.x));
  const y0 = Math.min(...props.map((p) => p.at.y));
  const z0 = Math.min(...props.map((p) => p.at.z));
  const w = Math.max(...props.map((p) => p.at.x + p.size.w)) - x0;
  const d = Math.max(...props.map((p) => p.at.y + p.size.d)) - y0;
  const h = Math.max(...props.map((p) => p.at.z + p.size.h)) - z0;
  // Item space: the footprint's longer side is one unit.
  const L = Math.max(w, d);
  const parts: (SculptPart & { volume: number })[] = [];
  for (const p of props)
    for (const q of propModel(p) ?? [plainPart(p)]) {
      const at = { x: p.at.x + q.at.x - x0, y: p.at.y + q.at.y - y0, z: p.at.z + q.at.z - z0 };
      parts.push({
        id: shadeId(q.name) ?? `${q.shape}-${parts.length + 1}`,
        shape: q.shape,
        at: { x: at.x / L, y: at.y / L, z: at.z / L },
        size: { w: q.size.w / L, d: q.size.d / L, h: q.size.h / L },
        color: (q.color ?? PROP_TONES[q.tone]).toLowerCase(),
        material: q.material ?? TONE_MATERIAL[q.tone] ?? 'matte',
        profile: q.shape === 'lathe' ? q.profile : null,
        path: q.shape === 'tube' ? q.path : null,
        outline: null,
        radius:
          q.shape === 'tube'
            ? Math.max(q.radius ?? 0.05, THIN_TUBE) / L
            : q.shape === 'rbox'
              ? (q.radius ?? null)
              : null,
        rough: q.shape === 'blob' ? (q.rough ?? null) : null,
        wall: null,
        inside: null,
        bands: null,
        prints: null,
        volume: q.size.w * q.size.d * q.size.h,
      });
    }
  const kept = parts.sort((a, b) => b.volume - a.volume).slice(0, MAX_ITEM_PARTS);
  const head = props.find((p) => p.id === group) ?? props[0]!;
  const model = fromSculpt(head.label, { parts: kept.map(({ volume: _, ...s }) => s), note: '' });
  if (!model) return null;
  const ids = new Set(props.map((p) => p.id));
  const centre = { x: x0 + w / 2, y: y0 + d / 2 };
  const below = scene.surfaces.find(
    (s) =>
      !ids.has(s.propId) &&
      z0 > 0.05 &&
      Math.abs(s.z - z0) < 0.1 &&
      centre.x >= s.rect.x &&
      centre.x <= s.rect.x + s.rect.w &&
      centre.y >= s.rect.y &&
      centre.y <= s.rect.y + s.rect.d,
  );
  const lamp = props.find((p) => p.role === 'lamp');
  const light = lamp?.lightId;
  const clamp = (v: number) => Math.min(8, Math.max(0.1, v));
  return {
    scene: {
      ...scene,
      props: scene.props.filter((p) => !ids.has(p.id)),
      surfaces: scene.surfaces.filter((s) => !ids.has(s.propId)),
    },
    fixture: {
      label: head.label.slice(0, 40),
      scene: 'custom',
      surfaceId: below?.id ?? null,
      at: { x: x0, y: y0 },
      turns: 0,
      size: { w: clamp(w), d: clamp(d), h: clamp(h) },
      model: { label: model.label, parts: model.parts },
      reference: null,
      control: light?.startsWith('light.') ? { kind: 'light', entityId: light } : { kind: 'none' },
    },
  };
}

/**
 * A preset room's built-in thing (the fridge's milk) made a thing of its
 * own: a fixture in that room where it stood, which stands in for it. The
 * preset itself can't change, so the room is drawn without it
 * (`withoutPromoted`) while the fixture is there.
 */
export function promoteBuiltIn(
  kind: IsoSceneKind,
  group: string,
  /** Today as `YYYY-MM-DD`: food starts with its usual use-by day from it (`foodDefaults`). */
  today?: string,
): FixtureInput | null {
  const made = promoteGroup(ISO_PRESETS[kind], group);
  if (!made) return null;
  const food = today ? foodDefaults(made.fixture.label, today) : null;
  return { ...made.fixture, scene: kind, builtIn: group, ...(food ? { food } : {}) };
}
/** A preset room without the built-in things its fixtures stand in for. */
export function withoutPromoted(
  scene: IsoScene,
  fixtures: readonly { scene: string; builtIn?: string | undefined }[] = [],
): IsoScene {
  const taken = new Set(
    fixtures.flatMap((f) => (f.scene === scene.kind && f.builtIn ? [f.builtIn] : [])),
  );
  if (!taken.size) return scene;
  const gone = new Set(scene.props.filter((p) => taken.has(p.group)).map((p) => p.id));
  return {
    ...scene,
    props: scene.props.filter((p) => !gone.has(p.id)),
    surfaces: scene.surfaces.filter((s) => !gone.has(s.propId)),
  };
}

/**
 * A scanned part named as a shade (`top-shade`, `shade`) as a light source's
 * id (`shade-top`, `shade`), so each of a lamp's shades can switch its own light.
 */
function shadeId(name: string | undefined): string | null {
  const words =
    name
      ?.toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean) ?? [];
  if (!words.includes('shade')) return null;
  const rest = words.filter((w) => w !== 'shade');
  return (rest.length ? `shade-${rest.join('-')}` : 'shade').slice(0, 24);
}

/** A prop with no model of its own: its box, or a straight lathe for a cylinder. */
function plainPart(p: IsoProp): PropPart {
  const base = { at: { x: 0, y: 0, z: 0 }, size: p.size, tone: p.tone };
  return p.shape === 'cylinder'
    ? {
        ...base,
        shape: 'lathe',
        profile: [
          { r: 1, z: 0 },
          { r: 1, z: 1 },
        ],
      }
    : { ...base, shape: 'rbox', radius: 0.08 };
}
