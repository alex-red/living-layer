import { useEffect, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Glyph } from '../Glyph';
import { Button, Check, IconButton, Segmented } from '../ui/controls';
import { estimateLabel, usd } from '../cost';
import { SHORTCUTS } from '../shortcuts';
import {
  useCamera,
  useDesk,
  useFeedback,
  useLabParts,
  useNavigation,
  useObservation,
  useProbes,
  useSaves,
  useView,
} from './LabContext';
import { SAVE_NAME_MAX, type NamedSave } from '../session';
import { Popover } from './Popover';
import { BUSY } from './useLabState';
import { aiTaskStore, setAiTask, useAiTaskPart } from './state/ai-task-store';
import { roomLabel as labelOfRoom, selectionLabel } from './labels';
import { viewLabel } from './progress';
import { startRecording } from '../Recorder';
// The top bar refines the workspace's styles, as it did when both were one sheet.
import './workspace.css';
import './top-bar.css';
import './session.css';
import './checklist.css';

/** Models, Meta access, spend, the lamp, and the live proof checklist. */
function Readiness() {
  const lab = useLabParts(useView(), useFeedback(), useDesk(), useProbes());
  const { status, mode, busy, metaReady, lampReady, spendTone, spendShare, proofCount } = lab;
  return (
    <div className="readiness-pop">
      <dl className="session-strip" aria-label="Session">
        <div>
          <dt>Spark</dt>
          <dd>{status?.meta.sparkModel ?? '…'}</dd>
        </div>
        <div>
          <dt>SAM</dt>
          <dd>{status?.meta.samModel ?? '…'}</dd>
        </div>
        <div>
          <dt>Meta</dt>
          <dd className={metaReady ? 'ok' : 'unsure'}>
            {metaReady ? '● ready' : '◌ off'}
            {status && <small>{status.meta.usedToday} calls today</small>}
          </dd>
        </div>
        <div>
          <dt>Spent today</dt>
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
          <dt>Lamp</dt>
          <dd className={lampReady ? 'ok' : 'unsure'}>{lampReady ? '● ready' : '◌ off'}</dd>
        </div>
        <div>
          <dt>Live proof</dt>
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
                lamp: 'Lamp state read back',
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
          <Button
            variant="physical"
            disabled={Boolean(busy) || (mode === 'live' && !lampReady)}
            onClick={() => void lab.execute('lamp')}
          >
            {busy === 'lamp'
              ? 'Checking state…'
              : mode === 'demo'
                ? 'Simulate lamp action'
                : 'Turn on desk lamp'}
          </Button>
          <Button
            disabled={Boolean(busy) || (mode === 'live' && !metaReady)}
            onClick={() => void lab.execute('text')}
          >
            {busy === 'text' ? 'Checking…' : 'Test Spark'}
          </Button>
        </div>
        {mode === 'live' && status && (
          <p className="micro">{estimateLabel(status.meta.estimates.text)}</p>
        )}
      </section>
      <div className="setup-note">
        <strong>{metaReady ? 'Meta calls enabled' : 'Meta access pending'}</strong>
        <p>{status?.meta.note ?? 'Checking local configuration…'}</p>
        <strong>
          {lampReady ? 'Home Assistant switching on' : 'Home Assistant switching off'}
        </strong>
        <p>{status?.lamp.note}</p>
        <strong>
          {status?.mqtt.state === 'connected'
            ? 'Home Assistant entities published'
            : status?.mqtt.enabled && status.mqtt.configured
              ? `MQTT ${status.mqtt.state}`
              : 'MQTT setup pending'}
        </strong>
        <p>{status?.mqtt.note}</p>
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
            <Button type="submit" disabled={Number(lab.limitDraft) === status.meta.spendLimit}>
              Save
            </Button>
            {status.meta.spendLimit !== status.meta.defaultSpendLimit && (
              <Button variant="text" type="button" onClick={() => void lab.saveSpendLimit(null)}>
                Use the default ({usd(status.meta.defaultSpendLimit)})
              </Button>
            )}
          </div>
        </form>
      )}
      {status && (
        <div className="tracking-ai">
          <Check checked={lab.trackingAi} onChange={(on) => void lab.saveTrackingAi(on)}>
            <strong>Let tracking call AI (SAM, Spark)</strong>
          </Check>
          <p>
            Off, outlines, following, finding lost things and zone decisions all run on this
            machine. On, SAM outlines matches by name and finds lost things again, and Spark
            suggests objects: billed.
          </p>
        </div>
      )}
    </div>
  );
}

