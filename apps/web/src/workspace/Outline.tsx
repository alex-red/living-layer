import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  MAX_EXPOSED,
  MAX_FIXTURES,
  MAX_RULES,
  MAIN_RULE,
  ago,
  cameraForScene,
  isMugConcept,
  mugOf,
  otherObjects,
  placedFixtures,
  type DeskMemory,
  type Fixture,
  type StatKey,
  type StatNow,
} from '@livinglayer/domain';
import { Button, IconButton } from '../ui/controls';
import { statBadge, statTone } from '../iso/StatBadges';
import { useNow } from '../useNow';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { stateLabel } from './stateLabel';
import { removeFromLayout } from './removeFromLayout';
import {
  useCamera,
  useDesk,
  useFeedback,
  useLabParts,
  useNavigation,
  useObservation,
  useTracking,
  useView,
} from './LabContext';
import { roomLabel } from './labels';
import { useCall } from './panel';
import { pinScene, roomOf, sameSelection, type Selection, type StepState } from './progress';
import {
  pickable,
  sceneChoices,
  sceneOutline,
  type SceneOutline,
  type ThingGroup,
  type ThingRow,
} from './sceneOutline';
import { useThingStats } from './state/stats';

const GLYPH: Record<StepState, string> = { done: '✓', current: '●', todo: '◌', locked: '–' };

/** Where a menu opens: at the pointer, or under the row when the keyboard opened it. */
function menuAt(e: MouseEvent) {
  const box = e.currentTarget.getBoundingClientRect();
  const keyboard = e.clientX === 0 && e.clientY === 0;
  return { x: keyboard ? box.left + 24 : e.clientX, y: keyboard ? box.bottom : e.clientY };
}

