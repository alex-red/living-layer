import { projectRoom, type Point, type RoomCalibration } from '@livinglayer/domain';

/**
 * The room's saved calibration over its frame: the far corner, each wall's
 * floor line as it was marked, and the floor's tiles drawn through the fitted
 * camera. Looking only: a camera that moved, or marks that were off, show as a
 * grid that no longer sits on the floor. The viewBox is the calibrated frame,
 * fitted the way `object-fit: contain` fits the video and the photo.
 */
export function CalibrationOverlay({ calibration }: { calibration: RoomCalibration }) {
  const { camera, marks } = calibration;
  const { width, height } = camera.frame;
  const lines: string[] = [];
  const draw = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const p = projectRoom(camera, { ...a, z: 0 });
    const q = projectRoom(camera, { ...b, z: 0 });
    if (p && q) lines.push(`M${p.x} ${p.y}L${q.x} ${q.y}`);
  };
  for (let x = 0; x <= camera.room.w; x += 1) draw({ x, y: 0 }, { x, y: camera.room.d });
  for (let y = 0; y <= camera.room.d; y += 1) draw({ x: 0, y }, { x: camera.room.w, y });
  const wall = (points: Point[], end: Point | null | undefined) =>
    [marks.corner, ...points, ...(end ? [end] : [])].map((p) => `${p.x},${p.y}`).join(' ');
  const r = Math.max(4, width / 160);
  return (
    <svg
      className="calibration-overlay"
      viewBox={`0 0 ${width} ${height}`}
      aria-label={`The room's calibration: its far corner and the walls' floor lines, off by ${calibration.error.toFixed(1)} px`}
    >
      <path className="calibrate-grid" d={lines.join('')} vectorEffect="non-scaling-stroke" />
      <polyline points={wall(marks.back, marks.backEnd)} vectorEffect="non-scaling-stroke" />
      <polyline points={wall(marks.left, marks.leftEnd)} vectorEffect="non-scaling-stroke" />
      <circle cx={marks.corner.x} cy={marks.corner.y} r={r * 1.4} />
    </svg>
  );
}
