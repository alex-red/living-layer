import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { placeRecipe, type FixtureRecipe, type SelectionShape } from '@livinglayer/domain';
import { propSprite } from '../iso/sprites';
import { typing } from '../shortcuts';
import { Button, IconButton } from '../ui/controls';
import { CLOSE_SHARE, type Brush, type BrushStroke, type Share } from './useBrush';

/** Points of a shape or a stroke on the 0–1000 overlay. */
const pts = (points: Share[]) => points.map((p) => `${p.x * 1000},${p.y * 1000}`).join(' ');
const ofShape = (s: SelectionShape): Share[] =>
  s.kind === 'polygon'
    ? s.points.map((p) => ({ x: p.x / 1000, y: p.y / 1000 }))
    : [
        { x: s.box.x1 / 1000, y: s.box.y1 / 1000 },
        { x: s.box.x2 / 1000, y: s.box.y1 / 1000 },
        { x: s.box.x2 / 1000, y: s.box.y2 / 1000 },
        { x: s.box.x1 / 1000, y: s.box.y2 / 1000 },
      ];
/** A drag this long (in shares) is a box; shorter, it is a click that adds a polygon point. */
const DRAG = 0.01;

/**
 * The AI brush over the camera's picture: drag for a box, or click points
 * for a polygon (click the first point, double-click or press Enter to close
 * it; Backspace takes the last point back; Esc clears). The finished
 * selection stays drawn while the panel beside the frame is open.
 */
