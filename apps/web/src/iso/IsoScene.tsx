import { StatBadges } from './StatBadges';
import {
  CALLOUT_SIDE,
  CALLOUT_WIDTH,
  Callouts,
  calloutDensity,
  layoutCallouts,
  type CalloutDensity,
  type IsoCallout,
} from './Callouts';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import {
  ISO_TILE,
  PROP_FACES,
  depthOrder,
  faceFrame,
  fromIso,
  surfaceWorld,
  toIso,
  worldSurface,
  type IsoBox,
  type IsoItem,
  type IsoProp,
  type IsoScene as Scene,
  type IsoSurface,
  type IsoVec,
  type Point,
  type PropFace,
  type Quad,
  type FoodNow,
} from '@livinglayer/domain';
import { BaseHandles, type BaseRect } from './BaseHandles';
import { RectHandles, dragRect, grabOf, type Grab } from '../RectGrab';
import { useFrameQueue } from './frame';
import { ItemSprite } from './IsoItem';
import { TONES, usePropSprite } from './sprites';

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - k)));
  return `rgb(${c.join(' ')})`;
}
/** Where a zone's name goes: just under its front corner, the one nearest the viewer. */
function zoneLabelAt(corners: { sx: number; sy: number }[]) {
  const c = corners.reduce((a, b) => (b.sy > a.sy ? b : a));
  return { sx: c.sx, sy: c.sy + 11 };
}
const pts = (ps: IsoVec[]) =>
  ps
    .map(toIso)
    .map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`)
    .join(' ');

/** A prism's three visible faces, or a cylinder's body and lid. */
function Solid({
  box,
  color,
  shape,
  className,
}: {
  box: IsoBox;
  /** Base colour as `#rrggbb`; the sides are shaded from it. */
  color: string;
  shape?: IsoProp['shape'];
  className?: string;
}) {
  const { x, y, z } = box.at;
  const { w, d, h } = box.size;
  const base = color;
  if (shape === 'cylinder') {
    const r = Math.min(w, d) / 2;
    const rx = (r * Math.SQRT2 * ISO_TILE.width) / 2;
    const ry = (r * Math.SQRT2 * ISO_TILE.height) / 2;
    const top = toIso({ x: x + w / 2, y: y + d / 2, z: z + h });
    const bottom = toIso({ x: x + w / 2, y: y + d / 2, z });
    return (
      <g className={className}>
        <path
          className="side"
          fill={shade(base, 0.28)}
          d={`M${top.sx - rx},${top.sy} L${bottom.sx - rx},${bottom.sy} A${rx},${ry} 0 0 0 ${bottom.sx + rx},${bottom.sy} L${top.sx + rx},${top.sy} Z`}
        />
        <ellipse className="top" fill={base} cx={top.sx} cy={top.sy} rx={rx} ry={ry} />
      </g>
    );
  }
  return (
    <g className={className}>
      <polygon
        className="side"
        fill={shade(base, 0.22)}
        points={pts([
          { x, y: y + d, z },
          { x: x + w, y: y + d, z },
          { x: x + w, y: y + d, z: z + h },
          { x, y: y + d, z: z + h },
        ])}
      />
      <polygon
        className="side"
        fill={shade(base, 0.38)}
        points={pts([
          { x: x + w, y, z },
          { x: x + w, y: y + d, z },
          { x: x + w, y: y + d, z: z + h },
          { x: x + w, y, z: z + h },
        ])}
      />
      <polygon
        className="top"
        fill={base}
        points={pts([
          { x, y, z: z + h },
          { x: x + w, y, z: z + h },
          { x: x + w, y: y + d, z: z + h },
          { x, y: y + d, z: z + h },
        ])}
      />
    </g>
  );
}

