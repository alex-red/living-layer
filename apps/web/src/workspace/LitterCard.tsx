import { useMemo } from 'react';
import {
  LITTER,
  clockOf,
  demoHistory,
  isLitterBox,
  litterBusy,
  litterNow,
  midnightOf,
  type Fixture,
  type LitterNow,
} from '@livinglayer/domain';
import { Button } from '../ui/controls';
import { useNow } from '../useNow';
import { useView } from './LabContext';
import { Details } from './panel';
import { addDemoEvents, useCoach } from './state/coach';
import { useReplay } from './state/replay';
import './litter-card.css';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "25 min", "3 h 10 min". */
function span(minutes: number): string {
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
}

/**
 * A litter box's card: the cat's visits today against a usual day by now,
 * the last visit and how long since, how full the waste drawer is, the cat's
 * weight from the box's scale, and today by the hour beside the week. The
 * demo reads its sample week as of the replay's minute (with what the
 * nudges' buttons did); live, the same once the box keeps Occupied and its
 * drawer is a thing with Last used.
 */
export function LitterCard({ fixture: f }: { fixture: Fixture }) {
  const { mode } = useView();
  const open = useReplay((r) => r.open);
  const minute = useReplay((r) => Math.floor(r.minute / 5) * 5);
  const extra = useCoach((c) => c.extra);
  const clock = useNow(60_000);
  const now = mode === 'demo' && open ? midnightOf(Date.now()) + minute * 60_000 : clock;
  const n = useMemo(() => {
    if (mode !== 'demo' || !isLitterBox(f.label)) return null;
    const history = { ...demoHistory(now), watched: null };
    history.events = [...history.events, ...extra.filter((e) => e.at <= now)].sort(
      (a, b) => a.at - b.at,
    );
    const box = history.things.find((t) => isLitterBox(t.label));
    return box ? litterNow(history, box, now) : null;
  }, [mode, f.label, now, extra]);
  if (!isLitterBox(f.label)) return null;
  if (!n)
    return (
      <Details summary="Litter box">
        <p className="micro">
          Keep <b>Occupied</b> on it and the cat’s visits are counted; make its waste drawer a thing
          with <b>Last used</b>, and pulling it out counts as emptying it. The room coach then says
          when the drawer fills up or the visits aren’t usual.
        </p>
      </Details>
    );
  return <LitterStats n={n} now={now} />;
}

