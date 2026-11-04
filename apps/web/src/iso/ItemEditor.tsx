import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  fromIso,
  ISO_RISE,
  ITEM_MATERIALS,
  ITEM_SHAPES,
  STARTER_TEMPLATES,
  fixtureModel,
  fixtureSize,
  fixtureStateNames,
  isoItemSchema,
  previewItem,
  rotateItem,
  sizeInTiles,
  starterMeta,
  starterTemplateModel,
  tileCm,
  toIso,
  type Fixture,
  type FixtureInput,
  type IsoItem,
  type ItemPartDraft,
  type IsoItemDraft,
  type Paint,
  type SavedItem,
  type StarterTemplate,
  ITEM_SPRITES,
} from '@livinglayer/domain';
import { AiEdit, type AiEditStep } from './AiEdit';
import { ItemSprite } from './IsoItem';
import { useFrameQueue } from './frame';
import { useItemSprite, useViewOverlay } from './sprites';
import { Button, Check, IconButton, Segmented } from '../ui/controls';

/** Colours to offer next to the sampled ones: neutral materials, not the signal hues. */
const MATERIALS = ['#ece5d0', '#b3a796', '#73604c', '#3c554a', '#5f7c88', '#4a5164', '#1f232f'];
const PREVIEW_SCALE = ITEM_SPRITES.editor.scale;
/** The onion skin's choice that compares an unsaved edit with the saved model. */
const BEFORE_EDIT = '__saved__';
const SOURCE: Record<SavedItem['source'], string> = {
  demo: 'Demo photo',
  sampled: 'Fitted to the mask',
  spark: 'Fitted with Spark and SAM',
  placeholder: 'Placeholder from a scan',
};
const round = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/** Only the editable fields, so the working copy matches the save contract exactly. */
const editable = (item?: SavedItem | null): IsoItemDraft | null =>
  item ? { label: item.label, parts: item.parts } : null;