/** Where a save is kept: on the server for every browser, or so far only in this one. */
function SaveWhere({ shared }: { shared: boolean }) {
  return shared ? (
    <span
      className="save-where shared"
      title="Kept on the server for every browser and device, with a copy in this browser."
    >
      Server
    </span>
  ) : (
    <span
      className="save-where local"
      title="Only in this browser so far. It goes to the server the next time the server can be reached."
    >
      This browser
    </span>
  );
}
/** One named save: load it, keep the desks in it, rename, export or delete it. */
function SaveRow({ entry }: { entry: NamedSave }) {
  const lab = useLabParts(useFeedback(), useSaves());
  const active = lab.activeSave?.id === entry.id;
  const [state, setState] = useState<'idle' | 'renaming' | 'deleting' | 'loading'>('idle');
  const [draft, setDraft] = useState(entry.name);
  const when = new Date(entry.save.savedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (
    <li className={active ? 'active' : undefined} aria-label={entry.name}>
      {state === 'renaming' ? (
        <form
          className="save-name"
          onSubmit={(e) => {
            e.preventDefault();
            if (lab.renameSave(entry.id, draft)) setState('idle');
          }}
        >
          <input
            aria-label="New name"
            value={draft}
            maxLength={SAVE_NAME_MAX}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setState('idle');
              }
            }}
          />
          <Button size="sm" type="submit" disabled={!draft.trim()}>
            Rename
          </Button>
          <Button size="sm" variant="text" type="button" onClick={() => setState('idle')}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="save-title">
          <strong>{entry.name}</strong>
          {active && <span className="micro">{lab.unsaved ? 'in use · edited' : 'in use'}</span>}
        </div>
      )}
      <span className="micro save-meta">
        {when}
        <SaveWhere shared={Boolean(entry.onServer)} />
      </span>
      {state === 'deleting' ? (
        <div className="save-actions">
          <span className="micro unsure">Delete this save? Export it first to keep a copy.</span>
          <Button variant="danger" size="sm" onClick={() => lab.deleteSave(entry.id)}>
            Delete
          </Button>
          <Button variant="text" size="sm" onClick={() => setState('idle')}>
            Keep it
          </Button>
        </div>
      ) : state === 'loading' ? (
        <div className="save-actions">
          <span className="micro unsure">
            {lab.activeSave
              ? `Edits since “${lab.activeSave.name}” was saved will be lost.`
              : 'What’s on the desks now isn’t in a named save and will be replaced.'}
          </span>
          <Button
            variant="danger"
            size="sm"
            disabled={Boolean(lab.busy)}
            onClick={() => {
              setState('idle');
              void lab.loadSave(entry.id);
            }}
          >
            Load anyway
          </Button>
          <Button variant="text" size="sm" onClick={() => setState('idle')}>
            Cancel
          </Button>
        </div>
      ) : (
        state === 'idle' && (
          <div className="save-actions">
            <Button
              variant="text"
              size="sm"
              disabled={Boolean(lab.busy)}
              onClick={() => (lab.unsaved ? setState('loading') : void lab.loadSave(entry.id))}
            >
              Load
            </Button>
            {active && (
              <Button
                variant="text"
                size="sm"
                disabled={!lab.unsaved}
                onClick={() => {
                  if (lab.updateSave(entry.id)) lab.setMessage(`Saved “${entry.name}”.`);
                }}
              >
                Save changes
              </Button>
            )}
            <Button
              variant="text"
              size="sm"
              onClick={() => {
                setDraft(entry.name);
                setState('renaming');
              }}
            >
              Rename
            </Button>
            <Button variant="text" size="sm" onClick={() => lab.exportSave(entry.id)}>
              Export
            </Button>
            <Button variant="danger" size="sm" onClick={() => setState('deleting')}>
              Delete
            </Button>
          </div>
        )
      )}
    </li>
  );
}

