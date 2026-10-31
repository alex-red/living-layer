import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import {
  MAX_EXPOSED,
  MAX_FIXTURES,
  MAX_RULES,
  isMugConcept,
  type DeskMemory,
  type Fixture,
} from '@livinglayer/domain';
import { Button, IconButton } from '../ui/controls';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { stateLabel } from './ExposePanel';
import { useLab } from './LabContext';
import {
  builtInLamps,
  controlLabel,
  mainSurface,
  roomLabel,
  selectionLabel,
  surfaceRows,
  type SurfaceRow,
} from './labels';
import { useCall } from './panel';
import { sameSelection, type Selection, type StepState } from './progress';

const GLYPH: Record<StepState, string> = { done: '✓', current: '●', todo: '◌', locked: '–' };

function Row({
  label,
  detail,
  state,
  depth = 0,
  target,
  disabled,
  title,
  tone,
  onSelect,
  onContextMenu,
  checked,
}: {
  label: string;
  detail?: string;
  state?: StepState;
  depth?: number;
  target: Selection;
  disabled?: boolean;
  title?: string;
  /**
   * `chosen` for things you confirmed, `seen` for model suggestions, `fixture`
   * for things placed by hand, `add` for new things.
   */
  tone?: 'chosen' | 'seen' | 'fixture' | 'add';
  /** What a click does, when it is more than showing the node. */
  onSelect?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  /** In select mode: whether it is picked. The glyph becomes a check box. */
  checked?: boolean;
}) {
  const lab = useLab();
  const current = checked === undefined && sameSelection(lab.selection, target);
  return (
    <li>
      <button
        className={`ol-row ${state ?? ''} ${tone ?? ''} ${checked ? 'picked' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-label={label}
        aria-current={current ? 'true' : undefined}
        aria-pressed={checked}
        disabled={disabled}
        title={title}
        onClick={onSelect ?? (() => lab.select(target))}
        onContextMenu={onContextMenu}
      >
        <span className={`ol-glyph ${checked === undefined ? '' : 'ol-check'}`} aria-hidden="true">
          {checked !== undefined
            ? checked
              ? '✓'
              : ''
            : tone === 'add'
              ? '＋'
              : tone === 'fixture'
                ? '◇'
                : tone === 'chosen' || tone === 'seen'
                  ? '◆'
                  : state
                    ? GLYPH[state]
                    : '▫'}
        </span>
        <span className="ol-text">
          <span className="ol-label">{label}</span>
          {detail && <small>{detail}</small>}
        </span>
      </button>
    </li>
  );
}

/**
 * The scene outline: the room, the desk inside it, the desk's surfaces and
 * objects, then the rules. Rows are in setup order, and each row's glyph says
 * whether it is done, so the outline is also the checklist.
 */
export function Outline() {
  const lab = useLab();
  const { progress, memory, busy, pinning } = lab;
  const step = Object.fromEntries(progress.steps.map((s) => [s.id, s]));
  const rows = surfaceRows(lab);
  const objectDepth = progress.view ? 2 : 1;
  // A suggestion goes once something remembered covers it: by name, or by what it is (the mug).
  const tracked = new Set(
    [memory?.object?.label, ...(memory?.others ?? []).flatMap((o) => [o.label, o.concept])]
      .filter(Boolean)
      .map((l) => l!.trim().toLowerCase()),
  );
  const suggested = (lab.scene?.objects ?? [])
    .map((o, index) => ({ o, index }))
    .filter(
      ({ o }) =>
        !tracked.has(o.label.toLowerCase()) &&
        !tracked.has(o.category.toLowerCase()) &&
        !(memory?.object && isMugConcept(o.category)),
    );
  const canRule =
    Boolean((memory?.object && memory.observation) || memory?.others?.some((o) => o.observation)) &&
    (memory?.rules?.length ?? 0) < MAX_RULES;
  const surface = (r: SurfaceRow, depth: number) => (
    <Row
      key={`${r.scene}:${r.surface.id}`}
      label={r.surface.label}
      detail={r.pinned ? 'pinned' : 'not pinned'}
      state={r.pinned ? 'done' : 'todo'}
      depth={depth}
      target={{ kind: 'surface', id: r.surface.id }}
    />
  );
  const done = progress.steps.filter((s) => s.state === 'done').length;

  return (
    <>
      {lab.outlineOpen && (
        <div
          className="sheet-backdrop"
          aria-hidden="true"
          onClick={() => lab.setOutlineOpen(false)}
        />
      )}
      <aside className={`ws-outline ${lab.outlineOpen ? 'open' : ''}`} aria-label="Scene outline">
        <div className="pane-head">
          <IconButton
            className="sheet-close"
            label="Close the outline"
            onClick={() => lab.setOutlineOpen(false)}
          >
            ×
          </IconButton>
          <span className="tiny">
            SCENE · {done}/{progress.steps.length}
          </span>
          <Button
            variant="text"
            disabled={Boolean(busy) || Boolean(pinning)}
            onClick={() => lab.setChoosingScene(true)}
          >
            {progress.room ? 'Change' : 'Choose'}
          </Button>
        </div>
        {!progress.room ? (
          <p className="ol-empty">Choose the room you are working in to begin.</p>
        ) : (
          <ul className="ol-tree">
            <Row
              label={roomLabel(progress.room, memory)}
              detail={progress.room === 'custom' ? 'from your photo' : 'room'}
              state={step.office!.state}
              target={{ kind: 'room' }}
            />
            {progress.view ? (
              <Row
                label={selectionLabel(lab, { kind: 'view' })}
                detail={step.desk!.state === 'done' ? 'close view · pinned' : 'close view · pin it'}
                state={step.desk!.state}
                depth={1}
                target={{ kind: 'view' }}
              />
            ) : (
              !mainSurface(lab) && (
                <li className="ol-note">
                  This room has no surface yet. Edit its layout to add one.
                </li>
              )
            )}
            {rows.view.map((r) => surface(r, 2))}
            {memory?.object && (
              <Row
                label={memory.object.label}
                detail={lab.currentObservation ? 'tracked · in this frame' : 'tracked'}
                tone="chosen"
                depth={objectDepth}
                target={{ kind: 'object', id: 'main' }}
              />
            )}
            {(memory?.others ?? []).map((o) => (
              <Row
                key={o.id}
                label={o.label}
                detail={o.concept}
                tone="chosen"
                depth={objectDepth}
                target={{ kind: 'object', id: o.id }}
              />
            ))}
            {suggested.map(({ o, index }) => (
              <Row
                key={`s${index}`}
                label={o.label}
                detail={
                  isMugConcept(o.category) && !memory?.object ? 'suggested · the mug?' : 'suggested'
                }
                tone="seen"
                depth={objectDepth}
                target={{ kind: 'suggested', index }}
              />
            ))}
            <Row
              label="Add object"
              detail={step.objects!.state === 'current' ? 'next: find the mug' : undefined}
              tone="add"
              depth={objectDepth}
              target={{ kind: 'add' }}
            />
            {rows.room.map((r) => surface(r, 1))}
          </ul>
        )}
        {progress.room && (
          <>
            <FixtureRows />
          </>
        )}
        {progress.room && (
          <>
            <div className="pane-head ol-section">
              <span className="tiny">RULES</span>
            </div>
            <ul className="ol-tree">
              {memory?.object && (
                <Row
                  label="Main zone"
                  detail={memory.zone ? `→ ${lab.lights[0] ?? 'main lamp'}` : 'draw a zone'}
                  state={memory.zone ? (memory.lastDecision ? 'done' : 'current') : 'current'}
                  target={{ kind: 'rule', id: 'main' }}
                />
              )}
              {(memory?.rules ?? []).map((r) => (
                <Row
                  key={r.id}
                  label={r.label}
                  detail={r.entityId ? `→ ${r.entityId}` : '→ Home Assistant only'}
                  state={r.lastDecision ? 'done' : 'todo'}
                  target={{ kind: 'rule', id: r.id }}
                />
              ))}
              <Row
                label="Add rule"
                tone="add"
                target={{ kind: 'new-rule' }}
                onSelect={() =>
                  lab.startRule(
                    memory?.object && memory.observation
                      ? memory.object.id
                      : memory!.others!.find((o) => o.observation)!.id,
                  )
                }
                disabled={!canRule || Boolean(busy)}
                title={canRule ? undefined : 'Remember an object first.'}
              />
            </ul>
          </>
        )}
        {progress.room && (
          <>
            <div className="pane-head ol-section">
              <span className="tiny">HOME ASSISTANT</span>
              {lab.expose && (
                <small className={`ol-broker ${lab.expose.broker.state}`}>
                  {lab.mode === 'demo'
                    ? 'demo · not published'
                    : `mqtt · ${lab.expose.broker.state}`}
                </small>
              )}
            </div>
            <ul className="ol-tree">
              {(memory?.exposed ?? []).map((e) => (
                <Row
                  key={e.id}
                  label={e.name}
                  detail={`ll_${e.key} · ${stateLabel(lab.expose?.states.find((s) => s.id === e.id))}`}
                  tone="chosen"
                  target={{ kind: 'entity', id: e.id }}
                />
              ))}
              <Row
                label="Show in Home Assistant"
                detail={memory?.exposed?.length ? undefined : 'presence, zones, missing things'}
                tone="add"
                target={{ kind: 'new-entity' }}
                disabled={(memory?.exposed?.length ?? 0) >= MAX_EXPOSED || Boolean(busy)}
              />
            </ul>
          </>
        )}
      </aside>
    </>
  );
}

/**
 * The fixtures: the room's built-in lamps, then the ones you added. Right-click
 * one for its menu; Select turns the list into check boxes, to delete several
 * at once. Shift-click picks a run of them, Escape leaves.
 */
function FixtureRows() {
  const lab = useLab();
  const { memory, busy } = lab;
  const { call, off } = useCall();
  const fixtures = memory?.fixtures ?? [];
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'delete' | 'dismiss' | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; fixture: Fixture } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // Fixtures deleted elsewhere drop out of the selection.
  const chosen = fixtures.filter((f) => picked.has(f.id));
  const leave = useCallback(() => {
    setSelecting(false);
    setPicked(new Set());
    setAnchor(null);
    setConfirming(null);
  }, []);
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (menu) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (confirming) setConfirming(null);
        else leave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting, confirming, menu, leave]);
  useEffect(() => {
    if (selecting && !fixtures.length) leave();
  }, [selecting, fixtures.length, leave]);

  function remove(ids: string[], dismiss = false) {
    const gone = fixtures.filter((f) => ids.includes(f.id));
    void call<DeskMemory>(
      'fixtures/delete',
      { fixtureIds: ids, ...(dismiss ? { dismiss: true } : {}) },
      (m) => {
        lab.setMemory(m);
        if (lab.selection?.kind === 'fixture' && ids.includes(lab.selection.id)) lab.select(null);
        leave();
        lab.setMessage(
          (gone.length === 1
            ? `Removed the ${gone[0]!.label.toLowerCase()}.`
            : `Removed ${gone.length} fixtures.`) +
            (dismiss
              ? ` Scans will skip things named like ${gone.length === 1 ? 'it' : 'them'}.`
              : ''),
        );
      },
    );
  }
  function toggle(f: Fixture, e: MouseEvent) {
    const next = new Set(picked);
    if (e.shiftKey && anchor) {
      const a = fixtures.findIndex((x) => x.id === anchor);
      const b = fixtures.findIndex((x) => x.id === f.id);
      const on = !picked.has(f.id);
      for (const x of fixtures.slice(Math.min(a, b), Math.max(a, b) + 1))
        if (on) next.add(x.id);
        else next.delete(x.id);
    } else if (next.has(f.id)) next.delete(f.id);
    else next.add(f.id);
    setPicked(next);
    setAnchor(f.id);
    setConfirming(null);
  }
  function menuFor(f: Fixture): MenuItem[] {
    const many = selecting && picked.has(f.id) && chosen.length > 1;
    if (many)
      return [
        {
          label: `Delete ${chosen.length} fixtures`,
          destructive: true,
          onSelect: () => remove(chosen.map((x) => x.id)),
        },
        {
          label: `Not fixtures (${chosen.length})`,
          destructive: true,
          onSelect: () =>
            remove(
              chosen.map((x) => x.id),
              true,
            ),
        },
      ];
    return [
      { label: 'Open', onSelect: () => lab.select({ kind: 'fixture', id: f.id }) },
      {
        label: selecting ? (picked.has(f.id) ? 'Unselect' : 'Select') : 'Select…',
        onSelect: () => {
          setSelecting(true);
          setPicked((p) => {
            const next = new Set(p);
            if (selecting && next.has(f.id)) next.delete(f.id);
            else next.add(f.id);
            return next;
          });
          setAnchor(f.id);
        },
      },
      { label: 'Delete', destructive: true, separated: true, onSelect: () => remove([f.id]) },
      { label: 'Not a fixture', destructive: true, onSelect: () => remove([f.id], true) },
    ];
  }
  const all = chosen.length === fixtures.length;
  return (
    <>
      <div className="pane-head ol-section">
        <span className="tiny">FIXTURES{selecting ? ` · ${chosen.length} SELECTED` : ''}</span>
        {selecting ? (
          <span className="ol-head-actions">
            <Button
              variant="text"
              onClick={() => {
                setPicked(all ? new Set() : new Set(fixtures.map((f) => f.id)));
                setConfirming(null);
              }}
            >
              {all ? 'None' : 'All'}
            </Button>
            <Button variant="text" onClick={leave}>
              Done
            </Button>
          </span>
        ) : (
          fixtures.length > 1 && (
            <Button variant="text" disabled={off} onClick={() => setSelecting(true)}>
              Select
            </Button>
          )
        )}
      </div>
      <ul className={`ol-tree ${selecting ? 'selecting' : ''}`}>
        {builtInLamps(lab).map((l) => (
          <Row
            key={l.id}
            label={l.prop.label}
            detail={`built in · ${l.entity ? `light · ${lab.lightsOn.has(l.entity) ? 'on' : 'off'}` : 'no light'}`}
            tone="fixture"
            target={{ kind: 'lamp', id: l.id }}
            disabled={selecting}
            title={selecting ? 'Built into the room: it can’t be deleted.' : undefined}
          />
        ))}
        {fixtures.map((f) => (
          <Row
            key={f.id}
            label={f.label}
            detail={controlLabel(f)}
            tone="fixture"
            target={{ kind: 'fixture', id: f.id }}
            {...(selecting
              ? { checked: picked.has(f.id), onSelect: (e: MouseEvent) => toggle(f, e) }
              : {})}
            onContextMenu={(e) => {
              e.preventDefault();
              // The menu key opens it at the row, not the pointer.
              const box = e.currentTarget.getBoundingClientRect();
              const keyboard = e.clientX === 0 && e.clientY === 0;
              setMenu({
                x: keyboard ? box.left + 24 : e.clientX,
                y: keyboard ? box.bottom : e.clientY,
                fixture: f,
              });
            }}
          />
        ))}
        {!selecting && (
          <Row
            label="Add fixture"
            detail={fixtures.length ? undefined : 'from a photo of it'}
            tone="add"
            target={{ kind: 'new-fixture' }}
            disabled={fixtures.length >= MAX_FIXTURES || Boolean(busy)}
          />
        )}
      </ul>
      {selecting && (
        <div className="ol-bulk" role="toolbar" aria-label="Selected fixtures">
          {confirming ? (
            <>
              <span className="ol-bulk-note">
                {confirming === 'delete'
                  ? `Delete ${chosen.length} fixture${chosen.length === 1 ? '' : 's'}?`
                  : `Delete ${chosen.length} and skip ${chosen.length === 1 ? 'it' : 'them'} in scans?`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="destructive"
                disabled={off}
                autoFocus
                onClick={() =>
                  remove(
                    chosen.map((f) => f.id),
                    confirming === 'dismiss',
                  )
                }
              >
                {off ? 'Deleting…' : 'Delete'}
              </Button>
              <Button size="sm" disabled={off} onClick={() => setConfirming(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <span className="ol-bulk-note">
                {chosen.length ? `${chosen.length} selected` : 'Pick fixtures · shift-click a run'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="destructive"
                disabled={off || !chosen.length}
                onClick={() => setConfirming('delete')}
              >
                Delete
              </Button>
              <Button
                size="sm"
                disabled={off || !chosen.length}
                title="Delete them, and have scans skip things named like them."
                onClick={() => setConfirming('dismiss')}
              >
                Not fixtures
              </Button>
            </>
          )}
        </div>
      )}
      {menu && (
        <ContextMenu
          at={menu}
          label={`${menu.fixture.label} actions`}
          items={menuFor(menu.fixture)}
          onClose={closeMenu}
        />
      )}
    </>
  );
}
