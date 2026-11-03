import { useEffect, useState, type RefObject } from 'react';
import type {
  DeskMemory,
  DeskObservation,
  LocalTrack,
  LocalVerdict,
  Segmentation,
  UnitBox,
  WatchView,
} from '@livinglayer/domain';

/** One thing drawn over the live camera: where it is, as shares of the frame, and how sure. */
interface Sighting {
  id: string;
  label: string;
  box: UnitBox;
  /** `follow`: matched this frame. `unsure`: held still, weak. `missing`: lost. `sam`: SAM's last answer. */
  tone: 'follow' | 'unsure' | 'missing' | 'sam';
  note: string;
  /** SAM's outline, when the mask it came from is still loaded. */
  outline?: { path: string; width: number; height: number };
}
const LAYER = { local: 'LOCAL', appearance: 'LOOKS', sam: 'SAM' } as const;

/**
 * What to draw: the follow loop's mug, then what the server's watcher follows,
 * then each remembered thing's last SAM sighting when it came from a frame
 * shaped like this camera's. A thing shows once, from the freshest of these.
 */
export function sightings({
  memory,
  watch,
  follow,
  segmentation,
  aspect,
}: {
  memory?: DeskMemory | null;
  watch?: WatchView | null;
  follow?: { track: LocalTrack; verdict: LocalVerdict } | null;
  segmentation?: Segmentation;
  aspect: number;
}): Sighting[] {
  const out: Sighting[] = [];
  const mugId = memory?.object?.id;
  if (follow)
    out.push({
      id: mugId ?? 'mug',
      label: memory?.object?.label ?? 'Mug',
      box: follow.track.box,
      tone: follow.verdict !== 'follow' || follow.track.lostSteps ? 'unsure' : 'follow',
      note: follow.verdict !== 'follow' ? 'ASKING SAM' : `LOCAL · ${follow.track.score.toFixed(2)}`,
    });
  for (const t of watch?.on ? watch.things : []) {
    if (out.some((s) => s.id === t.id)) continue;
    out.push({
      id: t.id,
      label: t.label,
      box: t.box,
      // Entangled: followed, but which of two look-alikes it is isn't sure.
      tone: t.status === 'following' ? 'follow' : t.status === 'entangled' ? 'unsure' : t.status,
      note:
        t.status === 'following'
          ? `${LAYER[t.layer]} · ${t.score.toFixed(2)}`
          : t.status === 'entangled'
            ? 'WHICH ONE?'
            : t.status.toUpperCase(),
    });
  }
  const remembered: { label: string; o: DeskObservation | null | undefined; missing?: boolean }[] =
    [
      { label: memory?.object?.label ?? 'Mug', o: memory?.observation },
      ...(memory?.others ?? []).map((t) => ({ label: t.label, o: t.observation })),
      ...(memory?.fixtures ?? []).map((f) => ({
        label: f.label,
        o: f.track?.observation,
        missing: f.track?.status === 'missing',
      })),
    ];
  for (const { label, o, missing } of remembered) {
    // A sighting from a differently shaped frame is from another camera or a photo.
    if (!o || out.some((s) => s.id === o.objectId)) continue;
    if (Math.abs(o.frame.width / o.frame.height - aspect) > aspect * 0.02) continue;
    const { width: fw, height: fh } = o.frame;
    const d =
      segmentation?.frame.width === fw && segmentation.frame.height === fh
        ? segmentation.detections.find((x) => x.objectId === o.detectionId)
        : undefined;
    out.push({
      id: o.objectId,
      label,
      box: { x: o.box.x / fw, y: o.box.y / fh, width: o.box.width / fw, height: o.box.height / fh },
      tone: missing ? 'missing' : 'sam',
      note: missing ? 'MISSING' : `SAM · ${clock(o.observedAt)}`,
      outline: d && { path: d.mask.svgPath, width: d.mask.width, height: d.mask.height },
    });
  }
  return out;
}
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The video's own size, kept as it loads or its source changes size. */
function useVideoSize(video: RefObject<HTMLVideoElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const read = () => setSize({ width: el.videoWidth, height: el.videoHeight });
    read();
    el.addEventListener('loadedmetadata', read);
    el.addEventListener('resize', read);
    return () => {
      el.removeEventListener('loadedmetadata', read);
      el.removeEventListener('resize', read);
    };
  }, [video]);
  return size;
}

/**
 * Tracked things over the live camera. The SVG takes the video's own size as
 * its viewBox and fits it the way `object-fit: contain` fits the video, so
 * boxes land on the picture, not on the letterbox, at any displayed size.
 */
export function TrackingOverlay({
  video,
  ...from
}: { video: RefObject<HTMLVideoElement | null> } & Omit<
  Parameters<typeof sightings>[0],
  'aspect'
>) {
  const { width, height } = useVideoSize(video);
  if (!width || !height) return null;
  const seen = sightings({ ...from, aspect: width / height });
  const font = Math.max(10, Math.round(width / 70));
  return (
    <svg
      className="tracking-overlay"
      viewBox={`0 0 ${width} ${height}`}
      aria-label={`${seen.length} tracked ${seen.length === 1 ? 'thing' : 'things'} on the camera`}
    >
      {seen.map((s) => {
        const x = s.box.x * width,
          y = s.box.y * height,
          w = s.box.width * width,
          h = s.box.height * height;
        return (
          <g key={s.id} className={`tracked ${s.tone}`}>
            {s.outline && (
              <path
                className="outline"
                d={s.outline.path}
                transform={`translate(${x} ${y}) scale(${w / s.outline.width} ${h / s.outline.height})`}
                fillRule="evenodd"
              />
            )}
            <rect x={x} y={y} width={w} height={h} />
            <text x={x} y={Math.max(font, y - font * 0.5)} fontSize={font}>
              {s.label.toUpperCase()} · {s.note}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
