import { useEffect, useRef, useState } from 'react';
import {
  ISO_TILE_CM,
  PROP_TEMPLATES,
  TEMPLATE_IDS,
  depthOrder,
  placeTemplate,
  toIso,
  type IsoScene as Scene,
  type TemplateId,
} from '@livinglayer/domain';
import { Popover } from '../workspace/Popover';
import { Button } from '../ui/controls';
import { propSprite, type SpriteImage } from './sprites';

type Shelf = 'all' | 'furniture' | 'tabletop' | 'room';
const SHELVES: { id: Shelf; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'furniture', label: 'Furniture' },
  { id: 'tabletop', label: 'On top' },
  { id: 'room', label: 'Room' },
];
/** Things that shape the room rather than furnish it. */
const ROOM: ReadonlySet<TemplateId> = new Set(['rug', 'wall']);
const shelfOf = (id: TemplateId): Exclude<Shelf, 'all'> =>
  ROOM.has(id) ? 'room' : PROP_TEMPLATES[id].onTop ? 'tabletop' : 'furniture';

type Built = ReturnType<typeof placeTemplate>['props'];
const built = (id: TemplateId): Built => placeTemplate(id, 'thumb', 0, 0, 0).props;
const span = (props: Built, lo: (p: Built[0]) => number, hi: (p: Built[0]) => number) =>
  Math.round((Math.max(...props.map(hi)) - Math.min(...props.map(lo))) * ISO_TILE_CM);
/** A template's real size, w × d × h in centimetres. */
const SIZES = new Map(
  TEMPLATE_IDS.map((id) => {
    const props = built(id);
    return [
      id,
      [
        span(
          props,
          (p) => p.at.x,
          (p) => p.at.x + p.size.w,
        ),
        span(
          props,
          (p) => p.at.y,
          (p) => p.at.y + p.size.d,
        ),
        span(
          props,
          (p) => p.at.z,
          (p) => p.at.z + p.size.h,
        ),
      ] as const,
    ];
  }),
);

interface Thumb {
  layers: (SpriteImage & { key: string })[];
  viewBox: string;
}
const thumbs = new Map<TemplateId, Thumb>();
/**
 * A template drawn by the same kernel as the room, framed tight around its
 * sprites. A big model takes a few hundred milliseconds the first time.
 */
function thumb(id: TemplateId): Thumb {
  const hit = thumbs.get(id);
  if (hit) return hit;
  const layers = depthOrder(built(id)).map((p) => {
    const s = propSprite(p, p.role === 'lamp');
    const at = toIso(p.at);
    return { ...s, x: at.sx + s.x, y: at.sy + s.y, key: p.id };
  });
  const x0 = Math.min(...layers.map((l) => l.x));
  const y0 = Math.min(...layers.map((l) => l.y));
  const x1 = Math.max(...layers.map((l) => l.x + l.width));
  const y1 = Math.max(...layers.map((l) => l.y + l.height));
  const t = { layers, viewBox: `${x0} ${y0} ${x1 - x0} ${y1 - y0}` };
  thumbs.set(id, t);
  return t;
}
/** Draws the thumbnails one per task, so opening the editor never stalls on them. */
function useThumbs(): ReadonlyMap<TemplateId, Thumb> {
  const [, redraw] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      const id = TEMPLATE_IDS.find((i) => !thumbs.has(i));
      if (!id) return;
      timer = setTimeout(() => {
        thumb(id);
        redraw((n) => n + 1);
        next();
      }, 0);
    };
    next();
    return () => clearTimeout(timer);
  }, []);
  return thumbs;
}

/**
 * The template palette as a shelf of cards: each one the model as the room
 * draws it, its real size, and how many the scene holds. Tabletop things say
 * when there is no surface yet to put them on.
 */
