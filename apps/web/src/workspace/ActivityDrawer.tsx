import {
  runCost,
  type LampResult,
  type Mode,
  type RunKind,
  type Segmentation,
} from '@livinglayer/domain';
import { usd } from '../cost';
import { useLab } from './LabContext';
import { LOG_PAGE, RESULT_GLYPH, RUN_KINDS, isProbe, runDetail } from './useLabState';

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The selected run: what it returned, what it cost, and how to repeat or reuse it. */
function RunInspector() {
  const lab = useLab();
  const selected = lab.selected;
  if (!selected) return <p className="placeholder">Pick a run to inspect it.</p>;
  return (
    <section
      className="inspector"
      key={selected.id}
      aria-label={`${selected.kind} run ${selected.id.slice(0, 8)}`}
    >
      <header className="inspector-head">
        <div>
          <span className="tiny">RUN INSPECTOR</span>
          <h3>
            <span className="inspector-kind">{selected.kind}</span>{' '}
            <code>{selected.id.slice(0, 8)}</code>
          </h3>
        </div>
        <span className={`result ${selected.status}`}>
          <span aria-hidden="true">{RESULT_GLYPH[selected.status]}</span>{' '}
          {selected.status.replace('_', ' ')}
        </span>
        <button
          className="inspector-close"
          aria-label="Close inspector"
          onClick={() => lab.setSelected(undefined)}
        >
          ×
        </button>
      </header>
      {runDetail(selected) && <p className="inspector-detail">{runDetail(selected)}</p>}
      {selected.kind === 'lamp' && <p>{(selected.output as LampResult).explanation}</p>}
      <dl className="inspector-facts">
        <div>
          <dt>MODE</dt>
          <dd>{selected.mode === 'fixture' ? 'demo' : 'live'}</dd>
        </div>
        <div>
          <dt>MODEL</dt>
          <dd>{selected.model ?? '—'}</dd>
        </div>
        <div>
          <dt>PROMPT</dt>
          <dd>{selected.promptVersion}</dd>
        </div>
        <div>
          <dt>DURATION</dt>
          <dd>{selected.durationMs} ms</dd>
        </div>
        <div>
          <dt>TOKENS IN / OUT</dt>
          <dd>
            {selected.usage
              ? `${selected.usage.inputTokens} / ${selected.usage.outputTokens}`
              : '—'}
          </dd>
        </div>
        <div>
          <dt>EST. COST</dt>
          <dd>{runCost(selected) === null ? '—' : `≈ ${usd(runCost(selected)!)}`}</dd>
        </div>
        <div>
          <dt>REQUEST ID</dt>
          <dd>{selected.requestId ?? '—'}</dd>
        </div>
        <div>
          <dt>CREATED</dt>
          <dd>{new Date(selected.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>ASSETS</dt>
          <dd>{selected.assets.length ? selected.assets.join(', ') : '—'}</dd>
        </div>
      </dl>
      <div className="inspector-actions">
        {isProbe(selected.kind) && (
          <button
            className="secondary"
            disabled={Boolean(lab.rerunBlock(selected))}
            title={lab.rerunBlock(selected) ?? undefined}
            onClick={() => lab.rerun(selected)}
          >
            Run again
            {selected.kind === 'segment' && ` · “${(selected.output as Segmentation).concept}”`}
          </button>
        )}
        {(selected.kind === 'segment' || selected.kind === 'discover') && (
          <button
            className="secondary"
            disabled={!lab.canRestore(selected)}
            title={
              lab.canRestore(selected)
                ? undefined
                : 'Only results made from the image on screen can go back on it.'
            }
            onClick={() => lab.restore(selected)}
          >
            Show on scene
          </button>
        )}
        <button className="text-button" onClick={() => lab.copyRun(selected)}>
          Copy JSON
        </button>
      </div>
      {isProbe(selected.kind) && lab.rerunBlock(selected) && (
        <p className="micro">{lab.rerunBlock(selected)}</p>
      )}
      <details>
        <summary>Raw evidence</summary>
        <pre>{JSON.stringify(selected, null, 2)}</pre>
      </details>
    </section>
  );
}

/**
 * Every model call and desk decision, newest first. Collapsed, it is one line
 * with the latest run; open, it is the filtered log beside the run inspector.
 */
export function ActivityDrawer() {
  const lab = useLab();
  const { runs, filteredRuns, logStats, logLimit, selected, drawer } = lab;
  const latest = runs[0];
  return (
    <section className={`ws-drawer ${drawer ? 'open' : ''}`} aria-label="Activity">
      <div className="drawer-bar">
        <button
          className="drawer-toggle"
          aria-expanded={drawer}
          aria-controls="drawer-body"
          onClick={() => lab.setDrawer(!drawer)}
        >
          <span className="tiny">ACTIVITY</span>
          {latest ? (
            <span className="drawer-latest">
              <span className={`result ${latest.status}`} aria-hidden="true">
                {RESULT_GLYPH[latest.status]}
              </span>
              <strong>{latest.kind}</strong>
              <span>{runDetail(latest)}</span>
              <small>
                {clock(latest.createdAt)} · {latest.durationMs} ms{lab.costNote(latest)}
              </small>
            </span>
          ) : (
            <span className="drawer-latest">No runs yet.</span>
          )}
          <span className="drawer-totals">
            Runs · {runs.length}
            {logStats.failed > 0 && <span className="failed"> · × {logStats.failed} failed</span>}
          </span>
          <span className="drawer-chevron" aria-hidden="true">
            {drawer ? '▾' : '▴'}
          </span>
        </button>
        <a className="export text-button" href="/api/evidence" download>
          Export evidence <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div className="drawer-body" id="drawer-body" hidden={!drawer}>
        <div className="drawer-runs">
          <div className="log-filters" role="group" aria-label="Filter the evidence log">
            <label>
              Kind
              <select
                value={lab.logKind}
                onChange={(e) => {
                  lab.setLogKind(e.target.value as RunKind | 'all');
                  lab.setLogLimit(LOG_PAGE);
                }}
              >
                <option value="all">All kinds</option>
                {RUN_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mode
              <select
                value={lab.logMode}
                onChange={(e) => {
                  lab.setLogMode(e.target.value as Mode | 'all');
                  lab.setLogLimit(LOG_PAGE);
                }}
              >
                <option value="all">Both modes</option>
                <option value="fixture">Demo</option>
                <option value="live">Live</option>
              </select>
            </label>
            <label className="overlay-toggle">
              <input
                type="checkbox"
                checked={lab.failuresOnly}
                onChange={(e) => {
                  lab.setFailuresOnly(e.target.checked);
                  lab.setLogLimit(LOG_PAGE);
                }}
              />{' '}
              Failures only
            </label>
            <p className="log-stats" aria-live="polite">
              {filteredRuns.length} run{filteredRuns.length === 1 ? '' : 's'}
              {logStats.medianMs !== null && ` · median ${logStats.medianMs} ms`}
              {logStats.cost > 0 && ` · ≈ ${usd(logStats.cost)}`}
            </p>
          </div>
          <div className="evidence-table">
            {filteredRuns.length ? (
              filteredRuns.slice(0, logLimit).map((run) => (
                <button
                  className={`run-row ${selected?.id === run.id ? 'selected' : ''}`}
                  key={run.id}
                  aria-pressed={selected?.id === run.id}
                  onClick={() => lab.inspect(run)}
                >
                  <span>
                    <strong>{run.kind}</strong>
                    <small>
                      {clock(run.createdAt)}{' '}
                      <b className={`badge ${run.mode}`}>
                        {run.mode === 'fixture' ? 'demo' : 'live'}
                      </b>
                    </small>
                    {runDetail(run) && <em className="run-detail">{runDetail(run)}</em>}
                  </span>
                  <span className={`result ${run.status}`}>
                    <span aria-hidden="true">{RESULT_GLYPH[run.status]}</span>{' '}
                    {run.status.replace('_', ' ')}
                  </span>
                  <span>
                    {run.durationMs} ms{lab.costNote(run)}
                  </span>
                </button>
              ))
            ) : (
              <div className="empty-evidence">
                {runs.length
                  ? 'No runs match these filters.'
                  : 'No runs yet. Every model call shows up here.'}
              </div>
            )}
            {filteredRuns.length > logLimit && (
              <button className="log-more" onClick={() => lab.setLogLimit((n) => n + LOG_PAGE * 2)}>
                Show more · {filteredRuns.length - logLimit} older
              </button>
            )}
          </div>
        </div>
        <div className="drawer-inspect">
          <RunInspector />
        </div>
      </div>
    </section>
  );
}
