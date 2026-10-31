import { z } from 'zod';
import type { IsoBox, IsoProp, IsoScene, IsoSurface } from './iso.js';
import { cm, furnitureSpec, type PropForm } from './iso-furniture.js';

/**
 * The prop palette: every preset, every scene a person builds and every
 * scene Spark drafts is made of these. One placed template is a group whose
 * props and surfaces share its id as a prefix and move, turn and go together.
 */
type Built = { props: IsoProp[]; surfaces: IsoSurface[] };
interface Template {
  label: string;
  /** Default footprint in tiles; some templates take another one. */
  size: { w: number; d: number };
  /** Sits on whatever surface is below it instead of the floor. */
  onTop: boolean;
  build: (g: string, x: number, y: number, z: number, size: { w: number; d: number }) => Built;
}

const part = (
  shape: IsoProp['shape'],
  g: string,
  id: string,
  label: string,
  at: [number, number, number],
  size: [number, number, number],
  tone: IsoProp['tone'],
  extra: Partial<IsoProp> = {},
): IsoProp => ({
  id: id ? `${g}:${id}` : g,
  label,
  shape,
  group: g,
  at: { x: at[0], y: at[1], z: at[2] },
  size: { w: size[0], d: size[1], h: size[2] },
  tone,
  ...extra,
});
const prism = (...a: Parameters<typeof part> extends [unknown, ...infer R] ? R : never) =>
  part('prism', ...a);
const cylinder = (...a: Parameters<typeof part> extends [unknown, ...infer R] ? R : never) =>
  part('cylinder', ...a);
const surface = (
  g: string,
  id: string,
  label: string,
  propId: string,
  rect: IsoSurface['rect'],
  z: number,
): IsoSurface => ({ id: `${g}:${id}`, label, propId, rect, z });

/** How tall a form stands, from its measurements (see FURNITURE_SPECS). */
const tall = (form: PropForm) => cm(furnitureSpec(form).heightCm);
/**
 * One prop drawn as a furniture model, plus the surface on its top if it
 * has one. Sizes are real (see `cm`): a desk top stands at 72 cm.
 */
function modelled(
  label: string,
  form: PropForm,
  tone: IsoProp['tone'],
  top?: string,
): Template['build'] {
  return (g, x, y, z, { w, d }) => {
    const h = tall(form);
    return {
      props: [prism(g, '', label, [x, y, z], [w, d, h], tone, { form })],
      surfaces: top ? [surface(g, 'top', top, g, { x, y, w, d }, z + h)] : [],
    };
  };
}

