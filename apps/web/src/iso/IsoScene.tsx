import { useRef, useState, type PointerEvent } from 'react';
import {
  ISO_TILE,
  depthOrder,
  fromIso,
  surfaceWorld,
  toIso,
  worldSurface,
  type IsoBox,
  type IsoItem,
  type IsoProp,
  type IsoScene as Scene,
  type IsoSurface,
  type IsoTone,
  type IsoVec,
  type Point,
  type Quad,
} from '@livinglayer/domain';
import { ItemParts } from './IsoItem';

/** Muted materials for the dark room. The signal colours stay for the overlay. */
const TONES: Record<IsoTone, string> = {
  floor: '#171b27',
  wall: '#202535',
  wood: '#5b4c3f',
  steel: '#4a5164',
  fabric: '#3a4659',
  paper: '#c9c3b5',
  book: '#3c554a',
  glass: '#5f7c88',
  appliance: '#8d93a1',
  plant: '#4d6a54',
  ceramic: '#b3a796',
};
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - k)));
  return `rgb(${c.join(' ')})`;
}
export const pts = (ps: IsoVec[]) =>
  ps
    .map(toIso)
    .map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`)
    .join(' ');

/** A prism's three visible faces, or a cylinder's body and lid. */
export function Solid({
  box,
  color,
  shape,
  className,
}: {
  box: IsoBox;
  /** Base colour as `#rrggbb`; the sides are shaded from it. */
  color: string;
  shape: IsoProp['shape'];
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
}
/** Picking and dragging whole groups, for the scene editor. */
export interface IsoEditing {
  selected?: string;
  /** Groups that cut into another; they may draw out of order. */
  flagged: Set<string>;
  onSelect: (group: string) => void;
  onMove: (group: string, dx: number, dy: number) => void;
}
function ObjectMarker({ box, object }: { box: IsoBox; object: IsoObject }) {
  const head = toIso({
    x: box.at.x + box.size.w / 2,
    y: box.at.y + box.size.d / 2,
    z: box.at.z + box.size.h,
  });
  return (
    <g className={`iso-object ${object.unsure ? 'unsure' : ''}`} data-object={object.id}>
      {object.item ? (
        <ItemParts item={object.item} origin={box.at} scale={box.size.w} />
      ) : (
        <Solid box={box} color={TONES.ceramic} shape="cylinder" />
      )}
      <text x={head.sx} y={head.sy - 10}>
        {object.unsure ? '◌ ' : '✓ '}
        {object.label.toUpperCase()}
      </text>
    </g>
  );
}
type Drawable =
  (IsoBox & { kind: 'prop'; prop: IsoProp }) | (IsoBox & { kind: 'object'; object: IsoObject });
const SNAP = 0.25;

/**
 * One isometric scene drawn as SVG, with the remembered objects, the mug's
 * trail and the zones on the active surface. While `drawing`, dragging
 * across that surface reports a rectangle in surface coordinates (u, v from
 * 0 to 1). With `editing`, props can be picked and dragged a group at a time.
 */
