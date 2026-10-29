import { useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  ITEM_MATERIALS,
  ITEM_SHAPES,
  isoItemSchema,
  rotateItem,
  type IsoItem,
  type ItemPart,
  type Paint,
  type SavedItem,
} from '@livinglayer/domain';
import { ItemSprite } from './IsoItem';
import { itemSprite, viewOverlay } from './sprites';

/** Colours to offer next to the sampled ones: neutral materials, not the signal hues. */
const MATERIALS = ['#ece5d0', '#b3a796', '#73604c', '#3c554a', '#5f7c88', '#4a5164', '#1f232f'];
const PREVIEW_SCALE = 3;
const SOURCE: Record<SavedItem['source'], string> = {
  demo: 'Demo photo',
  sampled: 'Fitted to the mask',
  spark: 'Fitted with Spark and SAM',
};
const round = (n: number) => Math.round(n * 100) / 100;
/** Only the editable fields, so the working copy matches the save contract exactly. */
const editable = (item?: SavedItem | null): IsoItem | null =>
  item ? { label: item.label, parts: item.parts } : null;

function newPart(shape: ItemPart['shape'], taken: string[]): ItemPart {
  let n = 1;
  while (taken.includes(`${shape}-${n}`)) n++;
  const base: ItemPart = {
    id: `${shape}-${n}`,
    shape,
    at: { x: 0.3, y: 0.3, z: 0 },
    size: { w: 0.4, d: 0.4, h: 0.4 },
    color: MATERIALS[1]!,
    taper: shape === 'cone' ? 0.5 : 1,
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
    case 'handle':
      return { ...base, size: { w: 0.25, d: 0.12, h: 0.4 } };
    case 'lid':
      return { ...base, size: { w: 0.6, d: 0.6, h: 0.06 } };
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
  profile: NonNullable<ItemPart['profile']>;
  onChange: (profile: NonNullable<ItemPart['profile']>) => void;
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
        <button
          className="secondary"
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
        </button>
        <button
          className="secondary"
          disabled={profile.length <= 2}
          onClick={() => onChange(profile.filter((_, i) => i !== Math.floor(profile.length / 2)))}
        >
          Remove point
        </button>
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
        <button className="link" onClick={onRemove}>
          Remove
        </button>
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
/**
 * The crop the model was fitted to, with the model's silhouette from the same
 * camera on top. Like the fit's score, the two line up at the mask's bottom
 * left, and one item unit is the mask's width.
 */
function PhotoCompare({ item, url, elevation }: { item: IsoItem; url: string; elevation: number }) {
  const [box, setBox] = useState<ReturnType<typeof maskBounds>>(null);
  const width = box ? box.x1 - box.x0 + 1 : 0;
  const overlay = box ? viewOverlay(item, elevation, width) : null;
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

/**
 * Edit the remembered object's model part by part, with a live preview. A
 * draft is fitted to the mask (locally, or helped by Spark and SAM); saving
 * keeps it in desk memory, so the iso scene draws it where the object stands.
 */
export function ItemEditor({
  item,
  busy,
  sparkNote,
  cropUrl,
  onDraft,
  onSave,
  onRefit,
}: {
  item: SavedItem | null | undefined;
  busy: boolean;
  /** Why a Spark draft would cost something, or is unavailable. */
  sparkNote: string;
  /** The masked crop the model was fitted to, when there is one. */
  cropUrl: string | null;
  /** Draft again from the camera's sighting; absent for a fixture, whose model comes from its photo. */
  onDraft?: (source: 'sampled' | 'spark') => void;
  onSave: (item: IsoItem | null) => void;
  /** Fit again to the same crop, keeping locked parts. */
  onRefit: (item: IsoItem) => void;
}) {
  const [draft, setDraft] = useState<IsoItem | null>(editable(item));
  const [selected, setSelected] = useState(item?.parts[0]?.id ?? '');
  const [turns, setTurns] = useState(0);
  const [addShape, setAddShape] = useState<ItemPart['shape']>('lathe');
  const [view, setView] = useState<'model' | 'photo'>('model');
  useEffect(() => {
    setDraft(editable(item));
    setSelected((s) => (item?.parts.some((p) => p.id === s) ? s : (item?.parts[0]?.id ?? '')));
  }, [item?.updatedAt]);
  const dirty = Boolean(draft) && JSON.stringify(draft) !== JSON.stringify(editable(item));
  const valid = draft ? isoItemSchema.safeParse(draft).success : false;
  const part = draft?.parts.find((p) => p.id === selected);
  const update = (change: Partial<ItemPart>) =>
    setDraft(
      (d) =>
        d && { ...d, parts: d.parts.map((p) => (p.id === selected ? { ...p, ...change } : p)) },
    );
  const colours = [...new Set([...(item?.swatches.map((s) => s.hex) ?? []), ...MATERIALS])];
  const fit = item?.fit;

  if (!draft)
    return (
      <div className="item-editor empty">
        <h3>Model the mug</h3>
        <p>
          Fit a model to its mask. A local fit measures the shape, colours and print from the masked
          photo on this machine. With Spark, Meta’s models help: Spark names the shape and material
          and checks the result, and SAM finds parts such as the handle.
        </p>
        <div className="item-actions">
          <button
            className="primary"
            disabled={busy || !onDraft}
            onClick={() => onDraft?.('sampled')}
          >
            Sample a draft
          </button>
          <button
            className="secondary"
            disabled={busy || !onDraft}
            onClick={() => onDraft?.('spark')}
          >
            Draft with Spark
          </button>
        </div>
        <small>{sparkNote}</small>
      </div>
    );

  const shown = rotateItem(draft, turns);
  const selectIndex = shown.parts.findIndex((p) => p.id === selected);
  const sprite = itemSprite(shown, {
    scale: PREVIEW_SCALE,
    resolution: 64,
    ...(selectIndex >= 0 ? { select: selectIndex } : {}),
  });
  const pad = 16;
  const paints = part?.paint ?? [];
  return (
    <div className="item-editor">
      <div className="item-parts">
        <div className="item-head">
          <span className="tiny">PARTS · {draft.parts.length}/12</span>
          {item && <span className="tiny">{SOURCE[item.source].toUpperCase()}</span>}
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
            onChange={(e) => setAddShape(e.target.value as ItemPart['shape'])}
          >
            {ITEM_SHAPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            className="secondary"
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
          </button>
        </div>
        {part && (
          <div className="item-fields">
            <div className="item-head">
              <span className="tiny">{part.id.toUpperCase()}</span>
              <label className="tiny item-lock">
                <input
                  type="checkbox"
                  checked={Boolean(part.locked)}
                  onChange={(e) => update({ locked: e.target.checked || undefined })}
                />
                KEEP ON REFIT
              </label>
              <button
                className="link"
                disabled={draft.parts.length <= 1}
                onClick={() => {
                  const rest = draft.parts.filter((p) => p.id !== part.id);
                  setDraft({ ...draft, parts: rest });
                  setSelected(rest[0]?.id ?? '');
                }}
              >
                Remove part
              </button>
            </div>
            <label className="item-slider">
              <span className="tiny">SHAPE</span>
              <select
                value={part.shape}
                aria-label="Part shape"
                onChange={(e) => {
                  const shape = e.target.value as ItemPart['shape'];
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
                onChange={(e) => update({ material: e.target.value as ItemPart['material'] })}
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
            {part.shape === 'cone' && (
              <Slider
                label="TAPER"
                value={part.taper}
                min={0}
                max={2}
                onChange={(v) => update({ taper: round(v) })}
              />
            )}
            {(part.shape === 'lathe' || part.shape === 'cylinder') && (
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
                      update({ inside: { ...part.inside!, liquid: e.target.value.toLowerCase() } })
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
                  <button
                    key={kind}
                    className="secondary"
                    disabled={paints.length >= 6}
                    onClick={() =>
                      update({ paint: [...paints, NEW_PAINT[kind](colours[1] ?? MATERIALS[5]!)] })
                    }
                  >
                    + {kind}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="item-preview">
        {fit && cropUrl && (
          <div className="item-views iso-panels" role="group" aria-label="Preview">
            <button aria-pressed={view === 'model'} onClick={() => setView('model')}>
              Model
            </button>
            <button aria-pressed={view === 'photo'} onClick={() => setView('photo')}>
              Photo vs model
            </button>
          </div>
        )}
        {view === 'photo' && fit && cropUrl ? (
          <PhotoCompare item={draft} url={cropUrl} elevation={fit.elevation} />
        ) : (
          <svg
            viewBox={`${sprite.x - pad} ${sprite.y - pad} ${sprite.width + 2 * pad} ${sprite.height + 2 * pad}`}
            role="img"
            aria-label={`Preview of ${draft.label}`}
          >
            <ItemSprite
              item={shown}
              origin={{ x: 0, y: 0, z: 0 }}
              scale={PREVIEW_SCALE}
              selected={selected}
              resolution={64}
            />
          </svg>
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
          <button
            className="secondary"
            aria-label="Turn left"
            onClick={() => setTurns((t) => t - 1)}
          >
            ⟲
          </button>
          <button
            className="secondary"
            aria-label="Turn right"
            onClick={() => setTurns((t) => t + 1)}
          >
            ⟳
          </button>
        </div>
        <div className="item-actions">
          <button
            className="primary"
            disabled={busy || !dirty || !valid}
            onClick={() => onSave(draft)}
          >
            Save model
          </button>
          <button
            className="secondary"
            disabled={busy || !dirty}
            onClick={() => setDraft(editable(item))}
          >
            Revert
          </button>
          {fit?.crop && (
            <button className="secondary" disabled={busy || !valid} onClick={() => onRefit(draft)}>
              Refit to photo
            </button>
          )}
          {onDraft && (
            <>
              <button className="secondary" disabled={busy} onClick={() => onDraft('sampled')}>
                Resample
              </button>
              <button className="secondary" disabled={busy} onClick={() => onDraft('spark')}>
                Redraft with Spark
              </button>
            </>
          )}
          {item && onDraft && (
            <button className="link" disabled={busy} onClick={() => onSave(null)}>
              Remove model
            </button>
          )}
        </div>
        <small>{sparkNote}</small>
      </div>
    </div>
  );
}