export const PROP_TEMPLATES = {
  desk: {
    label: 'Desk',
    size: { w: 4, d: 2.5 },
    onTop: false,
    build: modelled('Desk', 'desk', 'wood', 'Desktop'),
  },
  table: {
    label: 'Table',
    size: { w: 3, d: 3 },
    onTop: false,
    build: modelled('Table', 'table', 'wood', 'Table top'),
  },
  chair: {
    label: 'Chair',
    size: { w: cm(66), d: cm(66) },
    onTop: false,
    build: modelled('Chair', 'chair', 'fabric'),
  },
  shelf: {
    label: 'Bookshelf',
    size: { w: cm(80), d: cm(30) },
    onTop: false,
    build: modelled('Bookshelf', 'bookcase', 'wood', 'Bookshelf top'),
  },
  cabinet: {
    label: 'Cabinet',
    size: { w: cm(60), d: cm(40) },
    onTop: false,
    build: modelled('Cabinet', 'cabinet', 'wood', 'Cabinet top'),
  },
  // The fridge opens toward +y with its door swung out on the left, so its
  // shelves read like a photo taken into it: back at the top of the frame.
  fridge: {
    label: 'Fridge',
    size: { w: 3, d: 2.6 },
    onTop: false,
    build: (g, x, y, z0, { w, d }) => {
      const h = 6;
      const wall = 0.15;
      const inner = { x: x + wall, y: y + wall, w: w - 2 * wall, d: d - wall };
      const shelves = (
        [
          ['shelf-1', 'Top shelf', 4.2],
          ['shelf-2', 'Middle shelf', 2.7],
          ['shelf-3', 'Crisper lid', 1.25],
        ] as const
      ).map(([id, label, top]) => ({
        prop: prism(
          g,
          id,
          label,
          [inner.x, inner.y, z0 + top - 0.08],
          [inner.w, inner.d, 0.08],
          'glass',
        ),
        surface: surface(g, id, label, `${g}:${id}`, { ...inner }, z0 + top),
      }));
      return {
        props: [
          prism(g, 'back', 'Fridge back', [x, y, z0], [w, wall, h], 'appliance'),
          prism(g, 'left', 'Fridge side', [x, y + wall, z0], [wall, d - wall, h], 'appliance'),
          prism(g, '', 'Fridge base', [inner.x, inner.y, z0], [inner.w, inner.d, 0.3], 'appliance'),
          prism(
            g,
            'crisper',
            'Crisper drawer',
            [inner.x + 0.1, inner.y + 0.1, z0 + 0.3],
            [inner.w - 0.2, inner.d - 0.2, 0.85],
            'glass',
          ),
          ...shelves.map((s) => s.prop),
          // The fridge's own light, under the top: a lamp like any other.
          cylinder(
            g,
            'light',
            'Fridge light',
            [x + w / 2 - 0.3, y + 0.3, z0 + h - 0.35],
            [0.6, 0.6, 0.2],
            'appliance',
            { role: 'lamp' },
          ),
          prism(
            g,
            'top',
            'Fridge top',
            [x + wall, y + wall, z0 + h - wall],
            [w - wall, d - wall, wall],
            'appliance',
          ),
          prism(
            g,
            'right',
            'Fridge side',
            [x + w - wall, y + wall, z0],
            [wall, d - wall, h - wall],
            'appliance',
          ),
          prism(g, 'door', 'Open door', [x - 0.2, y + d, z0], [0.2, 2.8, h], 'appliance'),
        ],
        surfaces: shelves.map((s) => s.surface),
      };
    },
  },
  // A floor plant: a 30 cm pot, the leaves above it.
  plant: {
    label: 'Plant',
    size: { w: cm(48), d: cm(48) },
    onTop: false,
    build: (g, x, y, z, { w, d }) => {
      const pot = Math.min(w, d, cm(furnitureSpec('pot').widthCm));
      const potH = tall('pot');
      return {
        props: [
          prism(
            g,
            'pot',
            'Plant pot',
            [x + (w - pot) / 2, y + (d - pot) / 2, z],
            [pot, pot, potH],
            'ceramic',
            { form: 'pot' },
          ),
          prism(g, '', 'Plant', [x, y, z + potH], [w, d, tall('foliage')], 'plant', {
            form: 'foliage',
          }),
        ],
        surfaces: [],
      };
    },
  },
  rug: {
    label: 'Rug',
    size: { w: 3, d: 2 },
    onTop: false,
    build: (g, x, y, z, { w, d }) => ({
      props: [prism(g, '', 'Rug', [x, y, z], [w, d, 0.03], 'fabric')],
      surfaces: [],
    }),
  },
  wall: {
    label: 'Wall',
    size: { w: 6, d: 0.2 },
    onTop: false,
    build: (g, x, y, z, { w, d }) => ({
      props: [prism(g, '', 'Wall', [x, y, z], [w, d, 5], 'wall')],
      surfaces: [],
    }),
  },
  // A 16 cm base, a pole and a 20 cm shade that lights up.
  lamp: {
    label: 'Desk lamp',
    size: { w: cm(20), d: cm(20) },
    onTop: true,
    build: (g, x, y, z, { w, d }) => {
      const base = Math.min(w, d, cm(furnitureSpec('lamp-stand').baseCm));
      const pole = tall('lamp-stand');
      return {
        props: [
          prism(
            g,
            'stand',
            'Lamp stand',
            [x + (w - base) / 2, y + (d - base) / 2, z],
            [base, base, pole],
            'steel',
            { form: 'lamp-stand' },
          ),
          prism(g, '', 'Desk lamp', [x, y, z + pole], [w, d, tall('lamp-shade')], 'steel', {
            role: 'lamp',
            form: 'lamp-shade',
          }),
        ],
        surfaces: [],
      };
    },
  },
  monitor: {
    label: 'Monitor',
    size: { w: cm(61), d: cm(20) },
    onTop: true,
    build: modelled('Monitor', 'monitor', 'appliance'),
  },
  keyboard: {
    label: 'Keyboard',
    size: { w: cm(44), d: cm(14) },
    onTop: true,
    build: modelled('Keyboard', 'keyboard', 'appliance'),
  },
  book: {
    label: 'Book',
    size: { w: cm(16), d: cm(23) },
    onTop: true,
    build: modelled('Book', 'book', 'book'),
  },
  bottle: {
    label: 'Bottle',
    size: { w: cm(7.5), d: cm(7.5) },
    onTop: true,
    build: modelled('Bottle', 'bottle', 'glass'),
  },
  jar: {
    label: 'Jar',
    size: { w: cm(10), d: cm(10) },
    onTop: true,
    build: modelled('Jar', 'jar', 'ceramic'),
  },
  carton: {
    label: 'Carton',
    size: { w: cm(7), d: cm(7) },
    onTop: true,
    build: modelled('Carton', 'carton', 'paper'),
  },
} satisfies Record<string, Template>;
export type TemplateId = keyof typeof PROP_TEMPLATES;
export const TEMPLATE_IDS = Object.keys(PROP_TEMPLATES) as [TemplateId, ...TemplateId[]];

