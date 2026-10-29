import { MAX_RULES, isMugConcept } from '@livinglayer/domain';
import { useLab } from './LabContext';
import { mainSurface, roomLabel, selectionLabel, surfaceRows, type SurfaceRow } from './labels';
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
}: {
  label: string;
  detail?: string;
  state?: StepState;
  depth?: number;
  target: Selection;
  disabled?: boolean;
  title?: string;
  /** `chosen` for things you confirmed, `seen` for model suggestions, `add` for new things. */
  tone?: 'chosen' | 'seen' | 'add';
  /** What a click does, when it is more than showing the node. */
  onSelect?: () => void;
}) {
  const lab = useLab();
  const current = sameSelection(lab.selection, target);
  return (
    <li>
      <button
        className={`ol-row ${state ?? ''} ${tone ?? ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-label={label}
        aria-current={current ? 'true' : undefined}
        disabled={disabled}
        title={title}
        onClick={onSelect ?? (() => lab.select(target))}
      >
        <span className="ol-glyph" aria-hidden="true">
          {tone === 'add'
            ? '＋'
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
  const tracked = new Set(
    [memory?.object?.label, ...(memory?.others ?? []).map((o) => o.label)]
      .filter(Boolean)
      .map((l) => l!.toLowerCase()),
  );
  const suggested = (lab.scene?.objects ?? [])
    .map((o, index) => ({ o, index }))
    .filter(({ o }) => !tracked.has(o.label.toLowerCase()));
  const canRule =
    Boolean((memory?.object && memory.observation) || memory?.others?.some((o) => o.observation)) &&
    lab.entities.length > 0 &&
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
          <button
            className="icon-button sheet-close"
            aria-label="Close the outline"
            onClick={() => lab.setOutlineOpen(false)}
          >
            ×
          </button>
          <span className="tiny">
            SCENE · {done}/{progress.steps.length}
          </span>
          <button
            className="text-button"
            disabled={Boolean(busy) || Boolean(pinning)}
            onClick={() => lab.setChoosingScene(true)}
          >
            {progress.room ? 'Change' : 'Choose'}
          </button>
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
            <div className="pane-head ol-section">
              <span className="tiny">RULES</span>
            </div>
            <ul className="ol-tree">
              {memory?.object && (
                <Row
                  label="Mug zone"
                  detail={memory.zone ? `→ ${lab.lights[0] ?? 'main lamp'}` : 'draw a zone'}
                  state={memory.zone ? (memory.lastDecision ? 'done' : 'current') : 'current'}
                  target={{ kind: 'rule', id: 'main' }}
                />
              )}
              {(memory?.rules ?? []).map((r) => (
                <Row
                  key={r.id}
                  label={r.label}
                  detail={`→ ${r.entityId}`}
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
      </aside>
    </>
  );
}
