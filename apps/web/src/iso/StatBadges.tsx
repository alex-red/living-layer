import { STAT_KINDS, ago, statWords, type StatKey, type StatNow } from '@livinglayer/domain';
import { useNow } from '../useNow';
import { useThingStats } from '../workspace/state/stats';

/** A stat in a few capitals: "ON · 2 H", "USED 12 MIN AGO", "BUSY". */
export function statBadge(key: StatKey, s: StatNow, now: number): string {
  if (s.value === null) return `${STAT_KINDS[key].label} ?`.toUpperCase();
  const words = statWords(key, s.value, now);
  const since = STAT_KINDS[key].value === 'onOff' && s.since ? ` · ${ago(now - s.since)}` : '';
  return `${key === 'lastUsed' ? `used ${words}` : words}${since}`.toUpperCase();
}
/** How a stat is drawn: cyan from the camera, amber for a lamp's confirmed light, grey when off. */
export function statTone(s: StatNow, lamp = false): string {
  if (s.value === null) return 'unknown';
  if (s.stale) return 'stale';
  if (s.source === 'entity') return lamp ? 'warm' : 'ok';
  return s.value === false || s.value === 0 ? 'off' : 'seen';
}

/** A thing's stats above its label in the room, one line, each in its tone. */
export function StatBadges({
  id,
  x,
  y,
  lamp,
}: {
  id: string;
  x: number;
  y: number;
  lamp?: boolean;
}) {
  const stats = useThingStats(id);
  const now = useNow(30_000);
  const shown = Object.entries(stats ?? {}) as [StatKey, StatNow][];
  if (!shown.length) return null;
  return (
    <text className="iso-stat" x={x} y={y} aria-label="Its stats">
      {shown.map(([key, s], i) => (
        <tspan key={key} className={statTone(s, lamp)}>
          {i ? '  ' : ''}
          {s.value === true ? '● ' : s.value === false ? '○ ' : ''}
          {statBadge(key, s, now)}
        </tspan>
      ))}
    </text>
  );
}
