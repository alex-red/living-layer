import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  fixtureBox,
  framePointInPicture,
  pictureToScene,
  scenePointInPicture,
  type Fixture,
  type IsoScene,
  type DeskMemory,
  type DeskObservation,
  type Point,
  type SceneIllustration,
  type Segmentation,
  type SurfacePin,
  type ZoneRect,
} from '@livinglayer/domain';

export const illustrationUrl = (asset: string) =>
  `/api/scene/illustration?asset=${encodeURIComponent(asset)}`;

interface Marker {
  id: string;
  label: string;
  at: Point;
  focused: boolean;
}
interface Placed {
  id: string;
  label: string;
  /** The footprint's corners and centre, and where the label's leader starts: the top's centre. */
  base: Point[];
  centre: Point;
  top: Point;
  lit: boolean;
  focused: boolean;
}
interface Area {
  id: string;
  label?: string;
  points: Point[];
  inside: boolean;
  focused: boolean;
}

/**
 * The room as its picture: an image model's isometric drawing of the photo,
 * with what the camera tracks laid on its desk top. A sighting's foot and a
 * zone's corners go from the frame to the pinned surface by the pin, then onto
 * the picture's desk top, so they land where the desk is drawn. Fixtures are
 * outlined where they stand in the scene, and pick like they do on the model.
 * On the room's picture they can be dragged to where the picture shows them,
 * or nudged with the arrow keys; the drop goes back through the same mapping.
 */
