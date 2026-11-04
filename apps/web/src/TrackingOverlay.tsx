import { useEffect, useMemo, useState, type RefObject } from 'react';
import { statBadge, statTone } from './iso/StatBadges';
import { useNow } from './useNow';
import { statsStore } from './workspace/state/stats';
import { useStore } from './workspace/state/store';
import type {
  DeskMemory,
  DeskObservation,
  LocalTrack,
  LocalVerdict,
  Segmentation,
  StatKey,
  StatNow,
  UnitBox,
  WatchView,
} from '@livinglayer/domain';
import { mugOf, mugSighting, otherObjects, placedFixtures } from '@livinglayer/domain';

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
 * The thing a selection names, by the id the camera's boxes carry: the mug's
 * own id for the outline's `main` object, a thing's id, or null when the
 * selection isn't a thing.
 */
export function selectedThing(
  selection: { kind: string; id?: string } | null | undefined,
  memory: DeskMemory | null | undefined,
): string | null {
  if (selection?.kind === 'object')
    return selection.id === 'main' ? (mugOf(memory)?.id ?? null) : (selection.id ?? null);
  return selection?.kind === 'fixture' ? (selection.id ?? null) : null;
}

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
  return withRemembered(
    liveSightings(memory, watch, follow),
    remembered(memory, segmentation, aspect),
  );
}

/** What is followed now: the follow loop's mug, then the watcher's things. */
function liveSightings(
  memory: DeskMemory | null | undefined,
  watch: WatchView | null | undefined,
  follow: { track: LocalTrack; verdict: LocalVerdict } | null | undefined,
): Sighting[] {
  const out: Sighting[] = [];
  const mugId = mugOf(memory)?.id;
  if (follow)
    out.push({
      id: mugId ?? 'mug',
      label: mugOf(memory)?.label ?? 'Mug',
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
      // Entangled: followed, but which of two look-alikes it is isn't sure. Covered: held
      // where it was, behind something.
      tone:
        t.status === 'following'
          ? 'follow'
          : t.status === 'entangled' || t.status === 'covered'
            ? 'unsure'
            : t.status,
      note:
        t.status === 'following'
          ? `${LAYER[t.layer]} · ${t.score.toFixed(2)}`
          : t.status === 'entangled'
            ? 'WHICH ONE?'
            : t.status === 'covered'
              ? 'PARTLY HIDDEN'
              : t.status.toUpperCase(),
    });
  }
  return out;
}

/** The live sightings, then each remembered one of a thing they don't show. */
function withRemembered(live: Sighting[], past: Sighting[]): Sighting[] {
  if (!past.length) return live;
  const ids = new Set(live.map((s) => s.id));
  return [...live, ...past.filter((s) => !ids.has(s.id))];
}

/**
 * Each remembered thing's last SAM sighting, from a frame shaped like this
 * camera's. It changes with memory, not with each followed frame.
 */
function remembered(
  memory: DeskMemory | null | undefined,
  segmentation: Segmentation | undefined,
  aspect: number,
): Sighting[] {
  const out: Sighting[] = [];
  const things: { label: string; o: DeskObservation | null | undefined; missing?: boolean }[] = [
    { label: mugOf(memory)?.label ?? 'Mug', o: mugSighting(memory) },
    ...(otherObjects(memory) ?? []).map((t) => ({ label: t.label, o: t.observation })),
    ...placedFixtures(memory).map((f) => ({
      label: f.label,
      o: f.track?.observation,
      missing: f.track?.status === 'missing',
    })),
  ];
  for (const { label, o, missing } of things) {
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
const clockFormat = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
const clock = (iso: string) => clockFormat.format(new Date(iso));

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
  selected,
  ...from
}: {
  video: RefObject<HTMLVideoElement | null>;
  /** The selected thing's id: its box is ringed and the others step back. */
  selected?: string | null;
} & Omit<Parameters<typeof sightings>[0], 'aspect'>) {
  const { width, height } = useVideoSize(video);
  const { memory, watch, follow, segmentation } = from;
  const aspect = width && height ? width / height : 0;
  // The remembered part changes with memory; only the followed boxes change each tick.
  const past = useMemo(
    () => (aspect ? remembered(memory, segmentation, aspect) : []),
    [memory, segmentation, aspect],
  );
  if (!width || !height) return null;
  const seen = withRemembered(liveSightings(memory, watch, follow), past);
  const font = Math.max(10, Math.round(width / 70));
  const picked = selected && seen.some((s) => s.id === selected) ? selected : null;
  return (
    <svg
      className={`tracking-overlay${picked ? ' picked' : ''}`}
      viewBox={`0 0 ${width} ${height}`}
      aria-label={`${seen.length} tracked ${seen.length === 1 ? 'thing' : 'things'} on the camera`}
    >
      {seen.map((s) => {
        const x = s.box.x * width,
          y = s.box.y * height,
          w = s.box.width * width,
          h = s.box.height * height;
        return (
          <g key={s.id} className={`tracked ${s.tone}${s.id === picked ? ' selected' : ''}`}>
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

/**
 * Each thing's stats over the live camera, under its box: where the watcher
 * follows it now, else where the server says it stands. Drawn from the stats
 * store, so it renders when a stat changes or a box moves, not every frame.
 */
export function StatsOverlay({
  video,
  watch,
  memory,
}: {
  video: RefObject<HTMLVideoElement | null>;
  watch?: WatchView | null;
  memory?: DeskMemory | null;
}) {
  const { width, height } = useVideoSize(video);
  const stats = useStore(statsStore);
  const now = useNow(30_000);
  if (!width || !height) return null;
  const font = Math.max(10, Math.round(width / 80));
  const chips = Object.entries(stats).flatMap(([id, byKey]) => {
    const shown = Object.entries(byKey) as [StatKey, StatNow][];
    const box =
      (watch?.on ? watch.things.find((t) => t.id === id)?.box : undefined) ??
      shown.find(([, s]) => s.region)?.[1].region;
    if (!box || !shown.length) return [];
    const lamp = memory?.fixtures?.find((f) => f.id === id)?.control.kind === 'light';
    return [{ id, box, shown, lamp }];
  });
  if (!chips.length) return null;
  return (
    <svg
      className="stats-overlay"
      viewBox={`0 0 ${width} ${height}`}
      aria-label={`Stats of ${chips.length} ${chips.length === 1 ? 'thing' : 'things'} on the camera`}
    >
      {chips.map(({ id, box, shown, lamp }) => {
        const x = (box.x + box.width / 2) * width;
        const y = Math.min(
          height - font * shown.length,
          (box.y + box.height) * height + font * 1.2,
        );
        return (
          <g key={id} className="stat-chip">
            {shown.map(([key, s], i) => (
              <text
                key={key}
                className={statTone(s, lamp)}
                x={x}
                y={y + i * font * 1.25}
                fontSize={font}
              >
                {s.value === true ? '● ' : s.value === false ? '○ ' : ''}
                {statBadge(key, s, now)}
              </text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}