export function IsoScene({
  scene,
  surface,
  objects = [],
  trail = [],
  zones = [],
  litLights,
  defaultLight = '',
  drawing = false,
  onDrag,
  editing,
}: {
  scene: Scene;
  surface?: IsoSurface;
  objects?: IsoObject[];
  trail?: Point[];
  zones?: IsoZone[];
  /** Lights whose last action was confirmed; their lamps glow. */
  litLights?: Set<string>;
  /** The light a lamp without its own `lightId` stands for. */
  defaultLight?: string;
  drawing?: boolean;
  onDrag?: (a: Point, b: Point) => void;
  editing?: IsoEditing;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const start = useRef<Point | null>(null);
  const drag = useRef<{ group: string; z: number; last: { x: number; y: number } } | null>(null);
  const [hover, setHover] = useState(false);
  const floor: IsoVec[] = [
    { x: 0, y: 0, z: 0 },
    { x: scene.grid.w, y: 0, z: 0 },
    { x: scene.grid.w, y: scene.grid.d, z: 0 },
    { x: 0, y: scene.grid.d, z: 0 },
  ];
  const corners = scene.props.flatMap((p) =>
    [0, 1].flatMap((i) =>
      [0, 1].flatMap((j) =>
        [0, 1].map((k) =>
          toIso({
            x: p.at.x + i * p.size.w,
            y: p.at.y + j * p.size.d,
            z: p.at.z + k * p.size.h,
          }),
        ),
      ),
    ),
  );
  const all = [...floor.map(toIso), ...corners];
  const pad = 24;
  const minX = Math.min(...all.map((p) => p.sx)) - pad;
  const maxX = Math.max(...all.map((p) => p.sx)) + pad;
  const minY = Math.min(...all.map((p) => p.sy)) - pad * 2;
  const maxY = Math.max(...all.map((p) => p.sy)) + pad;
  const items: Drawable[] = [
    ...scene.props.map((prop) => ({ ...prop, kind: 'prop' as const, prop })),
    ...objects.map((object) => ({ ...object.box, kind: 'object' as const, object })),
  ];
  const lit = (p: IsoProp) =>
    p.role === 'lamp' && Boolean(litLights?.has(p.lightId ?? defaultLight));
  const onSurface = (uv: Point) => (surface ? surfaceWorld(surface, uv) : null);
  function world(e: PointerEvent<SVGElement>, z: number): IsoVec | null {
    const ctm = svg.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return fromIso({ sx: p.x, sy: p.y }, z);
  }
  function surfacePoint(e: PointerEvent<SVGElement>): Point | null {
    const w = surface && world(e, surface.z);
    return w ? worldSurface(surface!, w) : null;
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
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      role="img"
      aria-label={`Isometric ${scene.label.toLowerCase()}${described}`}
      onPointerMove={(e) => {
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
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <polygon className="iso-floor" points={pts(floor)} />
      {Array.from({ length: scene.grid.w - 1 }, (_, i) => (
        <polyline
          key={`gx${i}`}
          className="iso-grid"
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
          points={pts([
            { x: 0, y: i + 1, z: 0 },
            { x: scene.grid.w, y: i + 1, z: 0 },
          ])}
        />
      ))}
      {depthOrder(items).map((item) =>
        item.kind === 'prop' ? (
          <g
            key={item.prop.id}
            data-prop={item.prop.id}
            data-group={item.prop.group}
            className={[
              editing?.selected === item.prop.group ? 'selected' : '',
              editing?.flagged.has(item.prop.group) ? 'overlap' : '',
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
            <Solid
              box={item}
              color={TONES[item.prop.tone]}
              shape={item.prop.shape}
              className={`iso-prop tone-${item.prop.tone} ${item.prop.role === 'lamp' ? 'iso-lamp' : ''} ${lit(item.prop) ? 'lit' : ''}`}
            />
            {item.prop.id === surface?.propId && !editing && (
              <>
                <polygon
                  className={`iso-surface ${drawing ? 'drawing' : ''} ${hover ? 'hover' : ''}`}
                  points={pts(surfaceQuad)}
                />
                {zones.map((z) => (
                  <polygon
                    key={z.id}
                    className={`iso-zone ${z.kind} ${z.inside ? 'inside' : ''}`}
                    data-zone={z.id}
                    points={pts(z.quad.map((uv) => onSurface(uv)!))}
                  />
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
        ) : (
          <ObjectMarker key={`object-${item.object.id}`} box={item} object={item.object} />
        ),
      )}
      {!editing &&
        surface &&
        zones
          .filter((z) => z.label)
          .map((z) => {
            const c = toIso(onSurface(z.quad[0])!);
            return (
              <text
                key={`label-${z.id}`}
                className={`iso-zone-label ${z.kind}`}
                x={c.sx}
                y={c.sy - 4}
              >
                {z.label!.toUpperCase()}
              </text>
            );
          })}
      <defs>
        <radialGradient id="iso-warm">
          <stop offset="0" stopColor="var(--warm)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--warm)" stopOpacity="0" />
        </radialGradient>
      </defs>
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
      {drawing && surface && !editing && (
        <polygon
          className="iso-hit"
          points={pts(surfaceQuad)}
          aria-label={`Draw placement zone on the ${surface.label.toLowerCase()}`}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          onPointerDown={(e) => {
            start.current = surfacePoint(e);
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const p = surfacePoint(e);
            if (start.current && p) onDrag?.(start.current, p);
          }}
          onPointerUp={() => {
            start.current = null;
          }}
          onPointerCancel={() => {
            start.current = null;
          }}
        />
      )}
    </svg>
  );
}
