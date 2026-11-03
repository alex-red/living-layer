import {
  STAT_KEYS,
  STAT_KINDS,
  ago,
  dayOf,
  statWords,
  suggestedStats,
  totalWords,
  type StatEvent,
  type StatKey,
  type StatNow,
  type ThingStat,
  type ThingStatsView,
} from '@livinglayer/domain';
import { Button, Check } from '../ui/controls';
import { useNow } from '../useNow';
import { useDesk, useLabParts, useView } from './LabContext';
import { Details, useCall } from './panel';
import { useStatHistory, useThingStats } from './state/stats';
import './thing-stats.css';

const DAY_MS = 86_400_000;

/**
 * A thing's stats: each one switched on, its value now and since when, how
 * long or how often today, a ribbon of the last 24 hours and the last week's
 * totals. Stats it usually has are offered first.
 */
export function ThingStats({ id, label, type }: { id: string; label: string; type?: string }) {
  const lab = useLabParts(useView(), useDesk());
  const { mode, memory } = lab;
  const on = memory?.thingStats?.[id] ?? [];
  const now = useThingStats(id);
  const version = on.map((s) => `${s.key}:${now?.[s.key]?.value}:${now?.[s.key]?.since}`).join();
  const history = useStatHistory(mode, id, version);
  const { call, off } = useCall();
  const suggested = suggestedStats({ type, label });
  const lamp = memory?.fixtures?.find((f) => f.id === id)?.control.kind === 'light';
  const save = (stats: ThingStat[]) => void call('things/stats', { id, stats }, () => {});
  const left = STAT_KEYS.filter((k) => !on.some((s) => s.key === k)).sort(
    (a, b) => Number(suggested.includes(b)) - Number(suggested.includes(a)),
  );
  return (
    <Details summary={`Stats${on.length ? ` · ${on.length}` : ''}`} open={on.length > 0}>
      {on.length === 0 && (
        <p className="micro">
          {suggested.length
            ? `A ${label.toLowerCase()} usually keeps ${suggested.map((k) => STAT_KINDS[k].label.toLowerCase()).join(' and ')}. Worked out on this machine from the camera, or from its light when it has one.`
            : 'Keep a stat from the camera, worked out on this machine.'}
        </p>
      )}
      {on.map((stat) => (
        <StatRow
          key={stat.key}
          stat={stat}
          now={now?.[stat.key]}
          history={history}
          lamp={lamp}
          disabled={off}
          onLearn={(look) => void call('things/learn', { id, key: stat.key, look }, () => {})}
          onChange={(next) =>
            save(
              next ? on.map((s) => (s.key === stat.key ? next : s)) : on.filter((s) => s !== stat),
            )
          }
        />
      ))}
      {left.length > 0 && (
        <div className="stat-picks" role="group" aria-label="Stats to keep">
          {left.map((k) => (
            <Button
              key={k}
              size="sm"
              variant={suggested.includes(k) && !on.length ? 'primary' : 'secondary'}
              disabled={off}
              onClick={() => save([...on, { key: k }])}
            >
              + {STAT_KINDS[k].label}
            </Button>
          ))}
        </div>
      )}
    </Details>
  );
}

function StatRow({
  stat,
  now,
  history,
  lamp,
  disabled,
  onLearn,
  onChange,
}: {
  stat: ThingStat;
  now: StatNow | undefined;
  history: ThingStatsView | null;
  lamp: boolean;
  disabled: boolean;
  onLearn: (look: 'off' | 'on' | 'empty') => void;
  onChange: (next: ThingStat | null) => void;
}) {
  const clock = useNow(stat.key === 'lastUsed' ? 15_000 : 5000);
  const kind = STAT_KINDS[stat.key];
  const value = now?.value ?? null;
  const tone =
    value === null
      ? 'unknown'
      : now?.source === 'entity'
        ? lamp
          ? 'warm'
          : 'ok'
        : value === false || value === 0
          ? 'off'
          : 'seen';
  const events = (history?.events ?? []).filter((e) => e.key === stat.key);
  const days = (history?.days ?? []).filter((d) => d.key === stat.key);
  return (
    <section className={`stat-row ${tone}`} aria-label={kind.label}>
      <header>
        <span className="stat-name">{kind.label}</span>
        <strong className="stat-value">{statWords(stat.key, value, clock)}</strong>
        {value !== null && now?.since && kind.value !== 'time' && (
          <span className="stat-since">for {ago(clock - now.since)}</span>
        )}
        <span className="stat-source">
          {now?.stale
            ? 'LAST SEEN'
            : now?.source === 'entity'
              ? 'ITS LIGHT'
              : now?.source === 'sam'
                ? 'SAM'
                : now?.source === 'person'
                  ? 'BY HAND'
                  : 'CAMERA'}
        </span>
      </header>
      {now?.reason && <p className="micro stat-reason">{now.reason}</p>}
      {now && now.needs.length > 0 && (
        <div className="stat-learn">
          {now.needs.map((look) => (
            <Button key={look} size="sm" disabled={disabled} onClick={() => onLearn(look)}>
              It’s {look} now
            </Button>
          ))}
        </div>
      )}
      <Ribbon stat={stat.key} events={events} now={clock} />
      <div className="stat-foot">
        <span>
          Today: <strong>{totalWords(stat.key, now?.today ?? 0)}</strong>
          {kind.daily === 'onSeconds' ? ' on' : kind.daily === 'activeSeconds' ? ' active' : ''}
        </span>
        <Week days={days} stat={stat.key} now={clock} />
      </div>
      <div className="stat-actions">
        {kind.learn.length > 0 && now?.needs.length === 0 && now.source !== 'entity' && (
          <Button
            variant="text"
            size="sm"
            disabled={disabled}
            onClick={() => onLearn(kind.learn[0]!)}
          >
            Learn {kind.learn[0]} again
          </Button>
        )}
        {stat.key === 'occupied' && (
          <Check
            checked={Boolean(stat.samConfirm)}
            disabled={disabled}
            onChange={(samConfirm) => onChange({ ...stat, samConfirm })}
          >
            Confirm with SAM (billed, when tracking may call AI)
          </Check>
        )}
        <Button variant="text" size="sm" disabled={disabled} onClick={() => onChange(null)}>
          Stop keeping
        </Button>
      </div>
    </section>
  );
}

