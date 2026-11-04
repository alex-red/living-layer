import { useState, type ReactNode } from 'react';
import type { TrackHealth } from '@livinglayer/domain';
import { TRACK_HEALTH } from '@livinglayer/domain';

const VERDICT = {
  waiting: 'waiting',
  healthy: 'healthy',
  strained: 'busy',
  lagging: 'behind',
  stalled: 'stalled',
} as const;
const ms = (n: number) => (n < 1 ? '<1' : n < 10 ? n.toFixed(1) : String(Math.round(n)));
const pct = (share: number) => `${Math.round(share * 100)}%`;

/** Each recent frame's work as a bar of the frame interval, with the strained line across. */
function WorkSpark({ recent, budgetMs }: { recent: number[]; budgetMs: number }) {
  const w = TRACK_HEALTH.recentFrames * 4;
  const h = 24;
  const line = h - h * TRACK_HEALTH.strainedWork;
  return (
    <svg className="health-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <line x1={0} x2={w} y1={line} y2={line} />
      {recent.map((work, i) => {
        const bar = Math.max(1, Math.min(1, work / budgetMs) * h);
        const x = w - (recent.length - i) * 4;
        const tone =
          work > budgetMs ? 'over' : work > budgetMs * TRACK_HEALTH.strainedWork ? 'high' : '';
        return <rect key={i} className={tone} x={x} y={h - bar} width={3} height={bar} />;
      })}
    </svg>
  );
}

/**
 * How one tracker keeps up, under the camera: closed, its name and a one-word
 * verdict, so it reads calmly on screen. Opened, the reason, its rate, work
 * per frame and load, every number behind the verdict and the latest frames'
 * work against the frame interval. Only a stall says why without opening.
 * `control` (a switch for what does the tracking) and `more` rows open with it.
 */
export function HealthBar({
  who,
  health: h,
  control,
  more = [],
}: {
  who: string;
  health: TrackHealth;
  control?: ReactNode;
  more?: [string, string][];
}) {
  const [open, setOpen] = useState(false);
  const load = h.cpu !== null ? `CPU ${h.cpu}%` : h.busy !== null ? `busy ${pct(h.busy)}` : null;
  const numbers = [
    h.fps !== null && `${h.fps.toFixed(1)} fps`,
    h.workP95 !== null && `${ms(h.workP95)} ms`,
    load,
  ].filter(Boolean);
  const rows: [string, string][] = [
    [
      'Frame work',
      h.workP50 === null ? '—' : `${ms(h.workP50)} ms, p95 ${ms(h.workP95!)} of ${ms(h.budgetMs)}`,
    ],
    ['Rate', h.fps === null ? 'one frame a move' : `${h.fps.toFixed(1)} of ${h.wantFps} fps`],
    ['Last frame', h.staleMs === null ? '—' : `${(h.staleMs / 1000).toFixed(1)} s ago`],
    ...(h.queued ? [['Queued', pct(h.queued)] as [string, string]] : []),
    ...(h.busy !== null ? [['On frames', pct(h.busy)] as [string, string]] : []),
    ...(h.cpu !== null ? [['Server CPU', `${h.cpu}%`] as [string, string]] : []),
    ...(h.ffmpegCpu !== null ? [['ffmpeg CPU', `${h.ffmpegCpu}%`] as [string, string]] : []),
    ...(h.visionCpu != null ? [['Apple Vision CPU', `${h.visionCpu}%`] as [string, string]] : []),
    ...(h.driftMs !== null ? [['Timers late', `${h.driftMs} ms`] as [string, string]] : []),
    [
      'Things',
      `${h.things}${h.lost ? `, ${h.lost} lost` : ''}${h.looking ? `, ${h.looking} looked for` : ''}`,
    ],
    ...more,
  ];
  return (
    <div className={`health-bar ${h.verdict}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${who} tracking ${h.verdict}: ${h.reason}`}
        onClick={() => setOpen((o) => !o)}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="health-dot" aria-hidden="true" />
        <span className="health-who">{who}</span>
        <span className="health-verdict">{VERDICT[h.verdict]}</span>
      </button>
      {h.verdict === 'stalled' && <p className="health-reason">{h.reason}</p>}
      {open && (
        <div className="health-detail">
          {control}
          {numbers.length > 0 && <p className="health-numbers">{numbers.join(' · ')}</p>}
          {h.verdict !== 'healthy' && h.verdict !== 'stalled' && (
            <p className="health-why">{h.reason}</p>
          )}
          <WorkSpark recent={h.recent} budgetMs={h.budgetMs} />
          <dl>
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
