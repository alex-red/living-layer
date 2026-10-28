import { useEffect, useState } from 'react';
import {
  ITEM_SHAPES,
  isoItemSchema,
  rotateItem,
  toIso,
  type IsoItem,
  type ItemPart,
  type SavedItem,
} from '@livinglayer/domain';
import { ItemParts } from './IsoItem';

/** Colours to offer next to the sampled ones: neutral materials, not the signal hues. */
const MATERIALS = ['#ece5d0', '#b3a796', '#73604c', '#3c554a', '#5f7c88', '#4a5164', '#1f232f'];
const PREVIEW_SCALE = 3;
const SOURCE: Record<SavedItem['source'], string> = {
  fixture: 'Fixture template',
  sampled: 'Sampled from the mask',
  spark: 'Drafted by Spark',
};
const round = (n: number) => Math.round(n * 100) / 100;
/** Only the editable fields, so the working copy matches the save contract exactly. */
const editable = (item?: SavedItem | null): IsoItem | null =>
  item ? { label: item.label, parts: item.parts } : null;

function previewBox(item: IsoItem) {
  const pts = item.parts.flatMap((p) =>
    [0, 1].flatMap((i) =>
      [0, 1].flatMap((j) =>
        [0, 1].map((k) =>
          toIso({
            x: (p.at.x + i * p.size.w) * PREVIEW_SCALE,
            y: (p.at.y + j * p.size.d) * PREVIEW_SCALE,
            z: (p.at.z + k * p.size.h) * PREVIEW_SCALE,
          }),
        ),
      ),
    ),
  );
  const pad = 24;
  const minX = Math.min(...pts.map((p) => p.sx)) - pad;
  const minY = Math.min(...pts.map((p) => p.sy)) - pad;
  const w = Math.max(...pts.map((p) => p.sx)) - minX + pad;
  const h = Math.max(...pts.map((p) => p.sy)) - minY + pad;
  return `${minX} ${minY} ${w} ${h}`;
}
function newPart(shape: ItemPart['shape'], taken: string[]): ItemPart {
  let n = 1;
  while (taken.includes(`${shape}-${n}`)) n++;
  return {
    id: `${shape}-${n}`,
    shape,
    at: { x: 0.3, y: 0.3, z: 0 },
    size:
      shape === 'handle'
        ? { w: 0.25, d: 0.12, h: 0.4 }
        : shape === 'lid'
          ? { w: 0.6, d: 0.6, h: 0.06 }
          : { w: 0.4, d: 0.4, h: 0.4 },
    color: MATERIALS[1]!,
    taper: shape === 'cone' ? 0.5 : 1,
  };
}

function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="item-slider">
      <span className="tiny">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={value}
        aria-label={`Part ${label}`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>{value.toFixed(2)}</output>
    </label>
  );
}

/**
 * Edit the remembered object's model part by part, with a live preview. A
 * draft starts from the mask (local) or from Spark; saving keeps it in desk
 * memory, so the iso scene draws it where the object stands.
 */
export function ItemEditor({
  item,
  busy,
  sparkNote,
  onDraft,
  onSave,
}: {
  item: SavedItem | null | undefined;
  busy: boolean;
  /** Why a Spark draft would cost something, or is unavailable. */
  sparkNote: string;
  onDraft: (source: 'sampled' | 'spark') => void;
  onSave: (item: IsoItem | null) => void;
}) {
  const [draft, setDraft] = useState<IsoItem | null>(editable(item));
  const [selected, setSelected] = useState(item?.parts[0]?.id ?? '');
  const [turns, setTurns] = useState(0);
  const [addShape, setAddShape] = useState<ItemPart['shape']>('cylinder');
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

  if (!draft)
    return (
      <div className="item-editor empty">
        <h3>Model the mug</h3>
        <p>
          Start from its mask. A sampled draft stays on this machine: a mug template in the mask's
          colours and proportions. A Spark draft sends the masked crop for a part list.
        </p>
        <div className="item-actions">
          <button className="primary" disabled={busy} onClick={() => onDraft('sampled')}>
            Sample a draft
          </button>
          <button className="secondary" disabled={busy} onClick={() => onDraft('spark')}>
            Draft with Spark
          </button>
        </div>
        <small>{sparkNote}</small>
      </div>
    );

  const shown = rotateItem(draft, turns);
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
                onChange={(e) => update({ shape: e.target.value as ItemPart['shape'] })}
              >
                {ITEM_SHAPES.map((s) => (
                  <option key={s} value={s}>
                    {s}
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
                max={k === 'z' ? 3 : 1.5}
                onChange={(v) => update({ at: { ...part.at, [k]: round(v) } })}
              />
            ))}
            {(['w', 'd', 'h'] as const).map((k) => (
              <Slider
                key={k}
                label={k === 'w' ? 'WIDTH' : k === 'd' ? 'DEPTH' : 'HEIGHT'}
                value={part.size[k]}
                min={0.02}
                max={3}
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
          </div>
        )}
      </div>
      <div className="item-preview">
        <svg viewBox={previewBox(shown)} role="img" aria-label={`Preview of ${draft.label}`}>
          <ItemParts
            item={shown}
            origin={{ x: 0, y: 0, z: 0 }}
            scale={PREVIEW_SCALE}
            selected={selected}
          />
        </svg>
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
          <button className="secondary" disabled={busy} onClick={() => onDraft('sampled')}>
            Resample
          </button>
          <button className="secondary" disabled={busy} onClick={() => onDraft('spark')}>
            Redraft with Spark
          </button>
          {item && (
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