function nextPartId(baseId: string, taken: string[]): string {
  const stem = baseId.replace(/-\d+$/, '').slice(0, 20) || 'part';
  let n = 2;
  while (taken.includes(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

function mirrorPart(part: ItemPartDraft, axis: 'x' | 'y'): ItemPartDraft {
  if (axis === 'x') {
    return {
      ...part,
      at: { ...part.at, x: round(clamp(1 - (part.at.x + part.size.w), -0.5, 1.5)) },
      ...(part.path ? { path: part.path.map((p) => ({ ...p, x: round(1 - p.x) })) } : {}),
      ...(part.outline
        ? { outline: [...part.outline].reverse().map((p) => ({ ...p, x: round(1 - p.x) })) }
        : {}),
    };
  }
  return {
    ...part,
    at: { ...part.at, y: round(clamp(1 - (part.at.y + part.size.d), -0.5, 1.5)) },
    ...(part.path ? { path: part.path.map((p) => ({ ...p, y: round(1 - p.y) })) } : {}),
    ...(part.outline
      ? { outline: [...part.outline].reverse().map((p) => ({ ...p, y: round(1 - p.y) })) }
      : {}),
  };
}

const STUDIO_PRESETS: { id: string; label: string; template: StarterTemplate; state?: string }[] = [
  { id: 'cat:idle', label: 'Cat · idle', template: 'cat', state: 'idle' },
  { id: 'cat:sleeping', label: 'Cat · sleeping', template: 'cat', state: 'sleeping' },
  { id: 'monitor:off', label: 'Monitor · off', template: 'monitor', state: 'off' },
  { id: 'monitor:on', label: 'Monitor · on', template: 'monitor', state: 'on' },
  { id: 'lamp:off', label: 'Desk lamp · off', template: 'lamp', state: 'off' },
  { id: 'lamp:on', label: 'Desk lamp · on', template: 'lamp', state: 'on' },
  { id: 'floor-lamp:off', label: 'Floor lamp · off', template: 'floor-lamp', state: 'off' },
  { id: 'floor-lamp:on', label: 'Floor lamp · on', template: 'floor-lamp', state: 'on' },
  ...STARTER_TEMPLATES.filter(
    (t) => t !== 'cat' && t !== 'monitor' && t !== 'lamp' && t !== 'floor-lamp',
  ).map((t) => ({
    id: t,
    label: starterMeta(t).label,
    template: t,
  })),
];

function newPart(shape: ItemPartDraft['shape'], taken: string[]): ItemPartDraft {
  let n = 1;
  while (taken.includes(`${shape}-${n}`)) n++;
  const base: ItemPartDraft = {
    id: `${shape}-${n}`,
    shape,
    at: { x: 0.3, y: 0.3, z: 0 },
    size: { w: 0.4, d: 0.4, h: 0.4 },
    color: MATERIALS[1]!,
    taper: 1,
  };
  switch (shape) {
    case 'lathe':
      return {
        ...base,
        profile: [
          { r: 0.8, z: 0 },
          { r: 1, z: 0.5 },
          { r: 0.9, z: 1 },
        ],
      };
    case 'tube':
      return {
        ...base,
        size: { w: 0.3, d: 0.1, h: 0.4 },
        radius: 0.04,
        path: [
          { x: 0, y: 0.5, z: 1 },
          { x: 1, y: 0.5, z: 1 },
          { x: 1, y: 0.5, z: 0 },
          { x: 0, y: 0.5, z: 0 },
        ],
      };
    case 'extrude':
      return {
        ...base,
        radius: 0.1,
        outline: [
          { x: 0.25, y: 0 },
          { x: 0.75, y: 0 },
          { x: 1, y: 0.5 },
          { x: 0.75, y: 1 },
          { x: 0.25, y: 1 },
          { x: 0, y: 0.5 },
        ],
      };
    case 'rbox':
      return { ...base, radius: 0.15 };
    case 'blob':
      return { ...base, rough: 0.5 };
    default:
      return base;
  }
}
const NEW_PAINT: Record<Exclude<Paint['kind'], 'decal'>, (color: string) => Paint> = {
  band: (color) => ({ kind: 'band', from: 0.4, to: 0.6, color }),
  stripes: (color) => ({ kind: 'stripes', count: 8, angle: 0, width: 0.4, color }),
  dots: (color) => ({ kind: 'dots', count: 8, rows: 4, size: 0.4, color }),
  top: (color) => ({ kind: 'top', color }),
};

function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="item-slider">
      <span className="tiny">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={`Part ${label}`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>{step >= 1 ? value : value.toFixed(2)}</output>
    </label>
  );
}

/**
 * A lathe's side profile: radius across, height up. Drag a point to reshape
 * the body; points keep their order from bottom to top.
 */
function ProfileEditor({
  profile,
  onChange,
}: {
  profile: NonNullable<ItemPartDraft['profile']>;
  onChange: (profile: NonNullable<ItemPartDraft['profile']>) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const S = 100;
  const at = (e: PointerEvent<SVGSVGElement>) => {
    const ctm = svg.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return {
      r: round(Math.max(0, Math.min(1, p.x / S))),
      z: round(Math.max(0, Math.min(1, 1 - p.y / S))),
    };
  };
  return (
    <div className="item-profile">
      <svg
        ref={svg}
        viewBox={`-8 -8 ${S + 16} ${S + 16}`}
        role="img"
        aria-label="Body profile: radius across, height up"
        onPointerMove={(e) => {
          const p = active !== null && at(e);
          if (!p) return;
          const lo = profile[active! - 1]?.z ?? 0;
          const hi = profile[active! + 1]?.z ?? 1;
          const was = profile[active!];
          if (was && was.r === p.r && was.z === Math.max(lo, Math.min(hi, p.z))) return;
          onChange(
            profile.map((q, i) =>
              i === active ? { r: p.r, z: Math.max(lo, Math.min(hi, p.z)) } : q,
            ),
          );
        }}
        onPointerUp={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <line className="axis" x1={0} y1={0} x2={0} y2={S} />
        <polyline
          className="outline"
          points={[
            { r: 0, z: profile[0]!.z },
            ...profile,
            { r: 0, z: profile[profile.length - 1]!.z },
          ]
            .map((p) => `${p.r * S},${(1 - p.z) * S}`)
            .join(' ')}
        />
        {profile.map((p, i) => (
          <circle
            key={i}
            className={active === i ? 'active' : ''}
            cx={p.r * S}
            cy={(1 - p.z) * S}
            r={4}
            onPointerDown={(e) => {
              setActive(i);
              e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId);
            }}
          />
        ))}
      </svg>
      <div className="item-add">
        <Button
          size="sm"
          disabled={profile.length >= 16}
          onClick={() => {
            // Split the longest segment.
            let best = 0;
            let len = -1;
            for (let i = 1; i < profile.length; i++) {
              const d = Math.hypot(
                profile[i]!.r - profile[i - 1]!.r,
                profile[i]!.z - profile[i - 1]!.z,
              );
              if (d > len) {
                len = d;
                best = i;
              }
            }
            const a = profile[best - 1]!;
            const b = profile[best]!;
            onChange([
              ...profile.slice(0, best),
              { r: round((a.r + b.r) / 2), z: round((a.z + b.z) / 2) },
              ...profile.slice(best),
            ]);
          }}
        >
          Add point
        </Button>
        <Button
          size="sm"
          disabled={profile.length <= 2}
          onClick={() => onChange(profile.filter((_, i) => i !== Math.floor(profile.length / 2)))}
        >
          Remove point
        </Button>
      </div>
    </div>
  );
}

/**
 * A tube's 2–4 Bézier control points inside its box: edit either X·Z (side)
 * or X·Y (top) by dragging points.
 */
function TubePathEditor({
  path,
  onChange,
}: {
  path: NonNullable<ItemPartDraft['path']>;
  onChange: (path: NonNullable<ItemPartDraft['path']>) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [plane, setPlane] = useState<'xz' | 'xy'>('xz');
  const S = 100;
  const at = (e: PointerEvent<SVGSVGElement>) => {
    const ctm = svg.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return {
      u: round(clamp(p.x / S, 0, 1)),
      v: round(clamp(plane === 'xz' ? 1 - p.y / S : p.y / S, 0, 1)),
    };
  };
  const curve = Array.from({ length: 17 }, (_, i) => {
    const t = i / 16;
    const u = 1 - t;
    if (path.length === 2) {
      return {
        x: u * path[0]!.x + t * path[1]!.x,
        y: u * path[0]!.y + t * path[1]!.y,
        z: u * path[0]!.z + t * path[1]!.z,
      };
    }
    if (path.length === 3) {
      return {
        x: u * u * path[0]!.x + 2 * u * t * path[1]!.x + t * t * path[2]!.x,
        y: u * u * path[0]!.y + 2 * u * t * path[1]!.y + t * t * path[2]!.y,
        z: u * u * path[0]!.z + 2 * u * t * path[1]!.z + t * t * path[2]!.z,
      };
    }
    return {
      x:
        u * u * u * path[0]!.x +
        3 * u * u * t * path[1]!.x +
        3 * u * t * t * path[2]!.x +
        t * t * t * path[3]!.x,
      y:
        u * u * u * path[0]!.y +
        3 * u * u * t * path[1]!.y +
        3 * u * t * t * path[2]!.y +
        t * t * t * path[3]!.y,
      z:
        u * u * u * path[0]!.z +
        3 * u * u * t * path[1]!.z +
        3 * u * t * t * path[2]!.z +
        t * t * t * path[3]!.z,
    };
  });
  const toSvg = (p: { x: number; y: number; z: number }) => ({
    cx: p.x * S,
    cy: (plane === 'xz' ? 1 - p.z : p.y) * S,
  });
  return (
    <div className="item-profile">
      <div className="item-head">
        <span className="tiny">TUBE PATH · {plane === 'xz' ? 'SIDE (X·Z)' : 'TOP (X·Y)'}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPlane((p) => (p === 'xz' ? 'xy' : 'xz'))}
        >
          {plane === 'xz' ? 'Switch to Top X·Y' : 'Switch to Side X·Z'}
        </Button>
      </div>
      <svg
        ref={svg}
        viewBox={`-8 -8 ${S + 16} ${S + 16}`}
        role="img"
        aria-label="Tube path editor"
        onPointerMove={(e) => {
          const p = active !== null && at(e);
          if (!p) return;
          onChange(
            path.map((q, i) =>
              i === active
                ? plane === 'xz'
                  ? { ...q, x: p.u, z: p.v }
                  : { ...q, x: p.u, y: p.v }
                : q,
            ),
          );
        }}
        onPointerUp={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <polyline
          className="axis"
          fill="none"
          points={path
            .map((p) => {
              const c = toSvg(p);
              return `${c.cx},${c.cy}`;
            })
            .join(' ')}
        />
        <polyline
          className="outline"
          style={{ fill: 'none' }}
          points={curve
            .map((p) => {
              const c = toSvg(p);
              return `${c.cx},${c.cy}`;
            })
            .join(' ')}
        />
        {path.map((p, i) => {
          const c = toSvg(p);
          return (
            <circle
              key={i}
              className={active === i ? 'active' : ''}
              cx={c.cx}
              cy={c.cy}
              r={4}
              onPointerDown={(e) => {
                setActive(i);
                e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId);
              }}
            />
          );
        })}
      </svg>
      <div className="item-add">
        <Button
          size="sm"
          disabled={path.length >= 4}
          onClick={() => {
            const a = path[path.length - 2]!;
            const b = path[path.length - 1]!;
            onChange([
              ...path.slice(0, -1),
              {
                x: round((a.x + b.x) / 2),
                y: round((a.y + b.y) / 2),
                z: round((a.z + b.z) / 2),
              },
              b,
            ]);
          }}
        >
          Add point
        </Button>
        <Button
          size="sm"
          disabled={path.length <= 2}
          onClick={() => onChange(path.filter((_, i) => i !== Math.floor(path.length / 2)))}
        >
          Remove point
        </Button>
      </div>
    </div>
  );
}

/**
 * An extrusion's footprint polygon (3–12 vertices in X·Y). Drag a vertex to
 * reshape the footprint.
 */
function ExtrudeOutlineEditor({
  outline,
  onChange,
}: {
  outline: NonNullable<ItemPartDraft['outline']>;
  onChange: (outline: NonNullable<ItemPartDraft['outline']>) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const S = 100;
  const at = (e: PointerEvent<SVGSVGElement>) => {
    const ctm = svg.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return {
      x: round(clamp(p.x / S, 0, 1)),
      y: round(clamp(p.y / S, 0, 1)),
    };
  };
  return (
    <div className="item-profile">
      <span className="tiny">FOOTPRINT OUTLINE (X·Y)</span>
      <svg
        ref={svg}
        viewBox={`-8 -8 ${S + 16} ${S + 16}`}
        role="img"
        aria-label="Footprint outline editor"
        onPointerMove={(e) => {
          const p = active !== null && at(e);
          if (!p) return;
          onChange(outline.map((q, i) => (i === active ? p : q)));
        }}
        onPointerUp={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <polygon
          className="outline"
          points={outline.map((p) => `${p.x * S},${p.y * S}`).join(' ')}
        />
        {outline.map((p, i) => (
          <circle
            key={i}
            className={active === i ? 'active' : ''}
            cx={p.x * S}
            cy={p.y * S}
            r={4}
            onPointerDown={(e) => {
              setActive(i);
              e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId);
            }}
          />
        ))}
      </svg>
      <div className="item-add">
        <Button
          size="sm"
          disabled={outline.length >= 12}
          onClick={() => {
            let best = 0;
            let len = -1;
            for (let i = 0; i < outline.length; i++) {
              const a = outline[i]!;
              const b = outline[(i + 1) % outline.length]!;
              const d = Math.hypot(b.x - a.x, b.y - a.y);
              if (d > len) {
                len = d;
                best = i;
              }
            }
            const a = outline[best]!;
            const b = outline[(best + 1) % outline.length]!;
            onChange([
              ...outline.slice(0, best + 1),
              { x: round((a.x + b.x) / 2), y: round((a.y + b.y) / 2) },
              ...outline.slice(best + 1),
            ]);
          }}
        >
          Add vertex
        </Button>
        <Button
          size="sm"
          disabled={outline.length <= 3}
          onClick={() => onChange(outline.filter((_, i) => i !== outline.length - 1))}
        >
          Remove vertex
        </Button>
      </div>
    </div>
  );
}

function PaintLayer({
  layer,
  colours,
  onChange,
  onRemove,
}: {
  layer: Paint;
  colours: string[];
  onChange: (layer: Paint) => void;
  onRemove: () => void;
}) {
  const colour = (c: string) => onChange({ ...layer, color: c } as Paint);
  return (
    <li className="item-paint-layer">
      <div className="item-head">
        <span className="tiny">
          {layer.kind === 'decal'
            ? `PRINT FROM PHOTO · ${layer.w}×${layer.h} · ${layer.colors.length} COLOURS`
            : layer.kind.toUpperCase()}
        </span>
        <Button variant="text" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {layer.kind === 'band' && (
        <>
          <Slider
            label="FROM"
            value={layer.from}
            min={0}
            max={1}
            onChange={(v) => onChange({ ...layer, from: round(v) })}
          />
          <Slider
            label="TO"
            value={layer.to}
            min={0}
            max={1}
            onChange={(v) => onChange({ ...layer, to: round(v) })}
          />
        </>
      )}
      {layer.kind === 'stripes' && (
        <>
          <Slider
            label="COUNT"
            value={layer.count}
            min={1}
            max={24}
            step={1}
            onChange={(v) => onChange({ ...layer, count: v })}
          />
          <Slider
            label="ANGLE"
            value={layer.angle}
            min={-90}
            max={90}
            step={5}
            onChange={(v) => onChange({ ...layer, angle: v })}
          />
          <Slider
            label="WIDTH"
            value={layer.width}
            min={0.05}
            max={0.95}
            onChange={(v) => onChange({ ...layer, width: round(v) })}
          />
        </>
      )}
      {layer.kind === 'dots' && (
        <>
          <Slider
            label="COUNT"
            value={layer.count}
            min={2}
            max={24}
            step={1}
            onChange={(v) => onChange({ ...layer, count: v })}
          />
          <Slider
            label="ROWS"
            value={layer.rows}
            min={1}
            max={12}
            step={1}
            onChange={(v) => onChange({ ...layer, rows: v })}
          />
          <Slider
            label="SIZE"
            value={layer.size}
            min={0.05}
            max={0.9}
            onChange={(v) => onChange({ ...layer, size: round(v) })}
          />
        </>
      )}
      {layer.kind !== 'decal' && (
        <div className="item-colours" role="group" aria-label={`${layer.kind} colour`}>
          {colours.slice(0, 8).map((c) => (
            <button
              key={c}
              className="swatch"
              style={{ background: c }}
              aria-label={`${layer.kind} colour ${c}`}
              aria-pressed={layer.color === c}
              onClick={() => colour(c)}
            />
          ))}
          <input
            type="color"
            value={layer.color}
            aria-label={`Custom ${layer.kind} colour`}
            onChange={(e) => colour(e.target.value.toLowerCase())}
          />
        </div>
      )}
    </li>
  );
}

/** The opaque bounds of an image's alpha: the mask inside a crop's box. */
function maskBounds(img: HTMLImageElement) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(x + y * width) * 4 + 3]! >= 128) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  return x1 < 0 ? null : { w: width, h: height, x0, y0, x1, y1 };
}
/** A fixture state's small picture on its tab. */
function StateThumb({ model }: { model: IsoItem }) {
  const thumb = useItemSprite(model, ITEM_SPRITES.thumb);
  return thumb ? <img src={thumb.url} alt="" /> : <span className="studio-state-blank" />;
}
/** A fixture state at editor size, framed to its sprite. */
function StatePreview({ model, glow, label }: { model: IsoItem; glow: boolean; label: string }) {
  const sp = useItemSprite(model, {
    ...ITEM_SPRITES.editor,
    ...(glow ? { glow } : {}),
  });
  return (
    <svg
      viewBox={sp ? `${sp.x - 12} ${sp.y - 12} ${sp.width + 24} ${sp.height + 24}` : '0 0 1 1'}
      aria-label={`${label} state preview`}
    >
      <ItemSprite
        item={model}
        origin={{ x: 0, y: 0, z: 0 }}
        scale={PREVIEW_SCALE}
        resolution={ITEM_SPRITES.editor.resolution}
        glow={glow}
      />
    </svg>
  );
}
/**
 * The crop the model was fitted to, with the model's silhouette from the same
 * camera on top. Like the fit's score, the two line up at the mask's bottom
 * left, and one item unit is the mask's width.
 */
function PhotoCompare({ item, url, elevation }: { item: IsoItem; url: string; elevation: number }) {
  const [box, setBox] = useState<ReturnType<typeof maskBounds>>(null);
  const width = box ? box.x1 - box.x0 + 1 : 0;
  const overlay = useViewOverlay(box ? item : null, elevation, width);
  return (
    <div className="item-photo">
      <div className="item-photo-frame">
        <img
          src={url}
          alt="The masked photo the model was fitted to"
          onLoad={(e) => setBox(maskBounds(e.currentTarget))}
        />
        {overlay && box && (
          <img
            className="item-photo-model"
            src={overlay.url}
            alt="The model's silhouette from the photo's camera"
            style={{
              left: `${(box.x0 / box.w) * 100}%`,
              bottom: `${((box.h - 1 - box.y1) / box.h) * 100}%`,
              width: `${(overlay.width / box.w) * 100}%`,
              height: `${(overlay.height / box.h) * 100}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Isometric wireframe polygon points for a 3D box in item units, scaled by `PREVIEW_SCALE`. */
function isoBoxWireframe(
  at: { x: number; y: number; z: number },
  size: { w: number; d: number; h: number },
) {
  const s = PREVIEW_SCALE;
  const p = (x: number, y: number, z: number) => toIso({ x: x * s, y: y * s, z: z * s });
  const b00 = p(at.x, at.y, at.z);
  const b10 = p(at.x + size.w, at.y, at.z);
  const b11 = p(at.x + size.w, at.y + size.d, at.z);
  const b01 = p(at.x, at.y + size.d, at.z);
  const t00 = p(at.x, at.y, at.z + size.h);
  const t10 = p(at.x + size.w, at.y, at.z + size.h);
  const t11 = p(at.x + size.w, at.y + size.d, at.z + size.h);
  const t01 = p(at.x, at.y + size.d, at.z + size.h);
  const centerTop = p(at.x + size.w / 2, at.y + size.d / 2, at.z + size.h);
  return {
    bottom: `${b00.sx},${b00.sy} ${b10.sx},${b10.sy} ${b11.sx},${b11.sy} ${b01.sx},${b01.sy}`,
    top: `${t00.sx},${t00.sy} ${t10.sx},${t10.sy} ${t11.sx},${t11.sy} ${t01.sx},${t01.sy}`,
    hull: `${t00.sx},${t00.sy} ${t10.sx},${t10.sy} ${b10.sx},${b10.sy} ${b11.sx},${b11.sy} ${b01.sx},${b01.sy} ${t01.sx},${t01.sy}`,
    pillars: [
      [b00, t00],
      [b10, t10],
      [b11, t11],
      [b01, t01],
    ] as const,
    centerTop,
  };
}

function unrotateDelta(rx: number, ry: number, turns: number): { dx: number; dy: number } {
  const k = ((turns % 4) + 4) % 4;
  if (k === 1) return { dx: ry, dy: -rx };
  if (k === 2) return { dx: -rx, dy: -ry };
  if (k === 3) return { dx: -ry, dy: rx };
  return { dx: rx, dy: ry };
}

/**
 * Edit the remembered object's or fixture's model part by part, with a live
 * preview, state/pose ribbon, onion-skin comparison, and 2D/isometric handles.
 */
export function ItemEditor({
  item,
  fixture,
  label,
  busy,
  fitNote,
  modelWithAi,
  cropUrl,
  onDraft,
  onSave,
  onRefit,
  onFixtureState,
  onFixtureSize,
  onAiEdit,
  aiEditBlocked = null,
}: {
  item: SavedItem | null | undefined;
  fixture?: Fixture | undefined;
  /** What is being modelled: "My desk mug". */
  label: string;
  busy: boolean;
  /** What a fit on this machine does here. */
  fitNote: string;
  /** Modelling with AI, as fixtures are: Spark rebuilds it in parts from its picture. */
  modelWithAi?: ReactNode;
  /** The masked crop the model was fitted to, when there is one. */
  cropUrl: string | null;
  /** Fit it on this machine from the camera's sighting; absent for a fixture, whose model comes from its photo. */
  onDraft?: () => void;
  onSave: (item: IsoItem | null) => void;
  /** Fit again to the same crop, keeping locked parts. */
  onRefit: (item: IsoItem) => void;
  /** Switch, add, update or remove a fixture state directly from the studio. */
  onFixtureState?: (payload: {
    state?: string | null;
    fixture?: NonNullable<FixtureInput['states']>[string];
    remove?: string;
  }) => void;
  /** Resize the fixture's base footprint/height. */
  onFixtureSize?: (size: FixtureInput['size']) => void;
  /** Change the draft as the person asks, with AI: the answer, not saved, or null when there is none. */
  onAiEdit?: (prompt: string, current: IsoItem) => Promise<{ item: IsoItem; note: string } | null>;
  /** Why editing with AI can't be asked now, when it can't. */
  aiEditBlocked?: string | null;
}) {
  const [draft, setDraft] = useState<IsoItemDraft | null>(editable(item));
  // The AI's edits to this draft, each with the draft it replaced, so the last can be undone.
  const [aiSteps, setAiSteps] = useState<(AiEditStep & { before: IsoItemDraft })[]>([]);
  const [selected, setSelected] = useState(item?.parts[0]?.id ?? '');
  const [turns, setTurns] = useState(0);
  const [addShape, setAddShape] = useState<ItemPartDraft['shape']>('lathe');
  const [view, setView] = useState<'model' | 'states' | 'photo'>('model');
  const [ghostState, setGhostState] = useState<string>('');
  // How the onion skin shows: layered over the model, or side by side split by a handle.
  const [compare, setCompare] = useState<'onion' | 'wipe'>('onion');
  // The wipe's divider, as a share of the canvas across: the onion skin left of it, the model right.
  const [wipeAt, setWipeAt] = useState(0.5);
  const [wiping, setWiping] = useState(false);
  // The canvas's filter and clip ids, safe inside url(#…).
  const ids = `studio${useId().replace(/[^\w-]/g, '')}`;
  const [showBox, setShowBox] = useState(true);
  const [newStateName, setNewStateName] = useState('');
  const [copyFromState, setCopyFromState] = useState('__base__');
  const [presetId, setPresetId] = useState<string>(STUDIO_PRESETS[0]!.id);
  const perTileCm = tileCm();
  const activeTileSize = fixture ? fixtureSize(fixture) : { w: 1, d: 1, h: 1 };
  const [cmSize, setCmSize] = useState({
    w: Math.round(activeTileSize.w * perTileCm),
    d: Math.round(activeTileSize.d * perTileSizeCm(perTileCm)),
    h: Math.round(activeTileSize.h * perTileCm),
  });
  function perTileSizeCm(c: number) {
    return c;
  }
  const previewSvg = useRef<SVGSVGElement>(null);
  const [dragStart, setDragStart] = useState<{
    pointerId: number;
    clientX: number;
    clientY: number;
    at: { x: number; y: number; z: number };
  } | null>(null);

  useEffect(() => {
    setDraft(editable(item));
    setAiSteps([]);
    setSelected((s) => (item?.parts.some((p) => p.id === s) ? s : (item?.parts[0]?.id ?? '')));
    // The draft starts again from a saved change or another fixture state, not on every new `item` object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.updatedAt, fixture?.id, fixture?.state]);

  useEffect(() => {
    if (!fixture) return;
    const sz = fixtureSize(fixture);
    setCmSize({
      w: Math.round(sz.w * perTileCm),
      d: Math.round(sz.d * perTileCm),
      h: Math.round(sz.h * perTileCm),
    });
    // The size field follows the fixture's identity, state and tile size, not each new `fixture` object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    fixture?.id,
    fixture?.state,
    activeTileSize.w,
    activeTileSize.d,
    activeTileSize.h,
    perTileCm,
  ]);

  // Worked out once per change of the draft or the saved item, not on every render.
  const draftJson = useMemo(() => JSON.stringify(draft), [draft]);
  const savedJson = useMemo(() => JSON.stringify(editable(item)), [item]);
  const dirty = Boolean(draft) && draftJson !== savedJson;
  const checked = useMemo(() => (draft ? isoItemSchema.safeParse(draft) : null), [draft]);
  const valid = Boolean(checked?.success);
  // What's wrong with the working copy, named by the part it's in, when it can't be saved.
  const problem =
    checked && !checked.success
      ? (() => {
          const issue = checked.error.issues[0]!;
          const index = issue.path[0] === 'parts' ? Number(issue.path[1]) : NaN;
          const where = Number.isInteger(index) ? draft!.parts[index]?.id : null;
          return `${where ? `${where}: ` : ''}${issue.message}`;
        })()
      : null;
  const part = draft?.parts.find((p) => p.id === selected);
  // The preview follows the draft a beat behind, so a drag or a slider stays smooth while it redraws.
  // The state cards' pictures follow it a beat behind too, so a drag asks for one drawing per beat.
  const deferredDraft = useDeferredValue(draft);
  const preview = useMemo(() => (draft ? previewItem(draft) : null), [draft]);
  const shownNow = useMemo(() => (preview ? rotateItem(preview, turns) : null), [preview, turns]);
  const deferredPreview = useMemo(
    () => (deferredDraft ? previewItem(deferredDraft) : null),
    [deferredDraft],
  );
  const deferredShown = useMemo(
    () => (deferredPreview ? rotateItem(deferredPreview, turns) : null),
    [deferredPreview, turns],
  );
  // Each fixture state, its model as is (the active one the draft's) and turned to the view.
  const stateEntries = useMemo(() => {
    if (!fixture) return [];
    const active = deferredPreview ?? preview;
    return [
      { id: null, label: 'Base', size: fixture.size },
      ...fixtureStateNames(fixture).map((s) => ({
        id: s,
        label: s,
        size: fixtureSize(fixture, s),
      })),
    ].map((entry) => {
      const isActive = (fixture.state ?? null) === entry.id;
      const model = isActive && active ? active : fixtureModel(fixture, entry.id);
      return { ...entry, active: isActive, model, turned: rotateItem(model, turns) };
    });
  }, [fixture, deferredPreview, preview, turns]);
  const deferredSelect = deferredShown?.parts.findIndex((p) => p.id === selected) ?? -1;
  const sprite = useItemSprite(deferredShown, {
    ...ITEM_SPRITES.editor,
    ...(deferredSelect >= 0 ? { select: deferredSelect } : {}),
    ...(fixture?.control.kind === 'light' && fixture.state === 'on' ? { glow: true } : {}),
  });
  // What the onion skin shows under or beside the model: the saved model while there is an edit, or another state.
  const ghostItem = useMemo(() => {
    if (ghostState === BEFORE_EDIT) {
      const saved = dirty ? editable(item) : null;
      return saved ? rotateItem(previewItem(saved), turns) : null;
    }
    return fixture && ghostState
      ? rotateItem(fixtureModel(fixture, ghostState === '__base__' ? null : ghostState), turns)
      : null;
  }, [ghostState, dirty, item, fixture, turns]);
  const ghostSprite = useItemSprite(ghostItem, ITEM_SPRITES.editor);
  const update = (change: Partial<ItemPartDraft>) =>
    setDraft(
      (d) =>
        d && { ...d, parts: d.parts.map((p) => (p.id === selected ? { ...p, ...change } : p)) },
    );
  // A part dragged on the canvas moves once a frame, to where the pointer is last.
  const dragUpdate = useFrameQueue(update);
  const colours = [...new Set([...(item?.swatches.map((s) => s.hex) ?? []), ...MATERIALS])];
  const fit = item?.fit;

  if (!draft)
    return (
      <div className="item-editor empty">
        <h3>
          Model{' '}
          {/^(my|your|the|a|an)\b/i.test(label)
            ? label.toLowerCase()
            : `the ${label.toLowerCase()}`}
        </h3>
        {modelWithAi}
        <div className="item-actions">
          <Button variant="ghost" disabled={busy || !onDraft} onClick={() => onDraft?.()}>
            Fit one on this machine
          </Button>
        </div>
        <small>{fitNote}</small>
      </div>
    );

  const stateNames = fixture ? fixtureStateNames(fixture) : [];
  const nextTiles = sizeInTiles(cmSize);
  const sizeDirty =
    Boolean(fixture) &&
    (nextTiles.w !== activeTileSize.w ||
      nextTiles.d !== activeTileSize.d ||
      nextTiles.h !== activeTileSize.h);

  const shown = shownNow!;
  const shownPart = shown.parts.find((p) => p.id === selected);
  const isLitGlow = Boolean(fixture?.control.kind === 'light' && fixture.state === 'on');
  const pad = 22;
  // The canvas frames both the model and its onion skin, so a part an edit took away still shows.
  const framed = [sprite, ghostItem ? ghostSprite : null].filter((s) => s !== null);
  const left = framed.length ? Math.min(...framed.map((s) => s.x)) : 0;
  const top = framed.length ? Math.min(...framed.map((s) => s.y)) : 0;
  const right = framed.length ? Math.max(...framed.map((s) => s.x + s.width)) : 0;
  const bottom = framed.length ? Math.max(...framed.map((s) => s.y + s.height)) : 0;
  const frame = {
    x: left - pad,
    y: top - pad,
    w: right - left + 2 * pad,
    h: bottom - top + 2 * pad,
  };
  const wipe = Boolean(ghostItem) && compare === 'wipe';
  const wipeX = frame.x + wipeAt * frame.w;
  const ghostName =
    ghostState === BEFORE_EDIT ? 'Before' : ghostState === '__base__' ? 'Base' : ghostState;
  const afterName = ghostState === BEFORE_EDIT ? 'After' : (fixture?.state ?? 'Base');
  function wipeTo(clientX: number) {
    const ctm = previewSvg.current?.getScreenCTM();
    if (!ctm) return;
    const p = new DOMPoint(clientX, 0).matrixTransform(ctm.inverse());
    setWipeAt(clamp((p.x - frame.x) / frame.w, 0, 1));
  }
  const paints = part?.paint ?? [];

  function handleCanvasKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (!part) return;
    const step = 0.02;
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const dz = e.key === 'ArrowUp' ? step : -step;
      update({ at: { ...part.at, z: round(clamp(part.at.z + dz, 0, 6)) } });
      return;
    }
    const move: Record<string, [number, number]> = {
      ArrowLeft: [-step, step],
      ArrowRight: [step, -step],
      ArrowUp: [-step, -step],
      ArrowDown: [step, step],
    };
    const dir = move[e.key];
    if (dir) {
      e.preventDefault();
      const { dx, dy } = unrotateDelta(dir[0], dir[1], turns);
      update({
        at: {
          ...part.at,
          x: round(clamp(part.at.x + dx, -0.5, 1.5)),
          y: round(clamp(part.at.y + dy, -0.5, 1.5)),
        },
      });
    }
  }

  return (
    <div className="item-editor-wrap">
      {fixture && onFixtureState && (
        <div className="studio-bar" role="region" aria-label="Fixture Studio States">
          <div className="studio-states" role="tablist" aria-label="Fixture states">
            {stateEntries.map((entry) => {
              const { active, model: entryModel } = entry;
              const cmText = `${Math.round(entry.size.w * perTileCm)}×${Math.round(entry.size.d * perTileCm)}×${Math.round(entry.size.h * perTileCm)} cm`;
              return (
                <button
                  key={entry.id ?? '__base__'}
                  role="tab"
                  aria-selected={active}
                  className={`studio-state-card ${active ? 'active' : ''}`}
                  disabled={busy}
                  onClick={() => {
                    if (!active) onFixtureState({ state: entry.id });
                  }}
                >
                  <StateThumb model={entryModel} />
                  <div>
                    <strong>{entry.label}</strong>
                    <small>{cmText}</small>
                  </div>
                </button>
              );
            })}
            <div className="studio-state-new">
              <input
                aria-label="New studio state"
                placeholder="New state (e.g. alert)"
                value={newStateName}
                maxLength={24}
                onChange={(e) => setNewStateName(e.target.value)}
              />
              <Button
                size="sm"
                disabled={busy || !newStateName.trim() || !valid}
                onClick={() => {
                  const name = newStateName.trim();
                  setNewStateName('');
                  onFixtureState({
                    state: name,
                    fixture: {
                      model: previewItem(draft),
                      size: nextTiles,
                    },
                  });
                }}
              >
                + State
              </Button>
            </div>
          </div>
          <div className="studio-tools">
            <div className="studio-tool-group">
              <span className="tiny">POSE / TEMPLATE</span>
              <select
                aria-label="Starter template"
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
              >
                {STUDIO_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  const preset =
                    STUDIO_PRESETS.find((p) => p.id === presetId) ?? STUDIO_PRESETS[0]!;
                  const built = starterTemplateModel(preset.template, {
                    label: draft.label,
                    colors: colours.slice(0, 2),
                    ...(preset.state ? { state: preset.state } : {}),
                  });
                  setDraft({ label: draft.label, parts: built.parts });
                  setSelected(built.parts[0]?.id ?? '');
                }}
              >
                Load template
              </Button>
            </div>
            {stateNames.length > 0 && (
              <div className="studio-tool-group">
                <span className="tiny">COPY FROM</span>
                <select
                  aria-label="Copy model from state"
                  value={copyFromState}
                  onChange={(e) => setCopyFromState(e.target.value)}
                >
                  <option value="__base__">Base</option>
                  {stateNames.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    const src = fixtureModel(
                      fixture,
                      copyFromState === '__base__' ? null : copyFromState,
                    );
                    setDraft({ label: draft.label, parts: src.parts });
                    setSelected(src.parts[0]?.id ?? '');
                  }}
                >
                  Copy parts
                </Button>
              </div>
            )}
            <div className="studio-tool-group">
              <span className="tiny">SIZE (CM)</span>
              {(['w', 'd', 'h'] as const).map((k) => (
                <input
                  key={k}
                  type="number"
                  min={3}
                  max={240}
                  step={1}
                  aria-label={`State ${k.toUpperCase()} cm`}
                  title={`${k.toUpperCase()} in centimetres`}
                  value={cmSize[k]}
                  onChange={(e) =>
                    setCmSize({
                      ...cmSize,
                      [k]: clamp(Math.round(Number(e.target.value) || 3), 3, 240),
                    })
                  }
                />
              ))}
              {sizeDirty && (
                <Button
                  size="sm"
                  disabled={busy || !valid}
                  onClick={() => {
                    if (fixture.state) {
                      onFixtureState({
                        state: fixture.state,
                        fixture: {
                          model: previewItem(draft),
                          size: nextTiles,
                        },
                      });
                    } else {
                      onFixtureSize?.(nextTiles);
                    }
                  }}
                >
                  Save size
                </Button>
              )}
            </div>
            {fixture.state && fixture.states?.[fixture.state] && (
              <Button
                size="sm"
                variant="text"
                disabled={busy}
                onClick={() => onFixtureState({ remove: fixture.state! })}
              >
                Delete “{fixture.state}”
              </Button>
            )}
          </div>
        </div>
      )}
      {onAiEdit && (
        <AiEdit
          label={label}
          busy={busy}
          blocked={aiEditBlocked ?? (valid ? null : `Fix the model first: ${problem}.`)}
          steps={aiSteps}
          onAsk={async (prompt) => {
            const before = draft;
            const answer = await onAiEdit(prompt, previewItem(before));
            if (!answer) return false;
            setDraft({ label: answer.item.label, parts: answer.item.parts });
            setSelected((s) =>
              answer.item.parts.some((p) => p.id === s) ? s : (answer.item.parts[0]?.id ?? ''),
            );
            setAiSteps((steps) => [...steps, { prompt, note: answer.note, before }]);
            return true;
          }}
          onUndo={() => {
            const last = aiSteps.at(-1);
            if (!last) return;
            setDraft(last.before);
            setAiSteps((steps) => steps.slice(0, -1));
          }}
        />
      )}
      <div className="item-editor">
        <div className="item-parts">
          <div className="item-head">
            <span className="tiny">PARTS · {draft.parts.length}/12</span>
            {item && (
              <span className="tiny">
                {/* A Spark model with no fit record was built by Spark from the picture, not fitted. */}
                {(item.source === 'spark' && !item.fit
                  ? 'Modelled with AI'
                  : SOURCE[item.source]
                ).toUpperCase()}
              </span>
            )}
          </div>
          <ul role="listbox" aria-label="Item parts">
            {draft.parts.map((p) => (
              <li key={p.id}>
                <button
                  role="option"
                  aria-selected={p.id === selected}
                  onClick={() => setSelected(p.id)}
                >
                  <span className="swatch" style={{ background: p.color }} />
                  {p.id}
                  {p.locked && <span className="tiny">LOCKED</span>}
                  <span className="tiny">{p.shape.toUpperCase()}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="item-add">
            <select
              value={addShape}
              aria-label="New part shape"
              onChange={(e) => setAddShape(e.target.value as ItemPartDraft['shape'])}
            >
              {ITEM_SHAPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={draft.parts.length >= 12}
              onClick={() => {
                const p = newPart(
                  addShape,
                  draft.parts.map((q) => q.id),
                );
                setDraft({ ...draft, parts: [...draft.parts, p] });
                setSelected(p.id);
              }}
            >
              Add part
            </Button>
          </div>
          {part && (
            <div className="item-fields">
              <div className="item-head">
                <span className="tiny">{part.id.toUpperCase()}</span>
                <Check
                  checked={Boolean(part.locked)}
                  onChange={(locked) => update({ locked: locked || undefined })}
                >
                  <span className="tiny">KEEP ON REFIT</span>
                </Check>
                <Button
                  variant="text"
                  disabled={draft.parts.length <= 1}
                  onClick={() => {
                    const rest = draft.parts.filter((p) => p.id !== part.id);
                    setDraft({ ...draft, parts: rest });
                    setSelected(rest[0]?.id ?? '');
                  }}
                >
                  Remove part
                </Button>
              </div>
              <div className="item-add">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={draft.parts.length >= 12}
                  onClick={() => {
                    const id = nextPartId(
                      part.id,
                      draft.parts.map((q) => q.id),
                    );
                    const copy: ItemPartDraft = {
                      ...part,
                      id,
                      at: {
                        ...part.at,
                        x: round(clamp(part.at.x + 0.06, -0.5, 1.5)),
                      },
                    };
                    setDraft({ ...draft, parts: [...draft.parts, copy] });
                    setSelected(id);
                  }}
                >
                  Duplicate
                </Button>
                <Button size="sm" variant="ghost" onClick={() => update(mirrorPart(part, 'x'))}>
                  Flip X
                </Button>
                <Button size="sm" variant="ghost" onClick={() => update(mirrorPart(part, 'y'))}>
                  Flip Y
                </Button>
              </div>
              <label className="item-slider">
                <span className="tiny">SHAPE</span>
                <select
                  value={part.shape}
                  aria-label="Part shape"
                  onChange={(e) => {
                    const shape = e.target.value as ItemPartDraft['shape'];
                    const fresh = newPart(shape, []);
                    // Keep the box and colour; take the new shape's own numbers.
                    update({
                      shape,
                      profile: part.profile ?? fresh.profile,
                      path: part.path ?? fresh.path,
                      outline: part.outline ?? fresh.outline,
                      radius: part.radius ?? fresh.radius,
                      rough: part.rough ?? fresh.rough,
                    });
                  }}
                >
                  {ITEM_SHAPES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="item-slider">
                <span className="tiny">MATERIAL</span>
                <select
                  value={part.material ?? 'matte'}
                  aria-label="Part material"
                  onChange={(e) =>
                    update({ material: e.target.value as ItemPartDraft['material'] })
                  }
                >
                  {ITEM_MATERIALS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              {(['x', 'y', 'z'] as const).map((k) => (
                <Slider
                  key={k}
                  label={k.toUpperCase()}
                  value={part.at[k]}
                  min={k === 'z' ? 0 : -0.5}
                  max={k === 'z' ? 6 : 1.5}
                  onChange={(v) => update({ at: { ...part.at, [k]: round(v) } })}
                />
              ))}
              {(['w', 'd', 'h'] as const).map((k) => (
                <Slider
                  key={k}
                  label={k === 'w' ? 'WIDTH' : k === 'd' ? 'DEPTH' : 'HEIGHT'}
                  value={part.size[k]}
                  min={0.02}
                  max={k === 'h' ? 6 : 3}
                  onChange={(v) => update({ size: { ...part.size, [k]: round(v) } })}
                />
              ))}
              {part.shape === 'lathe' && (
                <Slider
                  label="WALL"
                  value={part.wall ?? 0}
                  min={0}
                  max={0.9}
                  onChange={(v) =>
                    update(
                      v > 0
                        ? {
                            wall: round(v),
                            inside: part.inside ?? { wall: part.color, liquid: null, level: 0 },
                          }
                        : { wall: undefined, inside: undefined },
                    )
                  }
                />
              )}
              {(part.shape === 'rbox' || part.shape === 'extrude' || part.shape === 'tube') && (
                <Slider
                  label={part.shape === 'tube' ? 'RADIUS' : 'ROUNDING'}
                  value={part.radius ?? 0}
                  min={0}
                  max={part.shape === 'tube' ? 0.3 : 0.5}
                  onChange={(v) => update({ radius: round(v) })}
                />
              )}
              {part.shape === 'blob' && (
                <Slider
                  label="LUMPS"
                  value={part.rough ?? 0}
                  min={0}
                  max={1}
                  onChange={(v) => update({ rough: round(v) })}
                />
              )}
              {part.shape === 'lathe' && part.profile && (
                <ProfileEditor profile={part.profile} onChange={(profile) => update({ profile })} />
              )}
              {part.shape === 'tube' && part.path && (
                <TubePathEditor path={part.path} onChange={(path) => update({ path })} />
              )}
              {part.shape === 'extrude' && part.outline && (
                <ExtrudeOutlineEditor
                  outline={part.outline}
                  onChange={(outline) => update({ outline })}
                />
              )}
              {part.inside && (
                <div className="item-inside">
                  <Slider
                    label="FILL"
                    value={part.inside.level}
                    min={0}
                    max={1}
                    onChange={(v) =>
                      update({
                        inside: {
                          ...part.inside!,
                          level: round(v),
                          liquid: part.inside!.liquid ?? (v > 0 ? MATERIALS[2]! : null),
                        },
                      })
                    }
                  />
                  <label className="item-slider">
                    <span className="tiny">LIQUID</span>
                    <input
                      type="color"
                      value={part.inside.liquid ?? MATERIALS[2]!}
                      aria-label="Liquid colour"
                      onChange={(e) =>
                        update({
                          inside: { ...part.inside!, liquid: e.target.value.toLowerCase() },
                        })
                      }
                    />
                  </label>
                </div>
              )}
              <div className="item-colours" role="group" aria-label="Part colour">
                {colours.map((c) => (
                  <button
                    key={c}
                    className="swatch"
                    style={{ background: c }}
                    aria-label={`Colour ${c}`}
                    aria-pressed={part.color === c}
                    onClick={() => update({ color: c })}
                  />
                ))}
                <input
                  type="color"
                  value={part.color}
                  aria-label="Custom colour"
                  onChange={(e) => update({ color: e.target.value.toLowerCase() })}
                />
              </div>
              <div className="item-paint">
                <span className="tiny">PAINT · {paints.length}/6</span>
                <ul>
                  {paints.map((layer, i) => (
                    <PaintLayer
                      key={i}
                      layer={layer}
                      colours={colours}
                      onChange={(next) =>
                        update({ paint: paints.map((l, j) => (j === i ? next : l)) })
                      }
                      onRemove={() => {
                        const rest = paints.filter((_, j) => j !== i);
                        update({ paint: rest.length ? rest : undefined });
                      }}
                    />
                  ))}
                </ul>
                <div className="item-add">
                  {(Object.keys(NEW_PAINT) as (keyof typeof NEW_PAINT)[]).map((kind) => (
                    <Button
                      key={kind}
                      variant="ghost"
                      size="sm"
                      disabled={paints.length >= 6}
                      onClick={() =>
                        update({ paint: [...paints, NEW_PAINT[kind](colours[1] ?? MATERIALS[5]!)] })
                      }
                    >
                      + {kind}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="item-preview">
          <div className="studio-preview-bar">
            {((fit && cropUrl) || stateNames.length > 0) && (
              <Segmented
                label="Preview"
                value={view}
                onChange={setView}
                options={[
                  { value: 'model', label: 'Model' },
                  ...(stateNames.length > 0
                    ? [{ value: 'states' as const, label: `All states (${stateNames.length})` }]
                    : []),
                  ...(fit && cropUrl ? [{ value: 'photo' as const, label: 'Photo vs model' }] : []),
                ]}
              />
            )}
            {view === 'model' && (
              <div className="studio-canvas-opts">
                <label className="studio-ghost-pick">
                  <span className="tiny">ONION SKIN</span>
                  <select
                    aria-label="Onion skin state"
                    value={ghostState}
                    onChange={(e) => setGhostState(e.target.value)}
                  >
                    <option value="">Off</option>
                    <option value={BEFORE_EDIT} disabled={!dirty}>
                      Before this edit
                    </option>
                    {fixture?.state && <option value="__base__">Base</option>}
                    {stateNames
                      .filter((s) => s !== fixture?.state)
                      .map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                  </select>
                </label>
                {ghostItem && (
                  <Segmented
                    label="Compare"
                    value={compare}
                    onChange={setCompare}
                    options={[
                      { value: 'onion', label: 'Overlay' },
                      { value: 'wipe', label: 'Wipe' },
                    ]}
                  />
                )}
                <Check checked={showBox} onChange={setShowBox}>
                  <span className="tiny">HANDLES</span>
                </Check>
              </div>
            )}
          </div>
          {view === 'photo' && fit && cropUrl ? (
            <PhotoCompare item={previewItem(draft)} url={cropUrl} elevation={fit.elevation} />
          ) : view === 'states' && fixture ? (
            <div className="studio-compare-grid" role="list" aria-label="All fixture states">
              {stateEntries.map((entry) => {
                const { active, turned: entryModel } = entry;
                const glow = fixture.control.kind === 'light' && entry.id === 'on';
                return (
                  <button
                    key={entry.id ?? '__base__'}
                    role="listitem"
                    className={`studio-compare-card ${active ? 'active' : ''}`}
                    onClick={() => {
                      onFixtureState?.({ state: entry.id });
                      setView('model');
                    }}
                  >
                    <StatePreview model={entryModel} glow={glow} label={entry.label} />
                    <div className="studio-compare-meta">
                      <strong>{entry.label}</strong>
                      <span className="tiny">
                        {entryModel.parts.length} parts · {Math.round(entry.size.w * perTileCm)}×
                        {Math.round(entry.size.d * perTileCm)}×
                        {Math.round(entry.size.h * perTileCm)} cm
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <svg
              ref={previewSvg}
              tabIndex={0}
              className={wiping ? 'wiping' : undefined}
              viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`}
              role="img"
              aria-label={`Preview of ${draft.label}`}
              onKeyDown={handleCanvasKeyDown}
              onPointerMove={(e) => {
                if (wiping) {
                  wipeTo(e.clientX);
                  return;
                }
                if (!dragStart || !part || !previewSvg.current) return;
                const ctm = previewSvg.current.getScreenCTM();
                if (!ctm) return;
                const p0 = new DOMPoint(dragStart.clientX, dragStart.clientY).matrixTransform(
                  ctm.inverse(),
                );
                const p1 = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
                const dsx = p1.x - p0.x;
                const dsy = p1.y - p0.y;
                if (e.shiftKey) {
                  const dz = -dsy / (ISO_RISE * PREVIEW_SCALE);
                  dragUpdate.push({
                    at: {
                      ...dragStart.at,
                      z: round(clamp(dragStart.at.z + dz, 0, 6)),
                    },
                  });
                  return;
                }
                const deltaTile = fromIso({ sx: dsx, sy: dsy }, 0);
                const { dx, dy } = unrotateDelta(
                  deltaTile.x / PREVIEW_SCALE,
                  deltaTile.y / PREVIEW_SCALE,
                  turns,
                );
                dragUpdate.push({
                  at: {
                    ...dragStart.at,
                    x: round(clamp(dragStart.at.x + dx, -0.5, 1.5)),
                    y: round(clamp(dragStart.at.y + dy, -0.5, 1.5)),
                  },
                });
              }}
              onPointerUp={() => {
                dragUpdate.flush();
                setDragStart(null);
                setWiping(false);
              }}
              onPointerLeave={() => {
                dragUpdate.flush();
                setDragStart(null);
                setWiping(false);
              }}
            >
              <defs>
                {/* The onion skin's solid pixels only: the soft shadow under a model would blur its outline. */}
                <filter id={`${ids}-fill`} x="-5%" y="-5%" width="110%" height="110%">
                  <feComponentTransfer in="SourceAlpha" result="solid">
                    <feFuncA type="discrete" tableValues="0 0 1 1" />
                  </feComponentTransfer>
                  <feFlood className="studio-onion-flood" />
                  <feComposite in2="solid" operator="in" />
                </filter>
                <filter id={`${ids}-edge`} x="-5%" y="-5%" width="110%" height="110%">
                  <feComponentTransfer in="SourceAlpha" result="solid">
                    <feFuncA type="discrete" tableValues="0 0 1 1" />
                  </feComponentTransfer>
                  <feMorphology in="solid" operator="dilate" radius="0.9" result="grown" />
                  <feComposite in="grown" in2="solid" operator="out" result="ring" />
                  <feFlood className="studio-onion-flood" />
                  <feComposite in2="ring" operator="in" />
                </filter>
                <clipPath id={`${ids}-before`}>
                  <rect x={frame.x} y={frame.y} width={wipeX - frame.x} height={frame.h} />
                </clipPath>
                <clipPath id={`${ids}-after`}>
                  <rect x={wipeX} y={frame.y} width={frame.x + frame.w - wipeX} height={frame.h} />
                </clipPath>
              </defs>
              {ghostItem && !wipe && (
                // Behind the model, a flat wash where the onion skin reaches past it.
                <g className="studio-onion-ghost" filter={`url(#${ids}-fill)`}>
                  <ItemSprite
                    item={ghostItem}
                    origin={{ x: 0, y: 0, z: 0 }}
                    scale={PREVIEW_SCALE}
                    resolution={ITEM_SPRITES.editor.resolution}
                  />
                </g>
              )}
              {wipe && ghostItem && (
                <g clipPath={`url(#${ids}-before)`}>
                  <ItemSprite
                    item={ghostItem}
                    origin={{ x: 0, y: 0, z: 0 }}
                    scale={PREVIEW_SCALE}
                    resolution={ITEM_SPRITES.editor.resolution}
                  />
                </g>
              )}
              <g {...(wipe ? { clipPath: `url(#${ids}-after)` } : {})}>
                <ItemSprite
                  item={deferredShown ?? shown}
                  origin={{ x: 0, y: 0, z: 0 }}
                  scale={PREVIEW_SCALE}
                  selected={selected}
                  resolution={ITEM_SPRITES.editor.resolution}
                  glow={isLitGlow}
                />
              </g>
              {ghostItem && !wipe && (
                // Over the model, the onion skin's outline, so a shape that shrank or moved shows on top.
                <g className="studio-onion-edge" filter={`url(#${ids}-edge)`}>
                  <ItemSprite
                    item={ghostItem}
                    origin={{ x: 0, y: 0, z: 0 }}
                    scale={PREVIEW_SCALE}
                    resolution={ITEM_SPRITES.editor.resolution}
                  />
                </g>
              )}
              {showBox &&
                shown.parts.map((p) => {
                  const wf = isoBoxWireframe(p.at, p.size);
                  const isSel = p.id === selected;
                  return (
                    <g key={p.id} className={`studio-part-overlay ${isSel ? 'selected' : ''}`}>
                      <polygon
                        className="studio-part-hit"
                        points={wf.hull}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setSelected(p.id);
                          const orig = draft.parts.find((q) => q.id === p.id);
                          if (!orig) return;
                          setDragStart({
                            pointerId: e.pointerId,
                            clientX: e.clientX,
                            clientY: e.clientY,
                            at: { ...orig.at },
                          });
                          previewSvg.current?.setPointerCapture(e.pointerId);
                        }}
                      />
                      {isSel && (
                        <>
                          <polygon className="studio-wire-face" points={wf.bottom} />
                          <polygon className="studio-wire-face" points={wf.top} />
                          {wf.pillars.map(([a, b], idx) => (
                            <line
                              key={idx}
                              className="studio-wire-edge"
                              x1={a.sx}
                              y1={a.sy}
                              x2={b.sx}
                              y2={b.sy}
                            />
                          ))}
                          <circle
                            className="studio-gizmo"
                            cx={wf.centerTop.sx}
                            cy={wf.centerTop.sy}
                            r={3.5}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              if (!part) return;
                              setDragStart({
                                pointerId: e.pointerId,
                                clientX: e.clientX,
                                clientY: e.clientY,
                                at: { ...part.at },
                              });
                              previewSvg.current?.setPointerCapture(e.pointerId);
                            }}
                          />
                        </>
                      )}
                    </g>
                  );
                })}
              {wipe && (
                <g
                  className="studio-wipe"
                  role="slider"
                  tabIndex={0}
                  aria-label={`${ghostName} and after`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(wipeAt * 100)}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setWiping(true);
                    previewSvg.current?.setPointerCapture(e.pointerId);
                  }}
                  onKeyDown={(e) => {
                    const by = e.key === 'ArrowLeft' ? -0.05 : e.key === 'ArrowRight' ? 0.05 : 0;
                    if (!by) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setWipeAt((w) => clamp(w + by, 0, 1));
                  }}
                >
                  <rect
                    className="studio-wipe-hit"
                    x={wipeX - frame.w * 0.02}
                    y={frame.y}
                    width={frame.w * 0.04}
                    height={frame.h}
                  />
                  <line x1={wipeX} y1={frame.y} x2={wipeX} y2={frame.y + frame.h} />
                  <circle cx={wipeX} cy={frame.y + frame.h / 2} r={frame.w * 0.024} />
                </g>
              )}
            </svg>
          )}
          {wipe && (
            <div className="studio-wipe-labels micro" aria-hidden="true">
              <span>◀ {ghostName.toUpperCase()}</span>
              <span>{afterName.toUpperCase()} ▶</span>
            </div>
          )}
          {shownPart && view === 'model' && (
            <p className="micro studio-canvas-hint">
              Click any part on the model to select it. Drag to move X·Y, Shift+drag for Z, or use
              arrow keys.
            </p>
          )}
          {fit && (
            <div className="item-fit" aria-label="How well the model matches the photo">
              <span className="tiny">
                MATCH {Math.round(fit.iou * 100)}% · COLOUR ΔE {fit.deltaE.toFixed(1)} · {fit.views}{' '}
                VIEW{fit.views === 1 ? '' : 'S'} · CAMERA {Math.round(fit.elevation)}° ·{' '}
                {fit.archetype.toUpperCase()}
              </span>
              {fit.assists.length > 0 && (
                <ul>
                  {fit.assists.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="item-turns">
            <IconButton framed label="Turn left" onClick={() => setTurns((t) => t - 1)}>
              ↺
            </IconButton>
            <IconButton framed label="Turn right" onClick={() => setTurns((t) => t + 1)}>
              ↻
            </IconButton>
          </div>
          <p
            className={`item-save-state ${dirty ? (valid ? 'unsaved' : 'invalid') : ''}`}
            role="status"
          >
            {busy
              ? 'Saving…'
              : !dirty
                ? 'Saved. Change a part, its colour or its paint, and Save model saves it.'
                : valid
                  ? 'Unsaved changes. Save model keeps them; Revert goes back to the saved model.'
                  : `Can’t save yet: ${problem}. Fix it, or Revert.`}
          </p>
          <div className="item-actions">
            <Button
              variant="primary"
              disabled={busy || !dirty || !valid}
              title={
                !dirty
                  ? 'Nothing to save: the model is as saved'
                  : !valid
                    ? `Can’t save yet: ${problem}`
                    : undefined
              }
              onClick={() => onSave(previewItem(draft))}
            >
              {fixture?.state ? `Save “${fixture.state}” model` : 'Save model'}
            </Button>
            <Button
              disabled={busy || !dirty}
              onClick={() => {
                setDraft(editable(item));
                setAiSteps([]);
              }}
            >
              Revert
            </Button>
            {fit?.crop && (
              <Button disabled={busy || !valid} onClick={() => onRefit(previewItem(draft))}>
                Refit to photo
              </Button>
            )}
            {onDraft && (
              <Button variant="ghost" disabled={busy} onClick={() => onDraft()}>
                Fit again here
              </Button>
            )}
            {item && onDraft && (
              <Button variant="danger" disabled={busy} onClick={() => onSave(null)}>
                Remove model
              </Button>
            )}
          </div>
          {onDraft && <small>{fitNote}</small>}
          {modelWithAi}
        </div>
      </div>
    </div>
  );
}