/**
 * Place a template as group `g` with its back-left corner at (x, y), at height
 * z. Extra fields (a label, optional, a light) apply to every prop it makes.
 */
export function placeTemplate(
  id: TemplateId,
  g: string,
  x: number,
  y: number,
  z = 0,
  options: { size?: { w: number; d: number }; label?: string; optional?: boolean } = {},
): Built {
  const t: Template = PROP_TEMPLATES[id];
  const built = t.build(g, x, y, z, options.size ?? t.size);
  return {
    props: built.props.map((p) => ({
      ...p,
      template: id,
      ...(options.label && p.id === g ? { label: options.label } : {}),
      ...(options.optional ? { optional: true } : {}),
    })),
    surfaces: built.surfaces,
  };
}

const EPS = 1e-6;
const groupProps = (scene: IsoScene, g: string) => scene.props.filter((p) => p.group === g);
export function groupIds(scene: IsoScene): string[] {
  return [...new Set(scene.props.map((p) => p.group))];
}
/** The box around every prop of a group. */
export function groupBounds(scene: IsoScene, g: string): IsoBox | null {
  const props = groupProps(scene, g);
  if (!props.length) return null;
  const x0 = Math.min(...props.map((p) => p.at.x));
  const y0 = Math.min(...props.map((p) => p.at.y));
  const z0 = Math.min(...props.map((p) => p.at.z));
  const x1 = Math.max(...props.map((p) => p.at.x + p.size.w));
  const y1 = Math.max(...props.map((p) => p.at.y + p.size.d));
  const z1 = Math.max(...props.map((p) => p.at.z + p.size.h));
  return { at: { x: x0, y: y0, z: z0 }, size: { w: x1 - x0, d: y1 - y0, h: z1 - z0 } };
}
function mapGroup(
  scene: IsoScene,
  g: string,
  prop: (p: IsoProp) => IsoProp,
  surf: (s: IsoSurface) => IsoSurface,
): IsoScene {
  const own = new Set(groupProps(scene, g).map((p) => p.id));
  return {
    ...scene,
    props: scene.props.map((p) => (p.group === g ? prop(p) : p)),
    surfaces: scene.surfaces.map((s) => (own.has(s.propId) ? surf(s) : s)),
  };
}
/** Move a group by (dx, dy, dz), kept inside the grid. */
export function moveGroup(scene: IsoScene, g: string, dx: number, dy: number, dz = 0): IsoScene {
  const b = groupBounds(scene, g);
  if (!b) return scene;
  const cx = Math.max(-b.at.x, Math.min(scene.grid.w - b.at.x - b.size.w, dx));
  const cy = Math.max(-b.at.y, Math.min(scene.grid.d - b.at.y - b.size.d, dy));
  return mapGroup(
    scene,
    g,
    (p) => ({ ...p, at: { x: p.at.x + cx, y: p.at.y + cy, z: p.at.z + dz } }),
    (s) => ({ ...s, rect: { ...s.rect, x: s.rect.x + cx, y: s.rect.y + cy }, z: s.z + dz }),
  );
}
/** Turn a group a quarter clockwise (seen from above) about its footprint's centre. */
export function rotateGroup(scene: IsoScene, g: string): IsoScene {
  const b = groupBounds(scene, g);
  if (!b) return scene;
  const cx = b.at.x + b.size.w / 2;
  const cy = b.at.y + b.size.d / 2;
  // (x, y) → (cx - (y - cy), cy + (x - cx)), applied to a box's far corner.
  const turn = (x: number, y: number, w: number, d: number) => ({
    x: cx - (y + d - cy),
    y: cy + (x - cx),
    w: d,
    d: w,
  });
  const turned = mapGroup(
    scene,
    g,
    (p) => {
      const r = turn(p.at.x, p.at.y, p.size.w, p.size.d);
      return {
        ...p,
        at: { ...p.at, x: r.x, y: r.y },
        size: { ...p.size, w: r.w, d: r.d },
        ...(p.form ? { turns: ((p.turns ?? 0) + 1) % 4 } : {}),
      };
    },
    (s) => {
      const r = turn(s.rect.x, s.rect.y, s.rect.w, s.rect.d);
      return { ...s, rect: { x: r.x, y: r.y, w: r.w, d: r.d } };
    },
  );
  // Turning can push a long group past the edge; nudge it back in.
  return moveGroup(turned, g, 0, 0);
}
export function removeGroup(scene: IsoScene, g: string): IsoScene {
  const gone = new Set(groupProps(scene, g).map((p) => p.id));
  return {
    ...scene,
    props: scene.props.filter((p) => p.group !== g),
    surfaces: scene.surfaces.filter((s) => !gone.has(s.propId)),
  };
}
/** The top of the highest surface under a footprint's centre, not counting the group itself. */
export function surfaceUnder(scene: IsoScene, box: IsoBox, except?: string): number {
  const cx = box.at.x + box.size.w / 2;
  const cy = box.at.y + box.size.d / 2;
  const own = new Set(except ? groupProps(scene, except).map((p) => p.id) : []);
  return Math.max(
    0,
    ...scene.surfaces
      .filter(
        (s) =>
          !own.has(s.propId) &&
          cx >= s.rect.x - EPS &&
          cx <= s.rect.x + s.rect.w + EPS &&
          cy >= s.rect.y - EPS &&
          cy <= s.rect.y + s.rect.d + EPS,
      )
      .map((s) => s.z),
  );
}
/** Drop a tabletop group onto whatever is under it, or the floor. */
export function settleGroup(scene: IsoScene, g: string): IsoScene {
  const b = groupBounds(scene, g);
  const template = groupProps(scene, g)[0]?.template;
  if (!b || !template || !PROP_TEMPLATES[template].onTop) return scene;
  return moveGroup(scene, g, 0, 0, surfaceUnder(scene, b, g) - b.at.z);
}
/** A group id not yet in the scene, from the template's name. */
export function freshGroupId(scene: IsoScene, id: TemplateId): string {
  const taken = new Set(groupIds(scene));
  if (!taken.has(id)) return id;
  let n = 2;
  while (taken.has(`${id}-${n}`)) n++;
  return `${id}-${n}`;
}
const overlaps = (a: IsoBox, b: IsoBox) =>
  a.at.x < b.at.x + b.size.w - EPS &&
  b.at.x < a.at.x + a.size.w - EPS &&
  a.at.y < b.at.y + b.size.d - EPS &&
  b.at.y < a.at.y + a.size.d - EPS &&
  a.at.z < b.at.z + b.size.h - EPS &&
  b.at.z < a.at.z + a.size.h - EPS;