export function PropPicker({
  scene,
  onAdd,
  autoFocus,
}: {
  scene: Scene;
  onAdd: (id: TemplateId) => void;
  /** Focus the search as it appears, as in a popover. */
  autoFocus?: boolean;
}) {
  const [shelf, setShelf] = useState<Shelf>('all');
  const [query, setQuery] = useState('');
  const [added, setAdded] = useState<TemplateId>();
  const art = useThumbs();
  const flash = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(flash.current), []);

  const q = query.trim().toLowerCase();
  const shown = TEMPLATE_IDS.filter(
    (id) =>
      (shelf === 'all' || shelfOf(id) === shelf) &&
      (!q || PROP_TEMPLATES[id].label.toLowerCase().includes(q) || id.includes(q)),
  );
  const counts = new Map<string, number>();
  for (const g of new Set(scene.props.map((p) => p.group))) {
    const t = scene.props.find((p) => p.group === g)?.template;
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const hasSurface = scene.surfaces.length > 0;

  function add(id: TemplateId) {
    onAdd(id);
    setAdded(id);
    clearTimeout(flash.current);
    flash.current = setTimeout(() => setAdded(undefined), 700);
  }

  return (
    <div className="prop-picker" role="group" aria-label="Add a prop">
      <div className="prop-picker-head">
        <span className="tiny">ADD</span>
        <span className="tiny prop-picker-count">
          {shown.length}/{TEMPLATE_IDS.length}
        </span>
      </div>
      <input
        type="search"
        className="prop-picker-search"
        placeholder="Find a prop…"
        aria-label="Find a prop"
        autoFocus={autoFocus}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && shown[0]) add(shown[0]);
          if (e.key === 'Escape') setQuery('');
        }}
      />
      <div className="prop-picker-shelves" role="tablist" aria-label="Kind of prop">
        {SHELVES.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={shelf === s.id}
            className={shelf === s.id ? 'on' : ''}
            onClick={() => setShelf(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="prop-picker-grid">
        {shown.map((id) => {
          const t = art.get(id);
          const cm = SIZES.get(id)!;
          const count = counts.get(id) ?? 0;
          const onTop = PROP_TEMPLATES[id].onTop;
          const label = PROP_TEMPLATES[id].label;
          const floats = onTop && !hasSurface;
          return (
            <button
              key={id}
              className={`prop-card ${added === id ? 'added' : ''}`}
              data-shelf={shelfOf(id)}
              aria-label={`Add a ${label.toLowerCase()}, ${cm.join(' by ')} cm${count ? `, ${count} in the room` : ''}${floats ? ', no surface to stand on yet' : ''}`}
              title={
                floats ? `No surface yet: the ${label.toLowerCase()} lands on the floor` : undefined
              }
              onClick={() => add(id)}
            >
              {t ? (
                <svg className="prop-card-art" viewBox={t.viewBox} aria-hidden="true">
                  {t.layers.map((l) => (
                    <image
                      key={l.key}
                      href={l.url}
                      x={l.x}
                      y={l.y}
                      width={l.width}
                      height={l.height}
                      preserveAspectRatio="none"
                    />
                  ))}
                </svg>
              ) : (
                <span className="prop-card-art pending" aria-hidden="true" />
              )}
              {count > 0 && <span className="prop-card-count">×{count}</span>}
              {onTop && (
                <span className={`prop-card-tag ${floats ? 'warn' : ''}`}>
                  {floats ? 'no surface' : 'on top'}
                </span>
              )}
              <span className="prop-card-label">{label}</span>
              <span className="prop-card-size">
                {cm[0]}×{cm[1]}×{cm[2]}
              </span>
              <span className="prop-card-plus" aria-hidden="true">
                +
              </span>
            </button>
          );
        })}
        {!shown.length && <p className="prop-picker-empty">Nothing called “{query}”.</p>}
      </div>
    </div>
  );
}

/**
 * The picker behind an "Add prop" button. It stays open while you add, so a
 * desk, a chair and a lamp take three clicks; Escape or a click outside closes it.
 */
export function PropPickerPopover({
  scene,
  onAdd,
  label = '+ Add prop',
  className,
}: {
  scene: Scene;
  onAdd: (id: TemplateId) => void;
  label?: string;
  /** Extra class on the panel, to place it: it drops below the button, left-aligned. */
  className?: string;
}) {
  return (
    <Popover
      label="Add a prop"
      className={`prop-pop ${className ?? ''}`}
      button={(open, toggle) => (
        <Button variant="ghost" aria-expanded={open} aria-haspopup="dialog" onClick={toggle}>
          {label}
        </Button>
      )}
    >
      {() => <PropPicker scene={scene} onAdd={onAdd} autoFocus />}
    </Popover>
  );
}