export interface IsoObject {
  /** `tracked` for the mug; another remembered object's id otherwise. */
  id: string;
  box: IsoBox;
  label: string;
  /** A detailed model to draw in place of the plain marker, one unit to `box.size.w`. */
  item?: IsoItem;
  /** Off the pinned surface or from another frame size: drawn, but marked unsure. */
  unsure?: boolean;
  /** Selected in the outline: its footprint is ringed. */
  focused?: boolean;
  /** Its id as stats know it, when `id` is another (the mug is `tracked` here). */
  thingId?: string;
}
/** A zone on the active surface, as corners in surface coordinates. */
export interface IsoZone {
  id: string;
  quad: Quad;
  label?: string;
  /** `main`: the mug's zone. `rule`: an extra one. `draft`: being drawn. */
  kind: 'main' | 'rule' | 'draft';
  /** The object is inside it at the last check. */
  inside?: boolean;
  /** Selected in the outline. */
  focused?: boolean;
  /** Its own colour (the light its steps turn), as CSS; unset keeps the zone's usual. */
  color?: string;
  /** A motion zone, inside while it sees motion. */
  motion?: boolean;
}
/** A fixture standing in the room: a lamp, a switch, a mouse. */
export interface IsoFixture {
  id: string;
  label: string;
  box: IsoBox;
  /** Its model, already turned to face the way the fixture does. */
  item: IsoItem;
  /** A light whose last action was confirmed on: it glows like a lamp. */
  glow: boolean;
  /**
   * Its shades lit on their own, each switching its own light: a glow around
   * each, in its light's colour, the sprite as its shades paint it.
   */
  halos?: { at: IsoVec; color: string }[];
  /** The fixture's active state (`on`, `off`, `idle`, `sleeping`, or custom); null when unknown. */
  state?: string | null;
  focused?: boolean;
  /** The camera follows it and has lost it: drawn faded where it was last seen. */
  missing?: boolean;
  /** It switches a light: a stat from that light is drawn as a lamp's. */
  lamp?: boolean;
  /** Food: its use-by line ("Expires in 3 days"), over its label. */
  food?: FoodNow;
}
/** A fixture waiting to be put down: it follows the pointer until a click. */
interface IsoPlacing {
  label: string;
  item: IsoItem;
  /** Footprint and height in tiles, already turned. */
  size: IsoBox['size'];
  onPlace: (where: { at: { x: number; y: number }; surfaceId: string | null }) => void;
}
/** Picking and dragging whole groups, for the scene editor. */
interface IsoEditing {
  selected?: string;
  /** Groups that cut into another; they may draw out of order. */
  flagged: Set<string>;
  onSelect: (group: string) => void;
  onMove: (group: string, dx: number, dy: number) => void;
}
const ObjectMarker = memo(function ObjectMarker({
  box,
  object,
  stats,
  calledOut,
}: {
  box: IsoBox;
  object: IsoObject;
  stats: boolean;
  /** Its card beside the room names it, so the room doesn't too. */
  calledOut?: boolean;
}) {
  const head = toIso({
    x: box.at.x + box.size.w / 2,
    y: box.at.y + box.size.d / 2,
    z: box.at.z + box.size.h,
  });
  return (
    <g
      className={`iso-object ${object.unsure ? 'unsure' : ''} ${object.focused ? 'focused' : ''}`}
      data-object={object.id}
    >
      {object.focused && (
        <polygon
          className="iso-focus"
          points={pts([
            { x: box.at.x - 0.15, y: box.at.y - 0.15, z: box.at.z },
            { x: box.at.x + box.size.w + 0.15, y: box.at.y - 0.15, z: box.at.z },
            { x: box.at.x + box.size.w + 0.15, y: box.at.y + box.size.d + 0.15, z: box.at.z },
            { x: box.at.x - 0.15, y: box.at.y + box.size.d + 0.15, z: box.at.z },
          ])}
        />
      )}
      {object.item ? (
        <ItemSprite item={object.item} origin={box.at} scale={box.size.w} />
      ) : (
        <Solid box={box} color={TONES.ceramic} shape="cylinder" />
      )}
      {!calledOut && (
        <text x={head.sx} y={head.sy - 10}>
          {object.unsure ? '◌ ' : '✓ '}
          {object.label.toUpperCase()}
        </text>
      )}
      {stats && <StatBadges id={object.thingId ?? object.id} x={head.sx} y={head.sy - 22} />}
    </g>
  );
});
/** Memoised: the scene passes handlers that take the fixture, so they stay the same across moves. */
const FixtureMarker = memo(function FixtureMarker({
  fixture,
  onSelect,
  onGrab,
  onMenu,
  stats,
  calledOut,
}: {
  fixture: IsoFixture;
  stats: boolean;
  /** Its card beside the room says it all: no label or food line over it. */
  calledOut?: boolean;
  onSelect?: (id: string) => void;
  /** Pressed to drag it; a press that doesn't move selects it instead. */
  onGrab?: (e: PointerEvent<SVGGElement>, fixture: IsoFixture) => void;
  onMenu?: (e: MouseEvent<SVGGElement>, id: string) => void;
}) {
  const { box } = fixture;
  const head = toIso({
    x: box.at.x + box.size.w / 2,
    y: box.at.y + box.size.d / 2,
    z: box.at.z + box.size.h,
  });
  const pip = fixture.state === undefined ? '◇ ' : fixture.state === 'on' ? '● ' : '○ ';
  return (
    <g
      className={`iso-fixture ${fixture.focused ? 'focused' : ''} ${fixture.state === 'on' ? 'on' : ''} ${fixture.missing ? 'missing' : ''}`}
      data-fixture={fixture.id}
      onClick={onSelect && !onGrab ? () => onSelect(fixture.id) : undefined}
      onPointerDown={onGrab ? (e) => onGrab(e, fixture) : undefined}
      onContextMenu={onMenu ? (e) => onMenu(e, fixture.id) : undefined}
    >
      {fixture.focused && (
        <polygon
          className="iso-focus"
          points={pts([
            { x: box.at.x - 0.1, y: box.at.y - 0.1, z: box.at.z },
            { x: box.at.x + box.size.w + 0.1, y: box.at.y - 0.1, z: box.at.z },
            { x: box.at.x + box.size.w + 0.1, y: box.at.y + box.size.d + 0.1, z: box.at.z },
            { x: box.at.x - 0.1, y: box.at.y + box.size.d + 0.1, z: box.at.z },
          ])}
        />
      )}
      <ItemSprite
        item={fixture.item}
        origin={box.at}
        scale={Math.max(box.size.w, box.size.d)}
        glow={fixture.glow}
      />
      {/* The sprite lets the pointer through; its box, invisible, is what is clicked and dragged. */}
      <Solid box={box} color="#000000" className="iso-hit-shape" />
      {/* A card beside the room names it, so the room doesn't too. */}
      {!calledOut && (
        <text x={head.sx} y={head.sy - 8}>
          {pip}
          {fixture.label.toUpperCase()}
          {fixture.state && fixture.state !== 'on' && fixture.state !== 'off'
            ? ` · ${fixture.state.toUpperCase()}`
            : ''}
        </text>
      )}
      {fixture.food && !calledOut && (
        <text className={`iso-food ${fixture.food.tone}`} x={head.sx} y={head.sy - 19}>
          {fixture.food.text.toUpperCase()}
        </text>
      )}
      {stats && (
        <StatBadges
          id={fixture.id}
          x={head.sx}
          y={head.sy - (fixture.food ? 31 : 20)}
          lamp={fixture.lamp}
        />
      )}
    </g>
  );
});
/** Where a face texture is served from; a data URL is drawn as it is. */
const textureUrl = (ref: string) =>
  ref.startsWith('data:') ? ref : `/api/scene/texture?asset=${encodeURIComponent(ref)}`;