/** Groups with a prop that cuts into another group's prop. Those can draw out of order. */
export function overlappingGroups(scene: IsoScene): Set<string> {
  const hit = new Set<string>();
  scene.props.forEach((a, i) =>
    scene.props.slice(i + 1).forEach((b) => {
      if (a.group !== b.group && overlaps(a, b)) {
        hit.add(a.group);
        hit.add(b.group);
      }
    }),
  );
  return hit;
}
/**
 * Add a template where it fits: tabletop things on the first surface with
 * room, everything else on the first free floor spot, scanning back to front.
 */
export function addTemplate(scene: IsoScene, id: TemplateId): { scene: IsoScene; group: string } {
  const t: Template = PROP_TEMPLATES[id];
  const g = freshGroupId(scene, id);
  const fits = (x: number, y: number, z: number) => {
    const trial = placeTemplate(id, g, x, y, z);
    const next = { ...scene, props: [...scene.props, ...trial.props] };
    return !overlappingGroups(next).has(g) ? trial : null;
  };
  const spots: [number, number, number][] = [];
  if (t.onTop)
    for (const s of scene.surfaces)
      for (let y = s.rect.y; y + t.size.d <= s.rect.y + s.rect.d + EPS; y += 0.25)
        for (let x = s.rect.x; x + t.size.w <= s.rect.x + s.rect.w + EPS; x += 0.25)
          spots.push([x, y, s.z]);
  for (let y = 0; y + t.size.d <= scene.grid.d + EPS; y += 0.5)
    for (let x = 0; x + t.size.w <= scene.grid.w + EPS; x += 0.5) spots.push([x, y, 0]);
  for (const [x, y, z] of spots) {
    const built = fits(x, y, z);
    if (built)
      return {
        scene: {
          ...scene,
          props: [...scene.props, ...built.props],
          surfaces: [...scene.surfaces, ...built.surfaces],
        },
        group: g,
      };
  }
  const built = placeTemplate(id, g, 0, 0, 0);
  return {
    scene: {
      ...scene,
      props: [...scene.props, ...built.props],
      surfaces: [...scene.surfaces, ...built.surfaces],
    },
    group: g,
  };
}