/** Saves, history, shortcuts and starting over. */
function MoreMenu({ close }: { close: () => void }) {
  const lab = useLabParts(useView(), useFeedback(), useDesk(), useSaves());
  const { undo, redo, mode, busy } = lab;
  const [resetting, setResetting] = useState(false);
  const [name, setName] = useState('');
  return (
    <section className="saves" aria-label="Saves">
      <span className="tiny">NAMED SAVES</span>
      <p className={`micro${lab.savesServer === 'away' ? ' unsure' : ''}`}>
        {lab.savesServer === 'away'
          ? 'The server can’t be reached, so saves are kept in this browser for now. They go to the server when it’s back.'
          : lab.savesServer === 'shared'
            ? 'Kept on the server, so every browser and device on it sees them, with a copy in this browser.'
            : 'Checking the server for saves…'}
      </p>
      <form
        className="save-name"
        onSubmit={(e) => {
          e.preventDefault();
          if (lab.saveAs(name)) setName('');
        }}
      >
        <input
          aria-label="Save name"
          placeholder="Name this save"
          value={name}
          maxLength={SAVE_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
        />
        <Button size="sm" type="submit" disabled={!name.trim()}>
          Save as
        </Button>
      </form>
      {lab.saves.length > 0 ? (
        <ul className="save-list" aria-label="Named saves">
          {lab.saves.map((entry) => (
            <SaveRow key={entry.id} entry={entry} />
          ))}
        </ul>
      ) : (
        <p className="micro">
          Name a save to keep this room as it is now and come back to it later.
        </p>
      )}
      <span className="tiny">AUTOSAVE · THIS BROWSER</span>
      <p className={lab.storageOk ? '' : 'unsure'}>
        {!lab.storageOk
          ? 'This browser won’t store the session (private window or storage blocked). Export a save to keep your work.'
          : lab.savedAt
            ? `Saved as you go · last ${new Date(lab.savedAt).toLocaleTimeString()}`
            : 'Saved as you go, once the desks have loaded.'}
      </p>
      <p className="micro">
        Your scene, view, camera source and filters stay in this browser. Both desks (pins, rules,
        scenes and models) are on the server too. Photos and the evidence log stay out of saves.
      </p>
      <div className="save-actions">
        <Button size="sm" onClick={lab.saveEverything}>
          Save now
        </Button>
        <Button size="sm" onClick={() => lab.exportSave()}>
          Export save
        </Button>
        <Button size="sm" disabled={Boolean(busy)} onClick={() => lab.importFile.current?.click()}>
          Import save
        </Button>
      </div>
      <span className="tiny">HISTORY</span>
      <p className="micro">
        {undo.current[mode].length} step{undo.current[mode].length === 1 ? '' : 's'} to undo ·{' '}
        {redo.current[mode].length} to redo in {mode === 'demo' ? 'demo' : 'live'} mode. Undo puts
        the whole desk back as it was before your last edit.
      </p>
      <span className="tiny">MORE</span>
      <div className="menu-links">
        <Button
          variant="text"
          onClick={() => {
            close();
            lab.setShowKeys(true);
          }}
        >
          Keyboard shortcuts
        </Button>
        <Button
          variant="text"
          title="A video of this tab, downloaded when you stop"
          onClick={() => {
            close();
            void startRecording();
          }}
        >
          Record this tab
        </Button>
        <a className="text-button" href="/studio">
          Fixture Studio ↗
        </a>
        <a className="text-button" href="/playground">
          Camera playground ↗
        </a>
      </div>
      <span className="tiny">START OVER</span>
      {resetting ? (
        <>
          <p className="micro unsure">
            Both desks, your scene, pins, rules and models are cleared, and this browser’s save is
            replaced. Named saves and the evidence log are kept.
          </p>
          <div className="save-actions">
            <Button
              variant="danger"
              disabled={Boolean(busy)}
              onClick={() => {
                close();
                void lab.resetToDemo();
              }}
            >
              Yes, reset everything
            </Button>
            <Button onClick={() => setResetting(false)}>Keep my work</Button>
          </div>
        </>
      ) : (
        <Button variant="danger" disabled={Boolean(busy)} onClick={() => setResetting(true)}>
          Reset everything to demo
        </Button>
      )}
    </section>
  );
}

export function KeysDialog() {
  const { setShowKeys } = useView();
  return (
    <Dialog title="Keyboard shortcuts" className="keys-dialog" onClose={() => setShowKeys(false)}>
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
    </Dialog>
  );
}

/**
 * Where you are (a breadcrumb of the selection), what is happening (the status
 * capsule), and the session: data source, undo, spend and the menu.
 */
/** `place` stands for the crumbs on a page of its own (the studio), which has no outline either. */
/** How long a settled message stays in the capsule before it folds to its dot. */
const MESSAGE_SHOWN_MS = 6000;
/**
 * Whether the capsule's text has had its moment: a message folds away after a
 * few seconds, so the top bar is calm; work in progress and errors stay.
 */
function useQuietMessage(text: string, held: boolean) {
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    setQuiet(false);
    if (held || !text) return;
    const t = setTimeout(() => setQuiet(true), MESSAGE_SHOWN_MS);
    return () => clearTimeout(t);
  }, [text, held]);
  return quiet;
}