function LitterStats({ n, now }: { n: LitterNow; now: number }) {
  const busy = litterBusy(n);
  const count = n.visits.length;
  const drawer = n.drawer;
  const full = drawer?.share != null && drawer.share >= LITTER.drawerFull;
  const weight = n.weight;
  const change = weight && weight.weekAgo !== null ? weight.kg - weight.weekAgo : null;
  const peak = Math.max(1, ...n.week.map((d) => d.visits), n.usualDay ?? 0);
  const hourPeak = Math.max(1, ...n.hours);
  const quiet = n.sinceLast !== null && n.sinceLast >= LITTER.quietMin;
  return (
    <Details summary={`Litter box · ${n.cat}`} open>
      <p className={`litter-status ${busy || quiet ? 'watch' : 'fine'}`} role="status">
        {quiet
          ? `No visit for ${span(n.sinceLast!)}: worth checking on ${n.cat}.`
          : busy
            ? `${count} visits so far, about ${Math.round((count / Math.max(n.usualByNow!, 0.5)) * 10) / 10}× a usual day by now. Worth keeping an eye on.`
            : count
              ? `${count} visit${count === 1 ? '' : 's'} so far: a usual day.`
              : `No visits yet today.`}
      </p>
      <div className="litter-tiles">
        <div className={`litter-tile ${busy ? 'watch' : ''}`}>
          <span className="litter-name">Visits today</span>
          <span className="litter-value">{count}</span>
          <span className="litter-sub">
            {n.usualByNow === null ? 'usual: a few days to learn' : `usual ${n.usualByNow} by now`}
          </span>
        </div>
        <div className={`litter-tile ${quiet ? 'watch' : ''}`}>
          <span className="litter-name">Last visit</span>
          <span className="litter-value">{n.lastVisit ? clockOf(n.lastVisit.at) : '–'}</span>
          <span className="litter-sub">
            {!n.lastVisit
              ? 'none yet'
              : n.lastVisit.minutes === null
                ? `${n.cat} is in it now`
                : `${span(n.lastVisit.minutes)} inside, ${span(n.sinceLast!)} ago`}
          </span>
        </div>
        <div className={`litter-tile ${full ? 'watch' : ''}`}>
          <span className="litter-name">Waste drawer</span>
          <span className="litter-value">
            {drawer?.share != null ? `${Math.round(drawer.share * 100)}%` : '–'}
          </span>
          {drawer?.share != null && (
            <span className="litter-fill" aria-hidden="true">
              <span style={{ width: `${Math.round(drawer.share * 100)}%` }} />
            </span>
          )}
          <span className="litter-sub">
            {!drawer
              ? 'no drawer thing'
              : drawer.emptiedAt === null
                ? 'not emptied yet'
                : `${drawer.visits} visits since ${DAYS[new Date(drawer.emptiedAt).getDay()]} ${clockOf(drawer.emptiedAt)}`}
          </span>
        </div>
        <div className="litter-tile">
          <span className="litter-name">Weight</span>
          <span className="litter-value">{weight ? `${weight.kg.toFixed(1)} kg` : '–'}</span>
          <span className="litter-sub">
            {change === null
              ? 'from the scale'
              : Math.abs(change) < 0.1
                ? 'steady this week'
                : `${change > 0 ? '+' : '−'}${Math.abs(change).toFixed(1)} kg this week`}
          </span>
        </div>
      </div>
      <div className="litter-charts">
        <figure>
          <figcaption className="litter-name">Today by the hour</figcaption>
          <div className="litter-hours" role="img" aria-label={`${count} visits today by the hour`}>
            {n.hours.map((v, h) => (
              <span
                key={h}
                className={h === new Date(now).getHours() ? 'now' : ''}
                style={{ height: `${(v / hourPeak) * 100}%` }}
                title={`${h}:00 · ${v} visit${v === 1 ? '' : 's'}`}
              />
            ))}
          </div>
        </figure>
        <figure>
          <figcaption className="litter-name">This week</figcaption>
          <div
            className="litter-week"
            role="img"
            aria-label={n.week
              .map((d) => `${DAYS[new Date(d.day).getDay()]} ${d.visits}`)
              .join(', ')}
          >
            {n.usualDay !== null && (
              <span
                className="usual"
                style={{ bottom: `${(n.usualDay / peak) * 100}%` }}
                title={`Usual: ${n.usualDay} a day`}
              />
            )}
            {n.week.map((d, i) => (
              <span key={d.day} className="day">
                <span
                  className={`bar ${i === 6 ? 'today' : ''}`}
                  style={{ height: `${(d.visits / peak) * 100}%` }}
                  title={`${DAYS[new Date(d.day).getDay()]} · ${d.visits} visits`}
                />
                <span className="label">
                  {i === 6 ? 'Today' : DAYS[new Date(d.day).getDay()]![0]}
                </span>
              </span>
            ))}
          </div>
        </figure>
      </div>
      {n.meanMinutes !== null && (
        <p className="micro">
          Visits today last {n.meanMinutes} min on average; the robot cleans itself{' '}
          {LITTER.cycleWaitMin} min after {n.cat} comes out.
        </p>
      )}
      {drawer && (
        <div className="save-actions">
          <Button
            size="sm"
            disabled={drawer.share === 0}
            onClick={() =>
              addDemoEvents([
                {
                  thingId: drawer.id,
                  key: 'lastUsed',
                  at: now,
                  value: now,
                  source: 'person',
                  confidence: 1,
                },
              ])
            }
          >
            Emptied the drawer
          </Button>
        </div>
      )}
    </Details>
  );
}