/** The last 24 hours: when it was on, each use, or how busy, from its changes. */
function Ribbon({ stat, events, now }: { stat: StatKey; events: StatEvent[]; now: number }) {
  const W = 240;
  const H = 16;
  const from = now - DAY_MS;
  const x = (t: number) => Math.max(0, Math.min(W, ((t - from) / DAY_MS) * W));
  const kind = STAT_KINDS[stat];
  const spans = events.map((e, i) => ({
    e,
    x0: x(e.at),
    x1: x(events[i + 1]?.at ?? now),
  }));
  return (
    <svg
      className="stat-ribbon"
      viewBox={`0 0 ${W} ${H + 10}`}
      role="img"
      aria-label={`${kind.label} over the last 24 hours`}
    >
      <rect className="track" x={0} y={0} width={W} height={H} />
      {kind.value === 'time'
        ? events
            .filter((e) => e.at >= from)
            .map((e) => (
              <rect key={e.at} className="tick" x={x(e.at) - 1} y={1} width={2} height={H - 2} />
            ))
        : spans.map(({ e, x0, x1 }) =>
            e.value === null ? (
              <rect
                key={e.at}
                className="unknown"
                x={x0}
                y={H / 2 - 1}
                width={x1 - x0}
                height={2}
              />
            ) : kind.value === 'level' ? (
              <rect
                key={e.at}
                className="level"
                x={x0}
                y={H - (e.value as number) * H}
                width={x1 - x0}
                height={(e.value as number) * H}
              />
            ) : e.value ? (
              <rect
                key={e.at}
                className={`on ${e.source}`}
                x={x0}
                y={1}
                width={x1 - x0}
                height={H - 2}
              />
            ) : null,
          )}
      {[0, 6, 12, 18].map((h) => (
        <line key={h} className="grid" x1={(h / 24) * W} x2={(h / 24) * W} y1={H} y2={H + 3} />
      ))}
      <text x={0} y={H + 9}>
        24 h ago
      </text>
      <text x={W} y={H + 9} textAnchor="end">
        now
      </text>
    </svg>
  );
}

/** The last seven days' totals as small bars, today last. */
function Week({ days, stat, now }: { days: ThingStatsView['days']; stat: StatKey; now: number }) {
  const list = Array.from({ length: 7 }, (_, i) => {
    const at = now - (6 - i) * DAY_MS;
    const key = dayOf(at);
    return {
      key,
      label: new Date(at).toLocaleDateString([], { weekday: 'narrow' }),
      total: days.find((x) => x.day === key)?.total ?? 0,
    };
  });
  const max = Math.max(...list.map((d) => d.total), 1);
  return (
    <svg className="stat-week" viewBox="0 0 70 22" role="img" aria-label="The last seven days">
      {list.map((d, i) => (
        <g key={d.key}>
          <title>{`${d.label}: ${totalWords(stat, d.total)}`}</title>
          <rect className="bar-track" x={i * 10 + 1} y={0} width={7} height={14} />
          <rect
            className={i === 6 ? 'bar today' : 'bar'}
            x={i * 10 + 1}
            y={14 - (d.total / max) * 14}
            width={7}
            height={(d.total / max) * 14}
          />
          <text x={i * 10 + 4.5} y={21} textAnchor="middle">
            {d.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