export function TopBar({ place }: { place?: string[] } = {}) {
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useDesk(),
    useCamera(),
    useObservation(),
    useNavigation(),
    useSaves(),
  );
  const { mode, busy, camera, cameraPending, status, undo, redo, progress } = lab;
  const feedback = busy ? `${BUSY[busy] ?? 'Working'}…` : lab.error || lab.message;
  const quiet = useQuietMessage(feedback, Boolean(busy) || Boolean(lab.error));
  const roomLabel = labelOfRoom(progress.room, lab.memory);
  const crumbs: { label: string; onClick?: () => void }[] = [];
  if (place) crumbs.push(...place.map((label) => ({ label })));
  else if (roomLabel)
    crumbs.push({ label: roomLabel, onClick: () => lab.select({ kind: 'room' }) });
  const inView =
    lab.workScene === progress.view ||
    ['view', 'object', 'suggested', 'add'].includes(lab.selection?.kind ?? '');
  if (!place && progress.view && inView)
    crumbs.push({
      label: viewLabel(progress.view),
      onClick: () => lab.select({ kind: 'view' }),
    });
  const leaf = lab.selection && selectionLabel(lab, lab.selection);
  if (!place && leaf && !['room', 'view'].includes(lab.selection!.kind))
    crumbs.push({ label: leaf });
  return (
    <header className="topbar">
      <div className="topbar-id">
        <h1 className="brand-heading">
          <a className="brand" href="/" aria-label="Living Layer home">
            <span className="brand-icon">
              <Glyph />
            </span>
            <span className="brand-name">Living Layer</span>
          </a>
          {mode === 'live' && <span className="live-tag">LIVE</span>}
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
      {progress.room && !place && (
        <button
          className="outline-toggle"
          aria-label="Scene outline"
          aria-expanded={lab.outlineOpen}
          onClick={() => lab.setOutlineOpen(!lab.outlineOpen)}
        >
          <span aria-hidden="true">☰</span> {crumbs.at(-1)?.label}
        </button>
      )}
      <div
        className={`feedback ${lab.capsuleTone}${quiet ? ' quiet' : ''}`}
        role="status"
        aria-live="polite"
        title={quiet ? feedback : undefined}
      >
        {camera && <span className="privacy-dot" aria-label="Camera on" />}
        <span className="dot" />
        <span className="feedback-text">{feedback}</span>
        <AiStepsButton />
        {lab.lamp === 'virtual' && <span className="hud-tag">VIRTUAL</span>}
      </div>
      <nav className="topbar-links">
        <Segmented
          label="Data source"
          value={mode}
          disabled={Boolean(busy) || camera || cameraPending}
          onChange={lab.changeMode}
          options={[
            {
              value: 'demo',
              label: 'Demo',
              title: 'The demo office from its corner camera: no model calls, a virtual lamp',
            },
            {
              value: 'live',
              label: 'Live',
              title: 'Your photos and camera, real model calls and your lamp',
            },
          ]}
        />
        <span className="history" role="group" aria-label="Undo and redo">
          <IconButton
            label="Undo"
            title={`Undo (${SHORTCUTS[0]!.keys})`}
            disabled={!undo.current[mode].length || Boolean(busy) || camera}
            onClick={() => void lab.stepHistory(true)}
          >
            ↶
          </IconButton>
          <IconButton
            label="Redo"
            title={`Redo (${SHORTCUTS[1]!.keys})`}
            disabled={!redo.current[mode].length || Boolean(busy) || camera}
            onClick={() => void lab.stepHistory(false)}
          >
            ↷
          </IconButton>
        </span>
        <Popover
          label="Readiness"
          className="wide"
          button={(open, toggle) => (
            <button
              className={`budget-pill ${lab.metaReady ? 'ok' : 'unsure'}`}
              aria-expanded={open}
              aria-label="Readiness and spending"
              title="Models, spending, whether tracking may call AI, the lamp and live proof"
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
            <IconButton
              label="More"
              aria-expanded={open}
              title="Saves, shortcuts and starting over"
              onClick={toggle}
            >
              ⋯
            </IconButton>
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

/** Opens the AI dialog again when it was hidden; it renders when the task's state changes, not with each step. */
function AiStepsButton() {
  const hidden = useAiTaskPart((t) => (t && !t.open ? t.status : null));
  if (!hidden) return null;
  return (
    <button
      className="feedback-steps"
      onClick={() => {
        const task = aiTaskStore.get();
        if (task) setAiTask({ ...task, open: true });
      }}
    >
      {hidden === 'running' ? 'Show steps' : 'Steps'}
    </button>
  );
}
