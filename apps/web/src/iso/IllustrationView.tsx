import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  fixtureBox,
  fixtureGlows,
  fixtureModel,
  framePointInPicture,
  isoToPicture,
  rotateItem,
  pictureToScene,
  pictureToSceneAt,
  scenePointInPicture,
  spriteBox,
  type Fixture,
  type IsoItem,
  type IsoVec,
  type IsoScene,
  type DeskMemory,
  type DeskObservation,
  type Point,
  type SceneIllustration,
  type Segmentation,
  type SurfacePin,
  type ZoneRect,
  mainPlacement,
  mainZone,
  mugOf,
  mugSighting,
  otherObjects,
} from '@livinglayer/domain';
import { BaseHandles, type BaseRect } from './BaseHandles';
import { ItemSprite } from './IsoItem';

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
  /** Its footprint in the scene, and the height it stands at. */
  rect: BaseRect;
  z: number;
  /** Its own pixels, lifted off the picture, where they go now. */
  sprite?: { href: string; x: number; y: number; width: number; height: number };
  /** Its model, drawn in iso screen space and laid onto the picture by `matrix`. */
  model?: { item: IsoItem; origin: IsoVec; scale: number; matrix: string };
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
 * The selected one has handles that stretch its base. Once the fixtures are
 * lifted off the picture, the base is drawn without them and each is drawn
 * from its own cut-out where it stands now, so a move carries the thing too.
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
  onFixtureMenu,
  onResizeFixture,
  look = 'picture',
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
  /** Right-click on a fixture, at the pointer in the window. */
  onFixtureMenu?: (id: string, at: { x: number; y: number }) => void;
  /** Give a fixture a new footprint, already turned. */
  onResizeFixture?: (id: string, rect: BaseRect) => Promise<void> | void;
  /** Fixtures as the picture shows them (their cut-outs, when lifted), or as their models. */
  look?: 'picture' | 'model';
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ id: string; start: Point; delta: Point } | null>(null);
  const [stretching, setStretching] = useState<{ id: string; rect: BaseRect } | null>(null);
  // A picture redrawn from a frame maps back to the scene through the pin's camera.
  const mappable = Boolean(illustration.drawnFrom);
  const movable = Boolean(onMoveFixture && mappable);
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
  // The pinned top, where the camera sees it.
  const top = pin.corners.map((c) => toPicture(pin.frame, c));
  const desk = top.every(Boolean) ? (top as Point[]) : null;
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
  const mug = foot(mugSighting(memory));
  if (mug && mugOf(memory))
    markers.push({
      id: 'main',
      label: mugOf(memory)!.label,
      at: mug,
      focused: focus?.object === 'main',
    });
  for (const other of otherObjects(memory) ?? []) {
    const at = foot(other.observation);
    if (at)
      markers.push({ id: other.id, label: other.label, at, focused: focus?.object === other.id });
  }
  const placed: Placed[] = fixtures.flatMap((f) => {
    const box = fixtureBox(f, custom);
    const s = stretching?.id === f.id ? stretching.rect : null;
    const at = s ? { ...box.at, x: s.x, y: s.y } : box.at;
    const size = s ? { ...box.size, w: s.w, d: s.d } : box.size;
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
    const fit = look === 'model' ? isoToPicture(pin, illustration, custom, { at, size }) : null;
    const model = fit && {
      item: rotateItem(fixtureModel(f), f.turns),
      origin: at,
      scale: Math.max(size.w, size.d),
      matrix: `matrix(${fit.map((v) => v.toFixed(4)).join(' ')})`,
    };
    const lifted =
      look === 'picture' ? illustration.layers?.sprites.find((x) => x.fixtureId === f.id) : null;
    const sprite = lifted && {
      href: illustrationUrl(lifted.asset),
      ...spriteBox(lifted, { anchor: centre, w: size.w, d: size.d }),
    };
    return [
      {
        id: f.id,
        label: f.label,
        base: base as Point[],
        centre,
        top,
        lit: fixtureGlows(f),
        focused: focus?.fixture === f.id,
        rect: { x: at.x, y: at.y, w: size.w, d: size.d },
        z: at.z,
        ...(sprite ? { sprite } : {}),
        ...(model ? { model } : {}),
      },
    ];
  });
  // Lifted fixtures overlap like the things they are: the ones further back first.
  placed.sort((a, b) => a.centre.y - b.centre.y);
  const areas: Area[] = [];
  if (showZones) {
    const frame = mainZone(memory)?.frame ?? mugSighting(memory)?.frame;
    const main = mainZone(memory) && frame ? corners(mainZone(memory)!.rect, frame) : null;
    if (main)
      areas.push({
        id: 'main',
        points: main,
        inside: mainPlacement(memory) === 'inside',
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
      data-pan
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Picture of the room${objects ? `, with ${objects} on the desk` : ''}`}
    >
      <image
        href={illustrationUrl(illustration.layers?.base ?? illustration.asset)}
        width={width}
        height={height}
      />
      {desk && <polygon className="illustration-desk" points={pts(desk)} />}
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
          className={`illustration-fixture ${f.lit ? 'lit' : ''} ${f.focused ? 'focused' : ''} ${drag?.id === f.id ? 'dragging' : ''} ${f.sprite || f.model ? 'lifted' : ''}`}
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
            // Synthetic events (tests, assistive tech) may have no pointer to capture.
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* dragging still works while the pointer stays over the fixture */
            }
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
          onContextMenu={
            onFixtureMenu
              ? (e) => {
                  e.preventDefault();
                  onFixtureMenu(f.id, { x: e.clientX, y: e.clientY });
                }
              : undefined
          }
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
          {f.model && (
            <g className="illustration-model" transform={f.model.matrix}>
              <ItemSprite item={f.model.item} origin={f.model.origin} scale={f.model.scale} />
            </g>
          )}
          {f.sprite && (
            <image
              className="illustration-sprite"
              href={f.sprite.href}
              x={f.sprite.x}
              y={f.sprite.y}
              width={f.sprite.width}
              height={f.sprite.height}
              preserveAspectRatio="none"
            />
          )}
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
      {mappable &&
        onResizeFixture &&
        placed
          .filter((f) => f.focused && drag?.id !== f.id)
          .map((f) => (
            <BaseHandles
              key={`handles-${f.id}`}
              rect={f.rect}
              z={f.z}
              label={f.label}
              radius={unit * 0.7}
              project={(x, y, z) => scenePointInPicture(pin, illustration, custom, { x, y, z })}
              unproject={(e, z) => {
                const p = pointerAt(e);
                return p && pictureToSceneAt(pin, illustration, custom, p, z);
              }}
              onPreview={(rect) => setStretching(rect && { id: f.id, rect })}
              // The stretched base stays drawn until the save lands, so it doesn't snap back first.
              onDone={(rect) =>
                void Promise.resolve(onResizeFixture(f.id, rect)).finally(() => setStretching(null))
              }
            />
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