/**
 * A face's texture laid on it: the image's unit square goes to the face's
 * parallelogram on screen, which an iso projection keeps affine.
 */
function FaceImage({ prop, face, href }: { prop: IsoProp; face: PropFace; href: string }) {
  const { origin, u, v } = faceFrame(prop, face);
  const at = (k: number, l: number) =>
    toIso({
      x: origin[0] + u[0] * k + v[0] * l,
      y: origin[1] + u[1] * k + v[1] * l,
      z: origin[2] + u[2] * k + v[2] * l,
    });
  const o = at(0, 0);
  const a = at(1, 0);
  const b = at(0, 1);
  return (
    <image
      className={`iso-texture ${face}`}
      href={textureUrl(href)}
      width={1}
      height={1}
      preserveAspectRatio="none"
      transform={`matrix(${a.sx - o.sx} ${a.sy - o.sy} ${b.sx - o.sx} ${b.sy - o.sy} ${o.sx} ${o.sy})`}
    />
  );
}
/**
 * A prop drawn by the voxel kernel, with its flat faces kept underneath,
 * invisible, so picking and dragging follow the prop's shape, not its image.
 * A prop with faces painted from its photo is drawn as those faces instead.
 */
const PropSprite = memo(function PropSprite({ prop, lit }: { prop: IsoProp; lit: boolean }) {
  const className = `iso-prop tone-${prop.tone} ${prop.role === 'lamp' ? 'iso-lamp' : ''} ${lit ? 'lit' : ''}`;
  const texture = prop.texture;
  const photoFaces = Boolean(texture && Object.keys(texture).length && !prop.form && !prop.recipe);
  const sprite = usePropSprite(photoFaces ? null : prop, lit);
  if (texture && photoFaces)
    return (
      <g className={`${className} textured`}>
        <Solid box={prop} color={TONES[prop.tone]} shape={prop.shape} />
        {PROP_FACES.map((face) =>
          texture[face] ? (
            <FaceImage key={face} prop={prop} face={face} href={texture[face]!} />
          ) : null,
        )}
        <Solid box={prop} color={TONES[prop.tone]} shape={prop.shape} className="iso-hit-shape" />
      </g>
    );
  const at = toIso(prop.at);
  return (
    <g className={className}>
      {sprite && (
        <image
          href={sprite.url}
          x={at.sx + sprite.x}
          y={at.sy + sprite.y}
          width={sprite.width}
          height={sprite.height}
          preserveAspectRatio="none"
        />
      )}
      {/* A model keeps its own sides; only the top it carries takes the photo. */}
      {texture?.top && <FaceImage prop={prop} face="top" href={texture.top} />}
      <Solid box={prop} color={TONES[prop.tone]} shape={prop.shape} className="iso-hit-shape" />
    </g>
  );
});
type Drawable =
  | (IsoBox & { kind: 'prop'; prop: IsoProp })
  | (IsoBox & { kind: 'object'; object: IsoObject })
  | (IsoBox & { kind: 'fixture'; fixture: IsoFixture });