/** A whole scene as Spark may draft it: templates on a grid, turned in quarters. */
export const sceneDraftSchema = z
  .object({
    grid: z
      .object({ w: z.number().int().min(4).max(14), d: z.number().int().min(4).max(14) })
      .strict(),
    items: z
      .array(
        z
          .object({
            template: z.enum(TEMPLATE_IDS),
            x: z.number().min(0).max(14),
            y: z.number().min(0).max(14),
            turns: z.number().int().min(0).max(3),
          })
          .strict(),
      )
      .min(1)
      .max(24),
    summary: z.string().max(200),
  })
  .strict();
export type SceneDraft = z.infer<typeof sceneDraftSchema>;
/**
 * Build a drafted layout: floor things first, then tabletop things settled
 * onto whatever surface ends up under them.
 */
export function buildScene(draft: SceneDraft, label = 'Drafted scene'): IsoScene {
  let scene: IsoScene = { kind: 'custom', label, grid: draft.grid, props: [], surfaces: [] };
  const ordered = [...draft.items].sort(
    (a, b) => Number(PROP_TEMPLATES[a.template].onTop) - Number(PROP_TEMPLATES[b.template].onTop),
  );
  for (const item of ordered) {
    const g = freshGroupId(scene, item.template);
    const built = placeTemplate(item.template, g, item.x, item.y, 0);
    scene = {
      ...scene,
      props: [...scene.props, ...built.props],
      surfaces: [...scene.surfaces, ...built.surfaces],
    };
    for (let i = 0; i < item.turns; i++) scene = rotateGroup(scene, g);
    scene = settleGroup(moveGroup(scene, g, 0, 0), g);
  }
  return scene;
}
/** One line per template for the Spark prompt. */
export function templateCatalog(): string {
  return TEMPLATE_IDS.map((id) => {
    const t: Template = PROP_TEMPLATES[id];
    return `${id}: ${t.label.toLowerCase()}, ${t.size.w}×${t.size.d} tiles${t.onTop ? ', stands on a surface' : ''}`;
  }).join('\n');
}