export function BrushOverlay({
  brush,
  point,
}: {
  brush: Brush;
  point: (e: PointerEvent<SVGSVGElement>) => Share;
}) {
  const down = useRef<{ at: Share; dragging: boolean } | null>(null);
  const [hover, setHover] = useState<Share | null>(null);
  const { stroke, setStroke, finish, shape } = brush;
  const polygon = stroke?.kind === 'polygon' ? stroke.points : null;
  const close = () => polygon && polygon.length >= 3 && void finish(stroke!);

  useEffect(() => {
    if (!polygon) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (e.key === 'Enter') close();
      else if (e.key === 'Backspace') {
        e.preventDefault();
        setStroke(polygon.length > 1 ? { kind: 'polygon', points: polygon.slice(0, -1) } : null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <svg
      className="zone-overlay drawing brush-overlay"
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      aria-label="AI brush: drag a box, or click points around a thing"
      onPointerDown={(e) => {
        down.current = { at: point(e), dragging: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const p = point(e);
        setHover(p);
        const d = down.current;
        if (!d || polygon) return;
        if (!d.dragging && Math.hypot(p.x - d.at.x, p.y - d.at.y) > DRAG) d.dragging = true;
        if (d.dragging) setStroke({ kind: 'rect', a: d.at, b: p });
      }}
      onPointerUp={(e) => {
        const d = down.current;
        down.current = null;
        if (!d) return;
        if (d.dragging && stroke?.kind === 'rect') return void finish(stroke);
        // A click: start a polygon, add to it, or close it on its first point.
        const p = point(e);
        if (!polygon) return setStroke({ kind: 'polygon', points: [p] });
        const first = polygon[0]!;
        if (polygon.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) < CLOSE_SHARE)
          return close();
        setStroke({ kind: 'polygon', points: [...polygon, p] });
      }}
      onPointerCancel={() => {
        down.current = null;
      }}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={close}
    >
      {shape && !stroke && <polygon className="brush-shape" points={pts(ofShape(shape))} />}
      {stroke?.kind === 'rect' && (
        <polygon
          className="brush-stroke"
          points={pts(ofShape({ kind: 'rect', box: rectBox(stroke) }))}
        />
      )}
      {polygon && (
        <polyline className="brush-stroke" points={pts(hover ? [...polygon, hover] : polygon)} />
      )}
    </svg>
  );
}
const rectBox = (s: Extract<BrushStroke, { kind: 'rect' }>) => ({
  x1: Math.min(s.a.x, s.b.x) * 1000,
  y1: Math.min(s.a.y, s.b.y) * 1000,
  x2: Math.max(s.a.x, s.b.x) * 1000,
  y2: Math.max(s.a.y, s.b.y) * 1000,
});

/** A recipe drawn by the room's own kernel, for the review. */
function RecipePreview({ recipe }: { recipe: FixtureRecipe }) {
  const sprite = useMemo(
    () => propSprite(placeRecipe(recipe, 'preview', 0, 0).props[0]!, false),
    [recipe],
  );
  return (
    <img
      className="brush-preview"
      src={sprite.url}
      width={sprite.width}
      height={sprite.height}
      alt={`${recipe.label}, as it would be drawn in the room`}
    />
  );
}

const SUGGEST_NEW = [
  'Make it its own fixture',
  'It’s an IKEA Alex desk: make it its own furniture',
];
const SUGGEST_EDIT = ['Make it green', 'Make the drawers white', 'It is 140 cm wide'];

/**
 * Beside the frame while something is selected: what it is, a box to say
 * what to do, and the draft to review (the model, where its facts came
 * from, how it matches the camera) with Put in the room and Discard.
 */
export function BrushPanel({ brush, busy }: { brush: Brush; busy: boolean }) {
  const [prompt, setPrompt] = useState('');
  const { shape, resolved, last, runs, working } = brush;
  if (!shape) return null;
  const d = last?.output ?? null;
  const target = d?.target ?? resolved?.target ?? null;
  const runnerUp = resolved?.ambiguous ? resolved.candidates[1]?.target : null;
  const recipe = d?.recipe ?? null;
  const submit = (text = prompt) => {
    if (!text.trim()) return;
    void brush.send(text);
    setPrompt('');
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <aside className="brush-panel" aria-label="AI brush">
      <header>
        <span className="tiny">AI BRUSH</span>
        <IconButton label="Clear the selection (Esc)" size="sm" onClick={brush.clear}>
          ×
        </IconButton>
      </header>
      <p className="brush-target">
        {!resolved && !d ? (
          'Finding what you selected…'
        ) : target ? (
          <>
            <strong>{target.label}</strong> <small>{target.kind}</small>
            {runnerUp && <small> · or the {runnerUp.label.toLowerCase()}?</small>}
          </>
        ) : (
          <>Something the room doesn’t have yet</>
        )}
      </p>
      {runs.length > 1 && (
        <ol className="brush-history" aria-label="Your requests">
          {runs.slice(0, -1).map((r) => (
            <li key={r.id}>{r.output.prompt}</li>
          ))}
        </ol>
      )}
      {d && (
        <section className="brush-draft" aria-label="Draft">
          <p className="brush-said">“{d.prompt}”</p>
          {d.question ? (
            <p className="brush-question">{d.question}</p>
          ) : recipe ? (
            <>
              <div className="brush-model">
                <RecipePreview recipe={recipe} />
                <div>
                  <strong>{recipe.label}</strong>
                  <span className="micro">
                    {recipe.sizeCm.w} × {recipe.sizeCm.d} × {recipe.sizeCm.h} cm ·{' '}
                    {recipe.parts.length} parts
                  </span>
                  {d.check && (
                    <span className={`micro ${d.check.iou >= 0.75 ? 'ok' : 'unsure'}`}>
                      Matches the camera {pct(d.check.iou)}
                      {d.rounds.length ? ` after ${d.rounds.length} refinement(s)` : ''}
                    </span>
                  )}
                </div>
              </div>
              {d.check && <p className="micro">{d.check.report}</p>}
              {d.disagreement.map((x) => (
                <p key={x.axis} className="micro brush-warn">
                  The camera sees {x.photoCm} cm{' '}
                  {x.axis === 'w' ? 'wide' : x.axis === 'd' ? 'deep' : 'tall'}, not {x.factCm} cm:
                  is it this product?
                </p>
              ))}
              {d.facts && d.facts.sources.length > 0 && (
                <ul className="brush-sources" aria-label="Where its facts came from">
                  {d.facts.sources.map((s) => (
                    <li key={`${s.kind}${s.title}`}>
                      <small>{s.kind}</small>{' '}
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noreferrer">
                          {s.title}
                        </a>
                      ) : (
                        s.title
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="micro">Nothing to model: {d.intent.ops.map((o) => o.op).join(', ')}.</p>
          )}
          {d.intent.dropped.map((why) => (
            <p key={why} className="micro brush-warn">
              Left out: {why}
            </p>
          ))}
          {recipe && d.place && (
            <div className="brush-actions">
              <Button
                variant="primary"
                size="sm"
                busy={working === 'save' ? 'Putting it in…' : undefined}
                disabled={busy || Boolean(working)}
                onClick={() => void brush.save()}
              >
                Put in the room
              </Button>
              <Button size="sm" variant="text" onClick={brush.clear}>
                Discard
              </Button>
            </div>
          )}
        </section>
      )}
      <form
        className="brush-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          aria-label="What to do with the selection"
          rows={2}
          value={prompt}
          maxLength={400}
          placeholder={
            d?.question
              ? 'Your answer'
              : recipe
                ? 'Change it: “make the top oak”, “it is 75 cm tall”'
                : 'Say what to do: “It’s an IKEA Alex desk, make it its own furniture”'
          }
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button
          type="submit"
          size="sm"
          variant="primary"
          busy={working === 'send' ? 'Working…' : undefined}
          disabled={busy || Boolean(working) || !prompt.trim()}
        >
          Send
        </Button>
      </form>
      {!d?.question && (
        <div className="brush-suggest">
          {(recipe ? SUGGEST_EDIT : SUGGEST_NEW).map((s) => (
            <Button
              key={s}
              size="sm"
              variant="ghost"
              disabled={busy || Boolean(working)}
              onClick={() => submit(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      )}
    </aside>
  );
}
