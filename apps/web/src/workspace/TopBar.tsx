import { Glyph } from '../Glyph';
import { estimateLabel, usd } from '../cost';
import { SHORTCUTS } from '../shortcuts';
import { useLab } from './LabContext';
import { Popover } from './Popover';
import { BUSY } from './useLabState';
import { roomLabel as labelOfRoom, selectionLabel } from './labels';
import { viewLabel } from './progress';

/** Models, Meta access, spend, the lamp, and the live proof checklist. */
function Readiness() {
  const lab = useLab();
  const { status, mode, busy, metaReady, lampReady, spendTone, spendShare, proofCount } = lab;
  return (
    <div className="readiness-pop">
      <dl className="session-strip" aria-label="Session">
        <div>
          <dt>SPARK</dt>
          <dd>{status?.meta.sparkModel ?? '…'}</dd>
        </div>
        <div>
          <dt>SAM</dt>
          <dd>{status?.meta.samModel ?? '…'}</dd>
        </div>
        <div>
          <dt>META</dt>
          <dd className={metaReady ? 'ok' : 'unsure'}>
            {metaReady ? '● ready' : '◌ off'}
            {status && <small>{status.meta.usedToday} calls today</small>}
          </dd>
        </div>
        <div>
          <dt>SPENT TODAY</dt>
          <dd className={spendTone}>
            {status ? `≈ ${usd(status.meta.spentToday)}` : '…'}
            {status && <small>of {usd(status.meta.spendLimit)} limit</small>}
          </dd>
          {status && (
            <span className={`budget ${spendTone}`} aria-hidden="true">
              <span style={{ width: `${spendShare * 100}%` }} />
            </span>
          )}
        </div>
        <div>
          <dt>LAMP</dt>
          <dd className={lampReady ? 'ok' : 'unsure'}>{lampReady ? '● ready' : '◌ off'}</dd>
        </div>
        <div>
          <dt>LIVE PROOF</dt>
          <dd>{proofCount} / 4</dd>
        </div>
      </dl>
      <aside className="readiness">
        <span className="tiny">LIVE PROOF CHECKLIST</span>
        <h3>
          {proofCount}
          <span> / 4</span>
        </h3>
        <p>Demo runs never count toward live proof.</p>
        {(['text', 'discover', 'segment', 'lamp'] as const).map((kind) => (
          <div className="proof-row" key={kind}>
            <span className={`ring ${status?.liveEvidence[kind] ? 'done' : ''}`}>
              {status?.liveEvidence[kind] ? '✓' : ''}
            </span>
            {
              {
                text: 'Spark connection',
                discover: 'Real desk discovery',
                segment: 'Real mug mask',
                lamp: 'HA state observed',
              }[kind]
            }
            <small>{status?.liveEvidence[kind] ? 'Saved' : 'Pending'}</small>
          </div>
        ))}
      </aside>
      <section className="readiness-tests" aria-label="Connection tests">
        <span className="tiny">TEST THE CONNECTIONS</span>
        <p className="micro">
          {mode === 'demo'
            ? 'Demo: the lamp is virtual and no model is called.'
            : 'Turns on your configured lamp. Check the physical effect separately.'}
        </p>
        <div className="save-actions">
          <button
            className="physical"
            disabled={Boolean(busy) || (mode === 'live' && !lampReady)}
            onClick={() => void lab.execute('lamp')}
          >
            {busy === 'lamp'
              ? 'Checking state…'
              : mode === 'demo'
                ? 'Simulate lamp action'
                : 'Turn on desk lamp'}
          </button>
          <button
            className="secondary"
            disabled={Boolean(busy) || (mode === 'live' && !metaReady)}
            onClick={() => void lab.execute('text')}
          >
            {busy === 'text' ? 'Checking…' : 'Run text smoke test'}
          </button>
        </div>
        {mode === 'live' && status && (
          <p className="micro">{estimateLabel(status.meta.estimates.text)}</p>
        )}
      </section>
      <div className="setup-note">
        <strong>{metaReady ? 'Meta calls enabled' : 'Meta access pending'}</strong>
        <p>{status?.meta.note ?? 'Checking local configuration…'}</p>
        <strong>{lampReady ? 'Lamp adapter enabled' : 'Lamp setup pending'}</strong>
        <p>{status?.lamp.note}</p>
      </div>
      {status && (
        <form
          className="spend-limit"
          onSubmit={(e) => {
            e.preventDefault();
            const value = Number(lab.limitDraft);
            if (value > 0 && value <= 1000) void lab.saveSpendLimit(value);
            else lab.setError('Set a daily limit between $0.01 and $1,000.');
          }}
        >
          <label htmlFor="spend-limit">
            <strong>Daily Meta spending limit</strong>
            <span>
              A call that could take today’s spend past this is refused before it is sent. Resets at
              midnight UTC.
            </span>
          </label>
          <div className="spend-limit-row">
            <span className="currency">$</span>
            <input
              id="spend-limit"
              type="number"
              inputMode="decimal"
              min="0.01"
              max="1000"
              step="0.01"
              value={lab.limitDraft}
              onChange={(e) => lab.setLimitDraft(e.target.value)}
            />
            <button
              className="secondary"
              type="submit"
              disabled={Number(lab.limitDraft) === status.meta.spendLimit}
            >
              Save
            </button>
            {status.meta.spendLimit !== status.meta.defaultSpendLimit && (
              <button
                className="text-button"
                type="button"
                onClick={() => void lab.saveSpendLimit(null)}
              >
                Use .env ({usd(status.meta.defaultSpendLimit)})
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

/** Saves, history, shortcuts and starting over. */
function MoreMenu({ close }: { close: () => void }) {
  const lab = useLab();
  const { undo, redo, mode, busy } = lab;
  return (
    <section className="saves" aria-label="Saves">
      <span className="tiny">SAVED IN THIS BROWSER</span>
      <p className={lab.storageOk ? '' : 'unsure'}>
        {!lab.storageOk
          ? 'This browser won’t store the session (private window or storage blocked). Export a save to keep your work.'
          : lab.savedAt
            ? `Saved as you go · last ${new Date(lab.savedAt).toLocaleTimeString()}`
            : 'Saved as you go, once the desks have loaded.'}
      </p>
      <p className="micro">
        Your scene, view, camera source, filters and both desks: pins, rules, scenes and models.
        Photos and the evidence log stay out of saves.
      </p>
      <div className="save-actions">
        <button
          className="secondary"
          onClick={() =>
            lab.setMessage(
              lab.saveNow() ? 'Saved to this browser.' : 'This browser would not store the save.',
            )
          }
        >
          Save now
        </button>
        <button className="secondary" onClick={lab.exportSave}>
          Export save
        </button>
        <button
          className="secondary"
          disabled={Boolean(busy)}
          onClick={() => lab.importFile.current?.click()}
        >
          Import save
        </button>
      </div>
      <span className="tiny">HISTORY</span>
      <p className="micro">
        {undo.current[mode].length} step{undo.current[mode].length === 1 ? '' : 's'} to undo ·{' '}
        {redo.current[mode].length} to redo in {mode === 'demo' ? 'demo' : 'live'} mode. Undo puts
        the whole desk back as it was before your last edit.
      </p>
      <span className="tiny">MORE</span>
      <div className="menu-links">
        <button
          className="text-button"
          onClick={() => {
            close();
            lab.setShowKeys(true);
          }}
        >
          Keyboard shortcuts
        </button>
        <a className="text-button" href="/playground">
          Camera playground ↗
        </a>
      </div>
      <span className="tiny">START OVER</span>
      <button
        className="danger"
        disabled={Boolean(busy)}
        onClick={() => {
          close();
          void lab.resetToDemo();
        }}
      >
        Reset everything to demo
      </button>
    </section>
  );
}

export function KeysDialog() {
  const { setShowKeys } = useLab();
  return (
    <div className="keys-backdrop" onClick={() => setShowKeys(false)}>
      <div
        className="keys-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="keys-head">
          <h3>Keyboard shortcuts</h3>
          <button className="icon-button" aria-label="Close" onClick={() => setShowKeys(false)}>
            ×
          </button>
        </div>
        <dl>
          {SHORTCUTS.map((k) => (
            <div key={k.action}>
              <dt>
                {k.keys.split(' ').map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </dt>
              <dd>{k.label}</dd>
            </div>
          ))}
        </dl>
        <p className="micro">Shortcuts wait while you type in a field.</p>
      </div>
    </div>
  );
}

/**
 * Where you are (a breadcrumb of the selection), what is happening (the status
 * capsule), and the session: data source, undo, spend and the menu.
 */
export function TopBar() {
  const lab = useLab();
  const { mode, busy, camera, cameraPending, status, undo, redo, progress } = lab;
  const roomLabel = labelOfRoom(progress.room, lab.memory);
  const crumbs: { label: string; onClick?: () => void }[] = [];
  if (roomLabel) crumbs.push({ label: roomLabel, onClick: () => lab.select({ kind: 'room' }) });
  const inView =
    lab.workScene === progress.view ||
    ['view', 'object', 'suggested', 'add'].includes(lab.selection?.kind ?? '');
  if (progress.view && inView)
    crumbs.push({
      label: viewLabel(progress.view),
      onClick: () => lab.select({ kind: 'view' }),
    });
  const leaf = lab.selection && selectionLabel(lab, lab.selection);
  if (leaf && !['room', 'view'].includes(lab.selection!.kind)) crumbs.push({ label: leaf });
  return (
    <header className="topbar">
      <div className="topbar-id">
        <a className="brand" href="/" aria-label="Living Layer home">
          <span className="brand-icon">
            <Glyph />
          </span>
          <span className="brand-name">Living Layer</span>
        </a>
        <h1 className="page-title">
          Desk lab{mode === 'live' && <span className="live-tag">LIVE</span>}
        </h1>
        {crumbs.length > 0 && (
          <nav className="crumbs" aria-label="You are here">
            {crumbs.map((c, i) => (
              <span key={i}>
                {c.onClick && i < crumbs.length - 1 ? (
                  <button onClick={c.onClick}>{c.label}</button>
                ) : (
                  <span aria-current={i === crumbs.length - 1 ? 'location' : undefined}>
                    {c.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
        )}
      </div>
      {progress.room && (
        <button
          className="outline-toggle"
          aria-label="Scene outline"
          aria-expanded={lab.outlineOpen}
          onClick={() => lab.setOutlineOpen(!lab.outlineOpen)}
        >
          <span aria-hidden="true">☰</span> {crumbs.at(-1)?.label}
        </button>
      )}
      <div className={`feedback ${lab.capsuleTone}`} role="status" aria-live="polite">
        {camera && <span className="privacy-dot" aria-label="Camera on" />}
        <span className="dot" />
        <span className="feedback-text">
          {busy ? `${BUSY[busy] ?? 'Working'}…` : lab.error || lab.message}
        </span>
        {lab.lamp === 'virtual' && <span className="hud-tag">VIRTUAL</span>}
      </div>
      <nav className="topbar-links">
        <div className="mode-switch" aria-label="Data source">
          {(['demo', 'live'] as const).map((value) => (
            <button
              key={value}
              disabled={Boolean(busy) || camera || cameraPending}
              aria-pressed={mode === value}
              title={
                value === 'demo'
                  ? 'The illustrated demo: no model calls, a virtual lamp'
                  : 'Your photos and camera, real model calls and your lamp'
              }
              onClick={() => lab.changeMode(value)}
            >
              {value === 'demo' ? 'Demo' : 'Live'}
            </button>
          ))}
        </div>
        <span className="history" role="group" aria-label="Undo and redo">
          <button
            className="icon-button"
            aria-label="Undo"
            title={`Undo (${SHORTCUTS[0]!.keys})`}
            disabled={!undo.current[mode].length || Boolean(busy) || camera}
            onClick={() => void lab.stepHistory(true)}
          >
            ↶
          </button>
          <button
            className="icon-button"
            aria-label="Redo"
            title={`Redo (${SHORTCUTS[1]!.keys})`}
            disabled={!redo.current[mode].length || Boolean(busy) || camera}
            onClick={() => void lab.stepHistory(false)}
          >
            ↷
          </button>
        </span>
        <Popover
          label="Readiness"
          className="wide"
          button={(open, toggle) => (
            <button
              className={`budget-pill ${lab.metaReady ? 'ok' : 'unsure'}`}
              aria-expanded={open}
              aria-label="Readiness and spending"
              title="Models, spending, the lamp and live proof"
              onClick={toggle}
            >
              <span className="dot" aria-hidden="true" />
              <span className="budget-text">
                {status ? `${usd(status.meta.spentToday)} / ${usd(status.meta.spendLimit)}` : '…'}
              </span>
              <small>{lab.proofCount}/4</small>
            </button>
          )}
        >
          {() => <Readiness />}
        </Popover>
        <Popover
          label="Menu"
          button={(open, toggle) => (
            <button
              className="icon-button"
              aria-label="More"
              aria-expanded={open}
              title="Saves, shortcuts and starting over"
              onClick={toggle}
            >
              ⋯
            </button>
          )}
        >
          {(close) => <MoreMenu close={close} />}
        </Popover>
        <input
          ref={lab.importFile}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="Save file to import"
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            if (chosen) void lab.importSave(chosen);
          }}
        />
      </nav>
    </header>
  );
}
