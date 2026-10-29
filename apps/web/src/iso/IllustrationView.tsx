import {
  framePointInPicture,
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
 * the picture's desk top, so they land where the desk is drawn.
 */
export function IllustrationView({
  illustration,
  pin,
  memory,
  focus,
  showZones,
}: {
  illustration: SceneIllustration;
  pin: SurfacePin;
  memory: DeskMemory;
  focus?: { object?: string; zone?: string };
  showZones: boolean;
}) {
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