function Row({
  label,
  detail,
  meta,
  metaTone,
  glyph,
  className,
  depth = 0,
  target,
  disabled,
  title,
  onSelect,
  onContextMenu,
  checked,
}: {
  label: string;
  detail?: string;
  /** A short value at the right: a thing's stat now, a count. */
  meta?: string;
  metaTone?: string;
  glyph: string;
  /** Tones the glyph: `done`, `current`, `seen`, `missing`, `placed`, `built-in`, `add`. */
  className?: string;
  depth?: number;
  target?: Selection;
  disabled?: boolean;
  title?: string;
  /** What a click does, when it is more than showing the node. */
  onSelect?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  /** In select mode: whether it is picked. The glyph becomes a check box. */
  checked?: boolean;
}) {
  const lab = useLabParts(useView(), useNavigation());
  const current =
    checked === undefined && Boolean(target) && sameSelection(lab.selection, target ?? null);
  return (
    <li>
      <button
        className={`ol-row ${className ?? ''} ${checked ? 'picked' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-label={label}
        aria-current={current ? 'true' : undefined}
        aria-pressed={checked}
        disabled={disabled}
        title={title}
        onClick={onSelect ?? (() => target && lab.select(target))}
        onContextMenu={onContextMenu}
      >
        <span className={`ol-glyph ${checked === undefined ? '' : 'ol-check'}`} aria-hidden="true">
          {checked !== undefined ? (checked ? '✓' : '') : glyph}
        </span>
        <span className="ol-text">
          <span className="ol-label">{label}</span>
          {detail && <small>{detail}</small>}
        </span>
        {meta && <span className={`ol-meta ${metaTone ?? ''}`}>{meta}</span>}
      </button>
    </li>
  );
}

/**
 * The sidebar, one scene at a time: which scene, what is left to set it up,
 * the things in it by the surface they stand on, its zones, and Home
 * Assistant, which every scene shares.
 */
export function Outline() {
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useDesk(),
    useCamera(),
    useObservation(),
    useTracking(),
    useNavigation(),
  );
  const { progress, memory, workScene } = lab;
  const outline = useMemo(
    () =>
      workScene
        ? sceneOutline({
            scene: workScene,
            memory,
            mode: lab.mode,
            mainLight: lab.lights[0] ?? '',
            lightsOn: lab.lightsOn,
          })
        : null,
    [workScene, memory, lab.mode, lab.lights, lab.lightsOn],
  );

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
        </div>
        <SceneSwitcher />
        {!progress.room || !outline ? (
          <p className="ol-empty">Choose the room you are working in to begin.</p>
        ) : (
          <>
            <SetupCard />
            <Things outline={outline} />
            <Zones outline={outline} />
            <HomeAssistant />
          </>
        )}
      </aside>
    </>
  );
}

/** The scene being worked in, its camera, and the way to another: a menu of them, and room or close view. */
function SceneSwitcher() {
  const lab = useLabParts(useView(), useFeedback(), useDesk(), useCamera(), useNavigation());
  const { memory, workScene, busy, pinning } = lab;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const choices = sceneChoices(memory);
  const off = Boolean(busy) || Boolean(pinning);
  const room = workScene ? roomOf(workScene) : null;
  const family = choices.filter((c) => c.room === room);
  const go = (scene: (typeof choices)[number]['scene']) => {
    if (scene !== workScene) lab.pickScene(scene);
  };
  // The room's own camera, else whichever is open.
  const assigned = room ? cameraForScene(lab.network.streams, pinScene(room)) : null;
  const camera =
    lab.mode === 'demo'
      ? { text: 'demo camera', on: true }
      : assigned
        ? { text: assigned.name, on: lab.camera && lab.cameraSource === assigned.id }
        : lab.camera
          ? { text: lab.cameraSource ? 'network camera' : 'this device', on: true }
          : { text: 'no camera', on: false };
  return (
    <div className="ol-switch">
      <div className="ol-switch-head">
        <button
          className="ol-switch-button"
          aria-haspopup="menu"
          aria-label="Change scene"
          disabled={off}
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            setMenu({ x: box.left, y: box.bottom + 4 });
          }}
        >
          <span className="tiny">SCENE</span>
          <span className="ol-switch-label">
            {workScene ? roomLabel(workScene, memory) : 'Choose a scene'}
          </span>
          <span className="ol-switch-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {workScene && (
          <span
            className={`ol-cam ${camera.on ? 'on' : ''}`}
            title={camera.on ? 'The camera is on' : 'The camera is off'}
          >
            {camera.text}
          </span>
        )}
      </div>
      {family.length > 1 && (
        <div className="ol-scenes" role="tablist" aria-label="Room or close view">
          {family.map((c) => (
            <button
              key={c.scene}
              role="tab"
              aria-selected={c.scene === workScene}
              disabled={off}
              onClick={() => go(c.scene)}
            >
              {c.view ? c.label : 'Whole room'}
            </button>
          ))}
        </div>
      )}
      {menu && (
        <ContextMenu
          at={menu}
          label="Scenes"
          items={[
            ...choices.map((c): MenuItem => ({
              label: `${c.view ? '   ↳ ' : ''}${c.label}${c.scene === workScene ? '  ✓' : ''}`,
              onSelect: () => go(c.scene),
            })),
            {
              label: 'Other ways to start…',
              separated: true,
              onSelect: () => lab.setChoosingScene(true),
            },
          ]}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

/** What is left to set this scene up, in order; one line once it is all done. */
function SetupCard() {
  const lab = useLabParts(useObservation(), useNavigation());
  const steps = lab.progress.steps.filter((s) => s.id !== 'office');
  const done = steps.filter((s) => s.state === 'done').length;
  const all = done === steps.length;
  const [open, setOpen] = useState(!all);
  // Opens again when a step comes undone, as when the pin is cleared.
  const was = useRef(all);
  useEffect(() => {
    if (was.current && !all) setOpen(true);
    was.current = all;
  }, [all]);
  return (
    <section className={`ol-setup ${all ? 'all' : ''}`} aria-label="Setting up this scene">
      <button className="ol-setup-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tiny">{all ? 'SET UP ✓' : 'SET UP'}</span>
        <span className="ol-setup-bar" aria-hidden="true">
          {steps.map((s) => (
            <i key={s.id} className={s.state} />
          ))}
        </span>
        <span className="ol-setup-count">
          {done}/{steps.length}
        </span>
      </button>
      {open && (
        <ul className="ol-tree">
          {steps.map((s) => (
            <Row
              key={s.id}
              label={s.label}
              detail={s.state === 'current' ? s.detail : undefined}
              glyph={GLYPH[s.state]}
              className={s.state}
              onSelect={() => lab.goToStep(s.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A thing's first stat now, as a short value and its tone. */
function useStatMeta(id: string | null, lamp: boolean) {
  const stats = useThingStats(id ?? '');
  const now = useNow(30_000);
  const first = id ? (Object.entries(stats ?? {})[0] as [StatKey, StatNow] | undefined) : undefined;
  if (!first) return null;
  const [key, s] = first;
  return { text: statBadge(key, s, now).toLowerCase(), tone: statTone(s, lamp) };
}

const THING_GLYPH: Record<ThingRow['kind'], string> = {
  followed: '◆',
  placed: '◇',
  'built-in': '▫',
};

function ThingLine({
  t,
  depth,
  selecting,
  checked,
  onToggle,
  onMenu,
}: {
  t: ThingRow;
  depth: number;
  selecting: boolean;
  checked: boolean;
  onToggle: (f: Fixture, e: MouseEvent) => void;
  onMenu: (t: ThingRow, e: MouseEvent) => void;
}) {
  const stat = useStatMeta(t.id, t.lamp);
  const now = useNow(30_000);
  // A followed thing without a stat says when it was last seen.
  const seen =
    t.seenAt && (!t.detail || t.detail === 'missing')
      ? `${t.status === 'missing' ? 'missing · ' : ''}seen ${ago(now - t.seenAt)} ago`
      : '';
  return (
    <Row
      label={t.label}
      detail={stat ? undefined : seen || t.detail || undefined}
      meta={stat?.text}
      metaTone={stat?.tone}
      glyph={THING_GLYPH[t.kind]}
      className={`${t.kind} ${t.status}`}
      depth={depth}
      target={t.target}
      {...(selecting
        ? t.fixture
          ? { checked, onSelect: (e: MouseEvent) => onToggle(t.fixture!, e) }
          : { disabled: true, title: 'Only placed fixtures can be picked here.' }
        : {})}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(t, e);
      }}
    />
  );
}

/**
 * The scene's things under the surface each stands on, then the floor, then
 * the close view as one row. Right-click one for its menu; Select turns the
 * placed fixtures into check boxes, to delete several at once. Shift-click
 * picks a run of them, Escape leaves.
 */
function Things({ outline }: { outline: SceneOutline }) {
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useDesk(),
    useCamera(),
    useObservation(),
    useNavigation(),
  );
  const { memory, busy } = lab;
  const { call, off } = useCall();
  const fixtures = pickable(outline);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'delete' | 'dismiss' | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; thing: ThingRow } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [adding, setAdding] = useState<{ x: number; y: number } | null>(null);
  const closeAdding = useCallback(() => setAdding(null), []);
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

  // A suggestion from the photo goes once something followed covers it: by name, or by being the mug.
  const tracked = new Set(
    [mugOf(memory)?.label, ...otherObjects(memory).flatMap((o) => [o.label, o.concept])]
      .filter(Boolean)
      .map((l) => l!.trim().toLowerCase()),
  );
  const pinnedHere = outline.groups.some((g) => g.pinned);
  const suggested = pinnedHere
    ? (lab.scene?.objects ?? [])
        .map((o, index) => ({ o, index }))
        .filter(
          ({ o }) =>
            !tracked.has(o.label.toLowerCase()) &&
            !tracked.has(o.category.toLowerCase()) &&
            !(mugOf(memory) && isMugConcept(o.category)),
        )
    : [];

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
  function menuFor(t: ThingRow): MenuItem[] {
    const open: MenuItem = { label: 'Open', onSelect: () => lab.select(t.target) };
    const f = t.fixture;
    if (t.layout) {
      const { group, label } = t.layout;
      return [
        open,
        {
          label: 'Remove from the room',
          destructive: true,
          separated: true,
          onSelect: () => void removeFromLayout(lab, call, group, label),
        },
      ];
    }
    if (!f) return [open];
    if (selecting && picked.has(f.id) && chosen.length > 1)
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
      open,
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
  const full = placedFixtures(memory).length >= MAX_FIXTURES;
  const empty = !outline.groups.some((g) => g.things.length) && !outline.view;
  const group = (g: ThingGroup) => (
    <li key={g.key} className="ol-group">
      {g.surface ? (
        <button
          className="ol-group-head"
          aria-current={
            sameSelection(lab.selection, { kind: 'surface', id: g.surface.id }) ? 'true' : undefined
          }
          onClick={() => lab.select({ kind: 'surface', id: g.surface!.id })}
        >
          <span>{g.label}</span>
          <small className={g.pinned ? 'pinned' : ''}>{g.pinned ? 'pinned' : ''}</small>
        </button>
      ) : (
        <span className="ol-group-head static">
          <span>{g.label}</span>
        </span>
      )}
      <ul className="ol-tree">
        {g.things.map((t) => (
          <ThingLine
            key={t.key}
            t={t}
            depth={1}
            selecting={selecting}
            checked={Boolean(t.fixture && picked.has(t.fixture.id))}
            onToggle={toggle}
            onMenu={(thing, e) => setMenu({ ...menuAt(e), thing })}
          />
        ))}
        {!g.things.length && <li className="ol-note">Nothing on it yet.</li>}
      </ul>
    </li>
  );
  return (
    <>
      <div className="pane-head ol-section">
        <span className="tiny">THINGS{selecting ? ` · ${chosen.length} SELECTED` : ''}</span>
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
          <span className="ol-head-actions">
            {fixtures.length > 1 && (
              <Button variant="text" disabled={off} onClick={() => setSelecting(true)}>
                Select
              </Button>
            )}
            <Button
              variant="text"
              aria-haspopup="menu"
              disabled={Boolean(busy)}
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                setAdding({ x: box.left, y: box.bottom + 4 });
              }}
            >
              ＋ Add
            </Button>
          </span>
        )}
      </div>
      {empty && (
        <p className="ol-empty">
          Nothing here yet. Add a thing the camera can follow, like a mug, or place one by hand.
        </p>
      )}
      <ul className={`ol-groups ${selecting ? 'selecting' : ''}`}>
        {outline.groups.map(group)}
        {suggested.length > 0 && (
          <li className="ol-group">
            <span className="ol-group-head static">
              <span>Seen in the photo</span>
            </span>
            <ul className="ol-tree">
              {suggested.map(({ o, index }) => (
                <Row
                  key={`s${index}`}
                  label={o.label}
                  detail={isMugConcept(o.category) && !mugOf(memory) ? 'the mug?' : 'follow it?'}
                  glyph="◆"
                  className="suggested"
                  depth={1}
                  target={{ kind: 'suggested', index }}
                />
              ))}
            </ul>
          </li>
        )}
      </ul>
      {outline.view && !selecting && (
        <ul className="ol-tree">
          <Row
            label={outline.view.label}
            detail="close view"
            meta={`${outline.view.things} thing${outline.view.things === 1 ? '' : 's'}${outline.view.rules ? ` · ${outline.view.rules} zone${outline.view.rules === 1 ? '' : 's'}` : ''} ›`}
            glyph="▣"
            className="view"
            onSelect={() => lab.pickScene(outline.view!.scene)}
          />
        </ul>
      )}
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
          label={`${menu.thing.label} actions`}
          items={menuFor(menu.thing)}
          onClose={closeMenu}
        />
      )}
      {adding && (
        <ContextMenu
          at={adding}
          label="Add a thing"
          items={[
            {
              label: 'Follow it with the camera',
              onSelect: () => lab.select({ kind: 'add' }),
            },
            {
              label: 'Place a fixture by hand',
              disabled: full,
              onSelect: () => lab.select({ kind: 'new-fixture' }),
            },
          ]}
          onClose={closeAdding}
        />
      )}
    </>
  );
}

/** The scene's zones, each with the light it switches and whether it is occupied. */
function Zones({ outline }: { outline: SceneOutline }) {
  const lab = useLabParts(useView(), useFeedback(), useDesk(), useNavigation());
  const { memory, busy } = lab;
  const first = outline.followed[0];
  const canRule =
    Boolean(first) && (memory?.rules ?? []).filter((r) => r.id !== MAIN_RULE).length < MAX_RULES;
  return (
    <>
      <div className="pane-head ol-section">
        <span className="tiny">ZONES</span>
        <Button
          variant="text"
          disabled={!canRule || Boolean(busy)}
          title={canRule ? undefined : 'Follow a thing in this scene first.'}
          onClick={() => lab.startRule(first)}
        >
          ＋ Add
        </Button>
      </div>
      <ul className="ol-tree">
        {outline.rules.map((r) => (
          <Row
            key={r.id}
            label={r.label}
            detail={r.detail}
            glyph={r.inside ? '●' : '○'}
            className={r.inside ? 'occupied' : r.ran ? 'done' : 'todo'}
            target={{ kind: 'rule', id: r.id }}
          />
        ))}
        {!outline.rules.length && (
          <li className="ol-note">
            {first
              ? 'No zones here yet. Draw one where a thing should be, to switch a light.'
              : 'Follow a thing first; a zone switches a light when it is in it.'}
          </li>
        )}
      </ul>
    </>
  );
}

/** Home Assistant, shared by every scene: the devices it may switch and what it shows there. */
function HomeAssistant() {
  const lab = useLabParts(useFeedback(), useDesk(), useTracking(), useNavigation(), useView());
  const { memory, busy } = lab;
  const exposed = memory?.exposed ?? [];
  const ready = lab.entities.length && (lab.mode === 'demo' || lab.lampReady);
  return (
    <details className="ol-ha">
      <summary>
        <span className="tiny">HOME ASSISTANT</span>
        <small className={`ol-broker ${lab.expose?.broker.state ?? ''}`}>
          {lab.mode === 'demo'
            ? 'demo'
            : lab.expose
              ? `mqtt · ${lab.expose.broker.state}`
              : 'not connected'}
          {` · ${lab.entities.length} device${lab.entities.length === 1 ? '' : 's'}`}
        </small>
      </summary>
      <ul className="ol-tree">
        <Row
          label="Devices it can switch"
          detail={
            lab.entities.length
              ? `${lab.entities.length} ready${lab.mode === 'live' && !lab.lampReady ? ' · switching off' : ''}`
              : 'connect, then pick a few'
          }
          glyph={ready ? '✓' : '●'}
          className={ready ? 'done' : 'current'}
          target={{ kind: 'devices' }}
        />
        {exposed.map((e) => (
          <Row
            key={e.id}
            label={e.name}
            detail={`ll_${e.key} · ${stateLabel(lab.expose?.states.find((s) => s.id === e.id))}`}
            glyph="◆"
            className="seen"
            target={{ kind: 'entity', id: e.id }}
          />
        ))}
        <Row
          label="Show in Home Assistant"
          detail={exposed.length ? undefined : 'presence, zones, missing things'}
          glyph="＋"
          className="add"
          target={{ kind: 'new-entity' }}
          disabled={exposed.length >= MAX_EXPOSED || Boolean(busy)}
        />
      </ul>
    </details>
  );
}