export function IllustrationView({
  illustration,
  pin,
  memory,
  focus,
  showZones,
  fixtures = [],
  custom = null,
  onFixture,
  onMoveFixture,
}: {
  illustration: SceneIllustration;
  pin: SurfacePin;
  memory: DeskMemory;
  focus?: { object?: string; zone?: string; fixture?: string };
  showZones: boolean;
  /** The pinned scene's fixtures. */
  fixtures?: Fixture[];
  custom?: IsoScene | null;
  onFixture?: (id: string) => void;
  /** Move a fixture's footprint centre to a point of the scene. */
  onMoveFixture?: (id: string, to: { x: number; y: number; surfaceId: string | null }) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ id: string; start: Point; delta: Point } | null>(null);
  // Only the room's picture maps back to the scene; a desk redrawn from a frame doesn't.
  const movable = Boolean(onMoveFixture && !illustration.drawnFrom && illustration.desk);
  const pointerAt = (e: PointerEvent) => {
    const m = svg.current?.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const moveTo = (f: Placed, by: Point) => {
    const to = pictureToScene(pin, illustration, custom, {
      x: f.centre.x + by.x,
      y: f.centre.y + by.y,
    });
    if (to) onMoveFixture?.(f.id, to);
  };
  const toPicture = (frame: Segmentation['frame'], p: Point) =>
    framePointInPicture(pin, illustration, frame, p);
  const foot = (o: DeskObservation | null | undefined) =>
    o
      ? toPicture(o.frame, { x: o.box.x + o.box.width / 2, y: o.box.y + o.box.height * 0.92 })
      : null;
  const corners = (rect: ZoneRect, frame: Segmentation['frame']) => {
    const at = (u: number, v: number) =>
      toPicture(frame, { x: u * frame.width, y: v * frame.height });
    const ps = [
      at(rect.x, rect.y),
      at(rect.x + rect.width, rect.y),
      at(rect.x + rect.width, rect.y + rect.height),
      at(rect.x, rect.y + rect.height),
    ];
    return ps.every(Boolean) ? (ps as Point[]) : null;
  };

  const markers: Marker[] = [];
  const mug = foot(memory.observation);
  if (mug && memory.object)
    markers.push({
      id: 'main',
      label: memory.object.label,
      at: mug,
      focused: focus?.object === 'main',
    });
  for (const other of memory.others ?? []) {
    const at = foot(other.observation);
    if (at)
      markers.push({ id: other.id, label: other.label, at, focused: focus?.object === other.id });
  }
  const placed: Placed[] = fixtures.flatMap((f) => {
    const { at, size } = fixtureBox(f, custom);
    const to = (x: number, y: number, z: number) =>
      scenePointInPicture(pin, illustration, custom, { x, y, z });
    const base = [
      to(at.x, at.y, at.z),
      to(at.x + size.w, at.y, at.z),
      to(at.x + size.w, at.y + size.d, at.z),
      to(at.x, at.y + size.d, at.z),
    ];
    const top = to(at.x + size.w / 2, at.y + size.d / 2, at.z + size.h);
    const centre = to(at.x + size.w / 2, at.y + size.d / 2, at.z);
    if (!top || !centre || !base.every(Boolean)) return [];
    return [
      {
        id: f.id,
        label: f.label,
        base: base as Point[],
        centre,
        top,
        lit: f.control.kind === 'light' && f.state === 'on',
        focused: focus?.fixture === f.id,
      },
    ];
  });
  const areas: Area[] = [];
  if (showZones) {
    const frame = memory.zone?.frame ?? memory.observation?.frame;
    const main = memory.zone && frame ? corners(memory.zone.rect, frame) : null;
    if (main)
      areas.push({
        id: 'main',
        points: main,
        inside: memory.placement === 'inside',
        focused: focus?.zone === 'main',
      });
    for (const rule of memory.rules ?? []) {
      const points = corners(rule.zone.rect, rule.zone.frame);
      if (points)
        areas.push({
          id: rule.id,
          label: rule.label,
          points,
          inside: rule.placement === 'inside',
          focused: focus?.zone === rule.id,
        });
    }
  }
  const { width, height } = illustration.frame;
  const unit = Math.max(width, height) / 100;
  const pts = (ps: Point[]) => ps.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const objects = markers.map((m) => m.label).join(', ');
  return (
    <svg
      ref={svg}
      className="illustration"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Picture of the room${objects ? `, with ${objects} on the desk` : ''}`}
    >
      <image href={illustrationUrl(illustration.asset)} width={width} height={height} />
      {illustration.desk && (
        <polygon className="illustration-desk" points={pts(illustration.desk)} />
      )}
      {areas.map((a) => (
        <g
          key={a.id}
          className={`illustration-zone ${a.inside ? 'inside' : ''} ${a.focused ? 'focused' : ''}`}
        >
          <polygon points={pts(a.points)} strokeWidth={unit * 0.35} />
          {a.label && (
            <text x={a.points[0]!.x} y={a.points[0]!.y - unit} fontSize={unit * 1.8}>
              {a.label.toUpperCase()}
            </text>
          )}
        </g>
      ))}
      {placed.map((f) => (
        <g
          key={f.id}
          className={`illustration-fixture ${f.lit ? 'lit' : ''} ${f.focused ? 'focused' : ''} ${drag?.id === f.id ? 'dragging' : ''}`}
          data-fixture={f.id}
          role={onFixture ? 'button' : undefined}
          tabIndex={onFixture ? 0 : undefined}
          aria-label={
            onFixture
              ? `${f.label}${movable ? ': drag, or use the arrow keys, to move it' : ''}`
              : undefined
          }
          transform={drag?.id === f.id ? `translate(${drag.delta.x} ${drag.delta.y})` : undefined}
          onPointerDown={(e: PointerEvent<SVGGElement>) => {
            const start = pointerAt(e);
            if (!start) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrag({ id: f.id, start, delta: { x: 0, y: 0 } });
          }}
          onPointerMove={(e: PointerEvent<SVGGElement>) => {
            const at = drag?.id === f.id && movable ? pointerAt(e) : null;
            if (drag && at)
              setDrag({ ...drag, delta: { x: at.x - drag.start.x, y: at.y - drag.start.y } });
          }}
          onPointerUp={() => {
            if (drag?.id !== f.id) return;
            const moved = Math.hypot(drag.delta.x, drag.delta.y) > unit * 0.5;
            setDrag(null);
            if (moved) moveTo(f, drag.delta);
            else onFixture?.(f.id);
          }}
          onPointerCancel={() => setDrag(null)}
          onKeyDown={(e: KeyboardEvent<SVGGElement>) => {
            const step = unit * (e.shiftKey ? 2.5 : 0.5);
            const by = {
              ArrowLeft: { x: -step, y: 0 },
              ArrowRight: { x: step, y: 0 },
              ArrowUp: { x: 0, y: -step },
              ArrowDown: { x: 0, y: step },
            }[e.key];
            if (by && movable) {
              e.preventDefault();
              moveTo(f, by);
            } else if (e.key === 'Enter') onFixture?.(f.id);
          }}
        >
          <polygon points={pts(f.base)} />
          <line
            x1={f.top.x}
            y1={f.top.y}
            x2={f.top.x - unit * 3}
            y2={f.top.y - unit * 4}
            strokeWidth={unit * 0.25}
          />
          <text
            x={f.top.x - unit * 3.4}
            y={f.top.y - unit * 4.4}
            fontSize={unit * 1.6}
            textAnchor="end"
          >
            {f.label.toUpperCase()}
          </text>
        </g>
      ))}
      {markers.map((m) => (
        <g
          key={m.id}
          className={`illustration-marker ${m.focused ? 'focused' : ''}`}
          data-object={m.id}
        >
          <ellipse cx={m.at.x} cy={m.at.y} rx={unit * 2.4} ry={unit * 1.2} />
          <line
            x1={m.at.x}
            y1={m.at.y}
            x2={m.at.x + unit * 4}
            y2={m.at.y - unit * 7}
            strokeWidth={unit * 0.3}
          />
          <text x={m.at.x + unit * 4.6} y={m.at.y - unit * 7.4} fontSize={unit * 2}>
            {m.label.toUpperCase()}
          </text>
        </g>
      ))}
    </svg>
  );
}
