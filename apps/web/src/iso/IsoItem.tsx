import {
  ISO_TILE,
  depthOrder,
  partBox,
  toIso,
  type IsoBox,
  type IsoItem,
  type IsoVec,
  type ItemPart,
} from '@livinglayer/domain';
import { Solid, shade } from './IsoScene';

const world = (p: ItemPart, origin: IsoVec, scale: number): IsoBox => ({
  at: { x: origin.x + p.at.x * scale, y: origin.y + p.at.y * scale, z: origin.z + p.at.z * scale },
  size: { w: p.size.w * scale, d: p.size.d * scale, h: p.size.h * scale },
});

/** A cone or frustum: the top radius is `taper` times the bottom one. */
function Cone({ box, color, taper }: { box: IsoBox; color: string; taper: number }) {
  const r = Math.min(box.size.w, box.size.d) / 2;
  const rx = (r * Math.SQRT2 * ISO_TILE.width) / 2;
  const ry = (r * Math.SQRT2 * ISO_TILE.height) / 2;
  const c = { x: box.at.x + box.size.w / 2, y: box.at.y + box.size.d / 2 };
  const top = toIso({ ...c, z: box.at.z + box.size.h });
  const bottom = toIso({ ...c, z: box.at.z });
  return (
    <g>
      <path
        className="side"
        fill={shade(color, 0.28)}
        d={`M${top.sx - rx * taper},${top.sy} L${bottom.sx - rx},${bottom.sy} A${rx},${ry} 0 0 0 ${bottom.sx + rx},${bottom.sy} L${top.sx + rx * taper},${top.sy} Z`}
      />
      {taper > 0.01 && (
        <ellipse
          className="top"
          fill={color}
          cx={top.sx}
          cy={top.sy}
          rx={rx * taper}
          ry={ry * taper}
        />
      )}
    </g>
  );
}
/**
 * A handle: a half loop in the upright plane, bulging away from the item's
 * centre along its longer side. Its thickness is the shorter side.
 */
function Handle({ part, box, color }: { part: ItemPart; box: IsoBox; color: string }) {
  const alongX = part.size.w >= part.size.d;
  const outward = alongX ? part.at.x + part.size.w / 2 >= 0.5 : part.at.y + part.size.d / 2 >= 0.5;
  const reach = alongX ? box.size.w : box.size.d;
  const inner = alongX
    ? outward
      ? box.at.x
      : box.at.x + box.size.w
    : outward
      ? box.at.y
      : box.at.y + box.size.d;
  const thickness = alongX ? box.size.d : box.size.w;
  const zc = box.at.z + box.size.h / 2;
  const points = Array.from({ length: 13 }, (_, i) => {
    const t = -Math.PI / 2 + (i / 12) * Math.PI;
    const off = inner + (outward ? 1 : -1) * Math.cos(t) * reach;
    const p: IsoVec = alongX
      ? { x: off, y: box.at.y + box.size.d / 2, z: zc + (Math.sin(t) * box.size.h) / 2 }
      : { x: box.at.x + box.size.w / 2, y: off, z: zc + (Math.sin(t) * box.size.h) / 2 };
    const s = toIso(p);
    return `${s.sx.toFixed(1)},${s.sy.toFixed(1)}`;
  }).join(' ');
  const width = Math.max(1.5, (thickness * ISO_TILE.width) / 2);
  return (
    <g className="handle">
      <polyline
        points={points}
        fill="none"
        stroke={shade(color, 0.45)}
        strokeWidth={width + 1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}

/**
 * An item's parts, back to front, with item space placed at `origin` and one
 * item unit drawn `scale` tiles wide.
 */
export function ItemParts({
  item,
  origin,
  scale,
  selected,
}: {
  item: IsoItem;
  origin: IsoVec;
  scale: number;
  /** A part to outline, for the editor. */
  selected?: string;
}) {
  const parts = depthOrder(item.parts.map((p) => ({ ...partBox(p), part: p })));
  return (
    <g className="iso-item">
      {parts.map(({ part }) => {
        const box = world(part, origin, scale);
        const className = `item-part ${part.id === selected ? 'selected' : ''}`;
        return (
          <g key={part.id} className={className} data-part={part.id}>
            {part.shape === 'handle' ? (
              <Handle part={part} box={box} color={part.color} />
            ) : part.shape === 'cone' ? (
              <Cone box={box} color={part.color} taper={part.taper} />
            ) : part.shape === 'lid' ? (
              <>
                <Solid box={box} color={part.color} shape="cylinder" />
                <Solid
                  box={{
                    at: {
                      x: box.at.x + box.size.w * 0.4,
                      y: box.at.y + box.size.d * 0.4,
                      z: box.at.z + box.size.h,
                    },
                    size: {
                      w: box.size.w * 0.2,
                      d: box.size.d * 0.2,
                      h: Math.max(box.size.h, 0.04 * scale),
                    },
                  }}
                  color={shade(part.color, 0.15)}
                  shape="cylinder"
                />
              </>
            ) : (
              <Solid
                box={box}
                color={part.color}
                shape={part.shape === 'box' ? 'prism' : 'cylinder'}
              />
            )}
          </g>
        );
      })}
    </g>
  );
}