/** The biggest desk or table top in a scene: where the work happens. */
export function mainDesk(scene: IsoScene): IsoSurface | null {
  const byId = new Map(scene.props.map((p) => [p.id, p]));
  const isDesk = (s: IsoSurface) => {
    const t = byId.get(s.propId)?.template;
    return t ? t === 'desk' || t === 'table' : /desk|table/i.test(`${s.id} ${s.label}`);
  };
  return (
    scene.surfaces.filter(isDesk).sort((a, b) => b.rect.w * b.rect.d - a.rect.w * a.rect.d)[0] ??
    null
  );
}

/**
 * The close view of a person's room: its biggest desk or table and every
 * group standing on it, moved to the grid's corner. Surfaces keep their ids,
 * so one pin on the desktop places objects in the room and in its close view,
 * as with the preset office and office desk.
 */
export function closeViewOf(scene: IsoScene, label = 'Office desk'): IsoScene | null {
  const shift = closeViewShift(scene);
  if (!shift) return null;
  const { props, dx, dy, x0, y0, x1, y1 } = shift;
  const own = new Set(props.map((p) => p.id));
  return {
    kind: 'custom',
    label,
    grid: {
      w: Math.min(16, Math.max(2, Math.ceil(x1 - x0) + 2)),
      d: Math.min(16, Math.max(2, Math.ceil(y1 - y0) + 2)),
    },
    props: props.map((p) => ({ ...p, at: { ...p.at, x: p.at.x + dx, y: p.at.y + dy } })),
    surfaces: scene.surfaces
      .filter((s) => own.has(s.propId))
      .map((s) => ({ ...s, rect: { ...s.rect, x: s.rect.x + dx, y: s.rect.y + dy } })),
  };
}
/**
 * What the close view keeps of a room, and how far it moves it: the room's
 * point x, y is x + dx, y + dy in the close view.
 */
export function closeViewShift(scene: IsoScene) {
  const byId = new Map(scene.props.map((p) => [p.id, p]));
  const desk = mainDesk(scene);
  const deskGroup = desk && byId.get(desk.propId)?.group;
  if (!desk || !deskGroup) return null;
  const { rect } = desk;
  const standsOn = (p: IsoProp) => {
    const cx = p.at.x + p.size.w / 2;
    const cy = p.at.y + p.size.d / 2;
    return (
      p.at.z >= desk.z - 0.05 &&
      cx >= rect.x &&
      cx <= rect.x + rect.w &&
      cy >= rect.y &&
      cy <= rect.y + rect.d
    );
  };
  const groups = new Set([
    deskGroup,
    ...scene.props.filter((p) => p.group !== deskGroup && standsOn(p)).map((p) => p.group),
  ]);
  const props = scene.props.filter((p) => groups.has(p.group));
  const x0 = Math.min(...props.map((p) => p.at.x));
  const y0 = Math.min(...props.map((p) => p.at.y));
  const x1 = Math.max(...props.map((p) => p.at.x + p.size.w));
  const y1 = Math.max(...props.map((p) => p.at.y + p.size.d));
  // A tile of floor around the desk, so the view has room to breathe.
  return { props, dx: 1 - x0, dy: 1 - y0, x0, y0, x1, y1 };
}