const SNAP = 0.25;
// Stable defaults, so the memos below hold when a caller leaves them out.
const NO_OBJECTS: IsoObject[] = [];
const NO_FIXTURES: IsoFixture[] = [];
const NO_POINTS: Point[] = [];
/** A rectangle in units of 0 to 1. */
type ZoneUv = { x: number; y: number; width: number; height: number };
/**
 * A zone being drawn, to move and stretch: a rectangle on the surface, or one
 * in the camera's frame (drawn on its picture), which the surface shows
 * slanted and which is changed in the frame so it keeps its shape there.
 */
export interface IsoDrawn {
  rect: ZoneUv;
  frame?: {
    toSurface: (p: Point) => Point;
    fromSurface: (uv: Point) => Point;
    onRect: (rect: ZoneUv) => void;
  };
}
const NO_ZONES: IsoZone[] = [];
const NO_CALLOUTS: IsoCallout[] = [];
type Stand = { at: IsoVec; surfaceId: string | null };
const sameStand = (a: Stand | null, b: Stand | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.surfaceId === b.surfaceId &&
    a.at.x === b.at.x &&
    a.at.y === b.at.y &&
    a.at.z === b.at.z);
/** The room's own extent on screen: its floor and every prop's corners. */
function roomBounds(scene: Scene) {
  const floor: IsoVec[] = [
    { x: 0, y: 0, z: 0 },
    { x: scene.grid.w, y: 0, z: 0 },
    { x: scene.grid.w, y: scene.grid.d, z: 0 },
    { x: 0, y: scene.grid.d, z: 0 },
  ];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const take = (v: IsoVec) => {
    const p = toIso(v);
    if (p.sx < minX) minX = p.sx;
    if (p.sx > maxX) maxX = p.sx;
    if (p.sy < minY) minY = p.sy;
    if (p.sy > maxY) maxY = p.sy;
  };
  for (const v of floor) take(v);
  for (const p of scene.props)
    for (const i of [0, 1])
      for (const j of [0, 1])
        for (const k of [0, 1])
          take({ x: p.at.x + i * p.size.w, y: p.at.y + j * p.size.d, z: p.at.z + k * p.size.h });
  return { floor, minX, maxX, minY, maxY };
}

/**
 * One isometric scene drawn as SVG, with the remembered objects, the mug's
 * trail and the zones on the active surface. While `drawing`, dragging
 * across that surface reports a rectangle in surface coordinates (u, v from
 * 0 to 1). With `editing`, props can be picked and dragged a group at a time.
 */
function IsoSceneView({
  scene,
  surface,
  objects = NO_OBJECTS,
  fixtures = NO_FIXTURES,
  onFixture,
  onMoveFixture,
  onFixtureMenu,
  onResizeFixture,
  placing,
  trail = NO_POINTS,
  zones = NO_ZONES,
  onZone,
  litLights,
  defaultLight = '',
  drawing = false,
  drawn,
  onDrag,
  editing,
  hidden,
  seeThrough,
  stats = false,
  callouts = NO_CALLOUTS,
}: {
  scene: Scene;
  surface?: IsoSurface;
  objects?: IsoObject[];
  fixtures?: IsoFixture[];
  /** A click on a fixture selects it. */
  onFixture?: (id: string) => void;
  /** Drag a fixture to stand it elsewhere: its footprint's new centre, on a surface or the floor. */
  onMoveFixture?: (id: string, to: { x: number; y: number; surfaceId: string | null }) => void;
  /** Right-click on a fixture, at the pointer in the window. */
  onFixtureMenu?: (id: string, at: { x: number; y: number }) => void;
  /** Stretch the selected fixture's base by its handles, to a footprint already turned. */
  onResizeFixture?: (id: string, rect: BaseRect) => Promise<void> | void;
  placing?: IsoPlacing;
  trail?: Point[];
  zones?: IsoZone[];
  /** A click on a saved zone selects its rule: `main` is the mug's. */
  onZone?: (id: string) => void;
  /** Lights whose last action was confirmed; their lamps glow. */
  litLights?: Set<string>;
  /** The light a lamp without its own `lightId` stands for. */
  defaultLight?: string;
  drawing?: boolean;
  /** The zone being drawn: pressed, it moves, and its sides and corners stretch it. */
  drawn?: IsoDrawn | null;
  onDrag?: (a: Point, b: Point) => void;
  editing?: IsoEditing;
  /** Prop groups not drawn; the view keeps its framing. */
  hidden?: ReadonlySet<string>;
  /** Props drawn faint and let the pointer through: a door in front of what is behind it. */
  seeThrough?: ReadonlySet<string>;
  /** Draw each thing's stats over it. */
  stats?: boolean;
  /** With `stats`, cards beside the room for the things with something to say. */
  callouts?: IsoCallout[];
}) {
  const svg = useRef<SVGSVGElement>(null);
  const start = useRef<Point | null>(null);
  // What a press on the zone being drawn took hold of, and the zone as it was then.
  const zoneGrab = useRef<{ grab: Grab; from: ZoneUv | null }>({ grab: 'draw', from: null });
  const drag = useRef<{ group: string; z: number; last: { x: number; y: number } } | null>(null);
  const [hover, setHover] = useState(false);
  /** The zone under the pointer, named while it is there. */
  const [hoverZone, setHoverZone] = useState<string | null>(null);
  const [density, setDensity] = useState<CalloutDensity>('full');
  const [ghost, setGhost] = useState<Stand | null>(null);
  const [stretching, setStretching] = useState<{ id: string; rect: BaseRect } | null>(null);
  // A fixture being dragged: where the press was, and where it would stand once it has moved.
  const [moving, setMoving] = useState<{
    id: string;
    size: { w: number; d: number };
    from: { x: number; y: number };
    to: { at: IsoVec; surfaceId: string | null } | null;
  } | null>(null);
  // Where a dragged fixture would stand now, ahead of the frame that draws it there.
  const movingTo = useRef<Stand | null>(null);
  const moveQueue = useFrameQueue((to: Stand) => setMoving((m) => m && { ...m, to }));
  const ghostQueue = useFrameQueue((to: Stand | null) =>
    setGhost((g) => (sameStand(g, to) ? g : to)),
  );
  // A base being stretched is drawn at its new size, and a dragged fixture where it would stand.
  const movingId = moving?.id;
  const movedTo = moving?.to;
  const shown = useMemo(
    () =>
      fixtures.map((f) =>
        f.id === stretching?.id
          ? {
              ...f,
              box: {
                at: { ...f.box.at, x: stretching.rect.x, y: stretching.rect.y },
                size: { ...f.box.size, w: stretching.rect.w, d: stretching.rect.d },
              },
            }
          : f.id === movingId && movedTo
            ? { ...f, box: { ...f.box, at: movedTo.at } }
            : f,
      ),
    [fixtures, stretching, movingId, movedTo],
  );
  const movable = Boolean(onMoveFixture) && !drawing && !placing;
  const room = useMemo(() => roomBounds(scene), [scene]);
  const { floor } = room;
  const pad = 24;
  // The stats layer's cards stand in columns beside the room, so the view widens to hold
  // them; in a pane too small to read them, only each thing's health bar shows.
  const showCards = stats && !editing && callouts.length > 0;
  const side = showCards && density !== 'pips' ? CALLOUT_SIDE : 0;
  const minX = room.minX - pad - side;
  const maxX = room.maxX + pad + side;
  const roomMinY = room.minY - pad * 2;
  const roomMaxY = room.maxY + pad;
  // The cards' columns may reach past the room: the view grows to hold them.
  const cards = useMemo(
    () =>
      showCards
        ? layoutCallouts(callouts, { minX, maxX, minY: roomMinY, maxY: roomMaxY }, density)
        : null,
    [showCards, callouts, minX, maxX, roomMinY, roomMaxY, density],
  );
  const minY = side && cards ? cards.extent.minY : roomMinY;
  const maxY = side && cards ? cards.extent.maxY : roomMaxY;
  const viewW = maxX - minX;
  const viewH = maxY - minY;
  // How wide a card is drawn on screen picks how much it says (`calloutDensity`).
  useEffect(() => {
    const el = svg.current;
    if (!el || !showCards) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const scale = Math.min(r.width / viewW, r.height / viewH);
      setDensity((d) => calloutDensity(CALLOUT_WIDTH * scale, d));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [showCards, viewW, viewH]);
  // Drawn back to front; the order is worked out again only when what is drawn changes.
  const ordered = useMemo(() => {
    const items: Drawable[] = [
      ...scene.props
        .filter((p) => !hidden?.has(p.group))
        .map((prop) => ({ ...prop, kind: 'prop' as const, prop })),
      ...objects.map((object) => ({ ...object.box, kind: 'object' as const, object })),
      ...shown.map((fixture) => ({ ...fixture.box, kind: 'fixture' as const, fixture })),
    ];
    return depthOrder(items);
  }, [scene.props, hidden, objects, shown]);
  const calledOut = useMemo(
    () => (stats ? new Set(callouts.map((c) => c.id)) : null),
    [stats, callouts],
  );
  const grab = useCallback((e: PointerEvent<SVGGElement>, f: IsoFixture) => {
    if (e.button !== 0) return;
    movingTo.current = null;
    setMoving({
      id: f.id,
      size: { w: f.box.size.w, d: f.box.size.d },
      from: { x: e.clientX, y: e.clientY },
      to: null,
    });
    // Synthetic events (tests, assistive tech) may have no pointer to capture.
    try {
      svg.current?.setPointerCapture(e.pointerId);
    } catch {
      /* dragging still works while the pointer stays over the scene */
    }
  }, []);
  const menuOpen = Boolean(onFixtureMenu && !drawing && !placing);
  const menu = useCallback(
    (e: MouseEvent<SVGGElement>, id: string) => {
      e.preventDefault();
      onFixtureMenu?.(id, { x: e.clientX, y: e.clientY });
    },
    [onFixtureMenu],
  );
  const lit = (p: IsoProp) =>
    p.role === 'lamp' && Boolean(litLights?.has(p.lightId ?? defaultLight));
  const onSurface = (uv: Point) => (surface ? surfaceWorld(surface, uv) : null);
  function world(e: { clientX: number; clientY: number }, z: number): IsoVec | null {
    const ctm = svg.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return fromIso({ sx: p.x, sy: p.y }, z);
  }
  function surfacePoint(e: PointerEvent<SVGElement>): Point | null {
    const w = surface && world(e, surface.z);
    return w ? worldSurface(surface!, w) : null;
  }
  /**
   * Where a fixture of this footprint would stand under the pointer: on the
   * highest surface the pointer is over, else on the floor, centred on the
   * pointer and kept inside the room.
   */
  function standAt(
    e: { clientX: number; clientY: number },
    { w, d }: { w: number; d: number },
  ): { at: IsoVec; surfaceId: string | null } | null {
    const corner = (p: IsoVec) => ({
      x: Math.min(Math.max(p.x - w / 2, 0), Math.max(scene.grid.w - w, 0)),
      y: Math.min(Math.max(p.y - d / 2, 0), Math.max(scene.grid.d - d, 0)),
      z: p.z,
    });
    for (const s of [...scene.surfaces].sort((a, b) => b.z - a.z)) {
      const p = world(e, s.z);
      const r = s.rect;
      if (p && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.d)
        return { at: corner(p), surfaceId: s.id };
    }
    const p = world(e, 0);
    return p && p.x >= 0 && p.y >= 0 && p.x <= scene.grid.w && p.y <= scene.grid.d
      ? { at: corner(p), surfaceId: null }
      : null;
  }
  const surfaceQuad: IsoVec[] = surface
    ? [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ].map((uv) => onSurface(uv)!)
    : [];
  const described = objects.length
    ? `, with ${objects.map((o) => o.label.toLowerCase()).join(', ')} on the ${surface?.label.toLowerCase() ?? 'surface'}`
    : '';
  return (
    <svg
      ref={svg}
      className={`iso-scene ${editing ? 'editing' : ''}`}
      data-pan={editing ? undefined : ''}
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      role="img"
      aria-label={`Isometric ${scene.label.toLowerCase()}${described}`}
      onPointerMove={(e) => {
        if (moving) {
          // A few pixels of jitter is still a click.
          if (
            !movingTo.current &&
            Math.hypot(e.clientX - moving.from.x, e.clientY - moving.from.y) < 4
          )
            return;
          const to = standAt(e, moving.size);
          if (to && !sameStand(to, movingTo.current)) {
            movingTo.current = to;
            moveQueue.push(to);
          }
          return;
        }
        const d = drag.current;
        const p = d && world(e, d.z);
        if (!d || !p) return;
        const dx = Math.round((p.x - d.last.x) / SNAP) * SNAP;
        const dy = Math.round((p.y - d.last.y) / SNAP) * SNAP;
        if (!dx && !dy) return;
        d.last = { x: d.last.x + dx, y: d.last.y + dy };
        editing?.onMove(d.group, dx, dy);
      }}
      onPointerUp={() => {
        drag.current = null;
        if (!moving) return;
        moveQueue.cancel();
        const to = movingTo.current;
        movingTo.current = null;
        setMoving(null);
        const { id, size } = moving;
        if (to)
          onMoveFixture?.(id, {
            x: to.at.x + size.w / 2,
            y: to.at.y + size.d / 2,
            surfaceId: to.surfaceId,
          });
        else onFixture?.(id);
      }}
      onPointerCancel={() => {
        drag.current = null;
        moveQueue.cancel();
        movingTo.current = null;
        setMoving(null);
      }}
    >
      <polygon className="iso-floor" data-pan points={pts(floor)} />
      {Array.from({ length: scene.grid.w - 1 }, (_, i) => (
        <polyline
          key={`gx${i}`}
          className="iso-grid"
          data-pan
          points={pts([
            { x: i + 1, y: 0, z: 0 },
            { x: i + 1, y: scene.grid.d, z: 0 },
          ])}
        />
      ))}
      {Array.from({ length: scene.grid.d - 1 }, (_, i) => (
        <polyline
          key={`gy${i}`}
          className="iso-grid"
          data-pan
          points={pts([
            { x: 0, y: i + 1, z: 0 },
            { x: scene.grid.w, y: i + 1, z: 0 },
          ])}
        />
      ))}
      {ordered.map((item) =>
        item.kind === 'prop' ? (
          <g
            key={item.prop.id}
            data-prop={item.prop.id}
            data-group={item.prop.group}
            className={[
              editing?.selected === item.prop.group ? 'selected' : '',
              editing?.flagged.has(item.prop.group) ? 'overlap' : '',
              seeThrough?.has(item.prop.id) ? 'see-through' : '',
            ].join(' ')}
            onPointerDown={
              editing
                ? (e) => {
                    const p = world(e, item.prop.at.z);
                    editing.onSelect(item.prop.group);
                    if (!p) return;
                    drag.current = { group: item.prop.group, z: item.prop.at.z, last: p };
                    // Synthetic events (tests, assistive tech) may have no pointer to capture.
                    try {
                      svg.current?.setPointerCapture(e.pointerId);
                    } catch {
                      /* dragging still works while the pointer stays over the scene */
                    }
                  }
                : undefined
            }
          >
            <PropSprite prop={item.prop} lit={lit(item.prop)} />
            {item.prop.id === surface?.propId && !editing && (
              <>
                <polygon
                  className={`iso-surface ${drawing ? 'drawing' : ''} ${hover ? 'hover' : ''}`}
                  points={pts(surfaceQuad)}
                />
                {/* Where a zone takes a hover or a click: on the surface, under what stands in it. */}
                {onZone &&
                  !drawing &&
                  !placing &&
                  zones
                    .filter((z) => z.kind !== 'draft')
                    .map((z) => (
                      <polygon
                        key={z.id}
                        className={`iso-zone-hit ${z.kind} pickable`}
                        data-zone={z.id}
                        points={pts(z.quad.map((uv) => onSurface(uv)!))}
                        onClick={() => onZone(z.id)}
                        onPointerEnter={() => setHoverZone(z.id)}
                        onPointerLeave={() => setHoverZone((h) => (h === z.id ? null : h))}
                      >
                        <title>{`${z.label ?? 'Main zone'}: click to open it`}</title>
                      </polygon>
                    ))}
                {trail.length > 1 && (
                  <polyline
                    className="iso-trail"
                    points={pts([...trail].reverse().map((uv) => onSurface(uv)!))}
                  />
                )}
              </>
            )}
          </g>
        ) : item.kind === 'object' ? (
          <ObjectMarker
            key={`object-${item.object.id}`}
            box={item.object.box}
            object={item.object}
            stats={stats && !calledOut?.has(item.object.thingId ?? item.object.id)}
            calledOut={stats && Boolean(calledOut?.has(item.object.thingId ?? item.object.id))}
          />
        ) : (
          <FixtureMarker
            key={`fixture-${item.fixture.id}`}
            fixture={item.fixture}
            stats={stats && !calledOut?.has(item.fixture.id)}
            calledOut={stats && Boolean(calledOut?.has(item.fixture.id))}
            onSelect={drawing || placing ? undefined : onFixture}
            onGrab={movable ? grab : undefined}
            onMenu={menuOpen ? menu : undefined}
          />
        ),
      )}
      {/* Zones over everything standing in the room, so none hides behind a monitor; named on hover. */}
      {!editing && surface && (
        <g className="iso-zones">
          {zones.map((z) => (
            <polygon
              key={z.id}
              className={`iso-zone ${z.kind} ${z.motion ? 'motion' : ''} ${z.inside ? 'inside' : ''} ${z.focused || hoverZone === z.id ? 'focused' : ''}`}
              style={z.color ? ({ '--zone': z.color } as CSSProperties) : undefined}
              points={pts(z.quad.map((uv) => onSurface(uv)!))}
            />
          ))}
          {/* Its outline takes a hover or a click too, where something stands over its middle. */}
          {onZone &&
            !drawing &&
            !placing &&
            zones
              .filter((z) => z.kind !== 'draft')
              .map((z) => (
                <polygon
                  key={`edge-${z.id}`}
                  className="iso-zone-edge"
                  points={pts(z.quad.map((uv) => onSurface(uv)!))}
                  onClick={() => onZone(z.id)}
                  onPointerEnter={() => setHoverZone(z.id)}
                  onPointerLeave={() => setHoverZone((h) => (h === z.id ? null : h))}
                />
              ))}
          {zones
            .filter((z) => z.label && (z.kind === 'draft' || z.focused || hoverZone === z.id))
            .map((z) => {
              const c = zoneLabelAt(z.quad.map((uv) => toIso(onSurface(uv)!)));
              return (
                <text
                  key={`label-${z.id}`}
                  className={`iso-zone-label ${z.kind} ${z.motion ? 'motion' : ''} ${z.inside ? 'inside' : ''}`}
                  style={z.color ? ({ '--zone': z.color } as CSSProperties) : undefined}
                  x={c.sx}
                  y={c.sy}
                >
                  {z.label!.toUpperCase()}
                </text>
              );
            })}
        </g>
      )}
      <defs>
        <radialGradient id="iso-warm">
          <stop offset="0" stopColor="var(--warm)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--warm)" stopOpacity="0" />
        </radialGradient>
      </defs>
      {fixtures
        .filter((f) => f.glow)
        .map((f) => {
          const c = toIso({
            x: f.box.at.x + f.box.size.w / 2,
            y: f.box.at.y + f.box.size.d / 2,
            z: f.box.at.z,
          });
          return (
            <ellipse
              key={`glow-${f.id}`}
              className="iso-glow"
              fill="url(#iso-warm)"
              cx={c.sx}
              cy={c.sy}
              rx={180}
              ry={90}
            />
          );
        })}
      {fixtures.flatMap((f) =>
        (f.halos ?? []).map((h, i) => {
          // Around the shade, and a fainter pool on the floor below it.
          const id = `iso-halo-${f.id}-${i}`;
          const c = toIso(h.at);
          const floor = toIso({ ...h.at, z: f.box.at.z });
          return (
            <g key={id} className="iso-glow">
              <radialGradient id={id}>
                <stop offset="0" stopColor={h.color} stopOpacity="0.45" />
                <stop offset="1" stopColor={h.color} stopOpacity="0" />
              </radialGradient>
              <ellipse
                fill={`url(#${id})`}
                cx={floor.sx}
                cy={floor.sy}
                rx={110}
                ry={55}
                opacity={0.5}
              />
              <circle fill={`url(#${id})`} cx={c.sx} cy={c.sy} r={70} />
            </g>
          );
        }),
      )}
      {scene.props.filter(lit).map((p) => {
        const c = toIso({ x: p.at.x + p.size.w / 2, y: p.at.y + p.size.d / 2, z: p.at.z });
        return (
          <ellipse
            key={`glow-${p.id}`}
            className="iso-glow"
            fill="url(#iso-warm)"
            cx={c.sx}
            cy={c.sy}
            rx={180}
            ry={90}
          />
        );
      })}
      {cards && <Callouts placed={cards.placed} density={density} />}
      {onResizeFixture &&
        !editing &&
        !drawing &&
        !placing &&
        shown
          .filter((f) => f.focused)
          .map((f) => (
            <BaseHandles
              key={`handles-${f.id}`}
              rect={{ x: f.box.at.x, y: f.box.at.y, w: f.box.size.w, d: f.box.size.d }}
              z={f.box.at.z}
              label={f.label}
              radius={5}
              project={(x, y, z) => {
                const p = toIso({ x, y, z });
                return { x: p.sx, y: p.sy };
              }}
              unproject={(e, z) => world(e, z)}
              onPreview={(rect) => setStretching(rect && { id: f.id, rect })}
              onDone={(rect) =>
                void Promise.resolve(onResizeFixture(f.id, rect)).finally(() => setStretching(null))
              }
            />
          ))}
      {placing && ghost && (
        <g className="iso-ghost" aria-hidden="true">
          <ItemSprite
            item={placing.item}
            origin={ghost.at}
            scale={Math.max(placing.size.w, placing.size.d)}
          />
        </g>
      )}
      {placing && !editing && (
        <rect
          className="iso-place-hit"
          x={minX}
          y={minY}
          width={maxX - minX}
          height={maxY - minY}
          aria-label={`Place the ${placing.label.toLowerCase()}`}
          onPointerMove={(e) => ghostQueue.push(standAt(e, placing.size))}
          onPointerLeave={() => {
            ghostQueue.cancel();
            setGhost(null);
          }}
          onClick={(e) => {
            const where = standAt(e, placing.size);
            if (where)
              placing.onPlace({ at: { x: where.at.x, y: where.at.y }, surfaceId: where.surfaceId });
          }}
        />
      )}
      {drawing && surface && !editing && (
        <g
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          onPointerDown={(e) => {
            const p = surfacePoint(e);
            zoneGrab.current = { grab: grabOf(e.target), from: drawn?.rect ?? null };
            start.current = p;
            if (p) e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const p = surfacePoint(e);
            if (!start.current || !p) return;
            const { grab: g, from } = zoneGrab.current;
            // A zone kept in the frame moves and stretches there; drawing anew is on the surface.
            const inFrame = g !== 'draw' ? drawn?.frame : undefined;
            if (inFrame) {
              inFrame.onRect(
                dragRect(from, g, inFrame.fromSurface(start.current), inFrame.fromSurface(p)),
              );
              return;
            }
            const r = dragRect(from, g, start.current, p);
            onDrag?.({ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y + r.height });
          }}
          onPointerUp={() => {
            start.current = null;
          }}
          onPointerCancel={() => {
            start.current = null;
          }}
        >
          <polygon
            className="iso-hit"
            points={pts(surfaceQuad)}
            aria-label={`Draw placement zone on the ${surface.label.toLowerCase()}`}
          />
          {drawn && (
            <RectHandles
              rect={drawn.rect}
              to={(p) => {
                const c = toIso(onSurface(drawn.frame ? drawn.frame.toSurface(p) : p)!);
                return { x: c.sx, y: c.sy };
              }}
            />
          )}
        </g>
      )}
    </svg>
  );
}

/** Memoised: it redraws only when its scene, objects or handlers change, so callers keep those stable. */
export const IsoScene = memo(IsoSceneView);
