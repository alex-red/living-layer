import { useRef, useState, type ReactNode } from 'react';
import {
  DEMO_REFERENCES,
  DEMO_SURFACE,
  ISO_PRESETS,
  STARTER_TEMPLATES,
  calibrationOf,
  linkedFixtures,
  pinFits,
  fixtureEntity,
  fixtureInput,
  fixtureModel,
  fixtureReference,
  fixtureSize,
  fixtureStateNames,
  starterFixtureDraft,
  starterMeta,
  tileCm,
  type ControlKind,
  type DemoReference,
  type DeskMemory,
  type EvidenceRun,
  type Fixture,
  type FixtureControl,
  type FixtureDraft,
  type FixtureInput,
  type LampResult,
  type MappedThing,
  type StarterTemplate,
  type ZoneRect,
} from '@livinglayer/domain';
import { api } from '../api';
import { Glyph } from '../Glyph';
import {
  Button,
  Check,
  Field,
  IconButton,
  Segmented,
  Select,
  type ButtonVariant,
} from '../ui/controls';
import { itemSprite } from '../iso/sprites';
import type { FixturePlacing } from '../iso/IsoView';
import { useLab } from './LabContext';
import { ago, builtInLamps, controlLabel, roomLabel } from './labels';
import { pinScene } from './progress';
import { Cost, Details, Panel, useCall } from './panel';
import type { IsoSceneKind } from '@livinglayer/domain';

/** Fixtures stand in a room or a preset close view; a photographed room's desk view is the room's own. */
type WorkScene = IsoSceneKind | 'custom';

const KIND_LABEL: Record<ControlKind, string> = {
  light: 'Light',
  switch: 'Switch',
  none: 'Just a thing',
};
/** The ones you can switch first, then the plain thing. */
const KIND_ORDER: ControlKind[] = ['light', 'switch', 'none'];
const REFERENCE_LABEL: Record<DemoReference, string> = {
  mouse: 'Computer mouse',
  lamp: 'Desk lamp',
  monitor: 'Monitor',
  cat: 'Cat',
};

/** The model as a small pixel-art picture, for review. */
function ModelPreview({ model }: { model: FixtureDraft['model'] }) {
  const sprite = itemSprite(model, { scale: 3, resolution: 48 });
  return (
    <img
      className="fixture-model"
      src={sprite.url}
      width={sprite.width}
      height={sprite.height}
      alt={`The drafted model of the ${model.label.toLowerCase()}`}
    />
  );
}

/** A box in shares of the frame, as thousandths for the server. */
const thousandths = (r: ZoneRect) => ({
  x1: Math.round(r.x * 1000),
  y1: Math.round(r.y * 1000),
  x2: Math.max(Math.round(r.x * 1000) + 1, Math.round((r.x + r.width) * 1000)),
  y2: Math.max(Math.round(r.y * 1000) + 1, Math.round((r.y + r.height) * 1000)),
});
/** A photo the person chose, scaled down here so the upload stays small. */
async function photoDataUrl(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 10_000_000)
    throw new Error('Choose a PNG or JPEG under 10 MB.');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot prepare the image.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    bitmap.close();
  }
}
/** A button that picks a photo; with `capture`, phones open the camera instead. */
function PhotoButton({
  variant,
  capture,
  disabled,
  onFile,
  children,
}: {
  variant: ButtonVariant;
  capture?: boolean;
  disabled: boolean;
  onFile: (file: File) => void;
  children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant={variant} disabled={disabled} onClick={() => input.current?.click()}>
        {children}
      </Button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg"
        hidden
        {...(capture ? { capture: 'environment' as const } : {})}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onFile(file);
        }}
      />
    </>
  );
}

/** Light, switch or just a thing, and which entity it switches. */
function ControlPicker({
  kind,
  entity,
  onKind,
  onEntity,
}: {
  kind: ControlKind;
  entity: string;
  onKind: (kind: ControlKind) => void;
  onEntity: (entity: string) => void;
}) {
  const { entities } = useLab();
  const of = (k: ControlKind) => entities.filter((e) => e.startsWith(`${k}.`));
  const choices = kind === 'none' ? [] : of(kind);
  return (
    <>
      <div className="mode-switch three fixture-kind" role="group" aria-label="What is it?">
        {KIND_ORDER.map((k) => {
          const none = k !== 'none' && !of(k).length;
          return (
            <button
              key={k}
              aria-pressed={kind === k}
              disabled={none}
              title={none ? `No ${k} entities are configured.` : undefined}
              onClick={() => {
                onKind(k);
                onEntity(k === 'none' ? '' : (of(k)[0] ?? ''));
              }}
            >
              {KIND_LABEL[k]}
            </button>
          );
        })}
      </div>
      {kind !== 'none' && (
        <select
          aria-label={`Which ${kind}`}
          value={entity}
          onChange={(e) => onEntity(e.target.value)}
        >
          {choices.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      )}
      {!of('switch').length && (
        <p className="micro">Set HA_SWITCH_ENTITY_IDS to tie a fixture to a switch.</p>
      )}
    </>
  );
}
const controlOf = (kind: ControlKind, entity: string): FixtureControl =>
  kind === 'light'
    ? { kind, entityId: entity }
    : kind === 'switch'
      ? { kind, entityId: entity }
      : { kind: 'none' };

/** The scenes a fixture can go in: the room, and its close view when it has one. */
function useScenes(): { id: WorkScene; label: string }[] {
  const { progress, memory } = useLab();
  return [
    ...(progress.room
      ? [{ id: pinScene(progress.room), label: roomLabel(progress.room, memory) }]
      : []),
    ...(progress.view && progress.view !== 'custom-desk'
      ? [{ id: progress.view, label: ISO_PRESETS[progress.view].label }]
      : []),
  ];
}

const MATCH_LABEL: Record<MappedThing['match'], string> = {
  existing: 'In the room',
  library: 'From the library',
  fitted: 'Fitted',
  dismissed: 'Skipped',
  placeholder: 'Placeholder',
};

/**
 * Scan and map the pinned view into the room or its close view: what stays
 * put in the desk photo is found, matched against the fixtures already
 * saved, and the rest added with models fitted to SAM's outlines. Scanning both scenes
 * links each thing across them.
 */
export function ScanFixtures({
  initial,
  open = false,
}: {
  initial: WorkScene | null;
  open?: boolean;
}) {
  const lab = useLab();
  const { call, off } = useCall();
  const [mapped, setMapped] = useState<MappedThing[] | null>(null);
  const [replace, setReplace] = useState(false);
  const live = lab.mode === 'live';
  // The demo scans its office through the demo camera, whose pin is always the same.
  const pin = live ? lab.memory?.surface : DEMO_SURFACE;
  const scenes = useScenes().filter((s) => pin && pinFits(pin, s.id));
  const [chosen, setChosen] = useState<WorkScene | null>(initial);
  const scene = scenes.find((s) => s.id === chosen)?.id ?? scenes[0]?.id ?? null;
  // A drafted room can be scanned from the photo it was drafted from.
  const roomPhoto =
    pin?.scene === 'custom' && Boolean(lab.memory?.scenePhoto || lab.memory?.illustration);
  const blocked = (live && !lab.image && !lab.camera && !roomPhoto) || !scene;
  const inScene = (lab.memory?.fixtures ?? []).filter((f) => f.scene === scene);
  const placedByHand = inScene.some((f) => !f.scanned);
  return (
    <Details summary="Scan and map fixtures" open={open}>
      <p className="micro">
        {live
          ? `Spark lists what stays put in ${lab.camera ? 'what the camera shows' : lab.image ? 'the desk photo' : 'the room’s photo'} and SAM outlines each one. Known fixtures are reused; new ones are modelled.`
          : 'Scans the demo office, no model calls. Known fixtures are reused; new ones are modelled.'}
      </p>
      {scenes.length > 1 && (
        <Segmented
          label="Scene to map into"
          value={scene ?? ''}
          onChange={(id) => setChosen(id as WorkScene)}
          options={scenes.map((s) => ({ value: s.id, label: s.label }))}
        />
      )}
      <Button
        disabled={off || blocked}
        title={blocked ? (scene ? 'Add a desk photo first.' : 'Pin a surface first.') : undefined}
        onClick={() =>
          void lab.scanFixtures(scene!, replace).then((m) => {
            if (m) setMapped(m);
          })
        }
      >
        {lab.busy === 'scan'
          ? 'Scanning…'
          : inScene.some((f) => f.scanned)
            ? 'Scan again'
            : 'Scan and map'}
      </Button>
      {placedByHand && (
        <Check checked={replace} disabled={off} onChange={setReplace}>
          Also move fixtures you placed by hand to where the scan finds them
        </Check>
      )}
      <Cost>1 Spark and 1 SAM call, refused if today’s limit can’t cover them.</Cost>
      {(lab.memory?.dismissed?.length ?? 0) > 0 && (
        <p className="micro">
          Skipped as not fixtures:{' '}
          {lab.memory!.dismissed!.map((d, i) => (
            <span key={d}>
              {i > 0 && ', '}
              {d}{' '}
              <IconButton
                size="sm"
                disabled={off}
                label={`Let scans find “${d}” again`}
                onClick={() =>
                  void call<DeskMemory>('fixtures/undismiss', { label: d }, (m) => {
                    lab.setMemory(m);
                    lab.setMessage(`Scans will find things named like “${d}” again.`);
                  })
                }
              >
                ✕
              </IconButton>
            </span>
          ))}
        </p>
      )}
      {mapped && mapped.length > 0 && (
        <ul className="scan-list">
          {mapped.map((m, i) => (
            <li key={`${m.label}-${i}`}>
              <strong>{m.label}</strong>
              <span className={`tiny scan-${m.match}`}>{MATCH_LABEL[m.match].toUpperCase()}</span>
              <small>{m.note}</small>
            </li>
          ))}
        </ul>
      )}
    </Details>
  );
}

/**
 * Add a fixture, photo first: one picture of the thing is drafted into a
 * model, then the person names it, says what it is and puts it down.
 */
export function NewFixturePanel() {
  const lab = useLab();
  const { mode, busy, placing } = lab;
  const scenes = useScenes();
  const [draft, setDraft] = useState<{
    draft: FixtureDraft;
    scene: WorkScene;
    template?: StarterTemplate;
    colors?: [string, string];
  } | null>(null);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<ControlKind>('none');
  const [entity, setEntity] = useState('');
  const [scene, setScene] = useState<WorkScene | null>(lab.workScene && pinScene(lab.workScene));
  const [pending, setPending] = useState(false);
  /** What the person says it is, before drafting; Spark is told. */
  const [hint, setHint] = useState('');
  const target = scene && scenes.some((s) => s.id === scene) ? scene : (scenes[0]?.id ?? null);

  function startFromTemplate(template: StarterTemplate, customColors?: [string, string]) {
    if (!target) return;
    const meta = starterMeta(template);
    const colors: [string, string] = customColors ?? meta.colors;
    const d = starterFixtureDraft(template, {
      ...(label.trim() && draft?.template === template ? { label: label.trim() } : {}),
      colors,
    });
    setDraft({ draft: d, scene: target, template, colors });
    if (!customColors) {
      setLabel(d.label);
      const suggested = lab.entities.find((e) => e.startsWith(`${d.suggested}.`));
      setKind(d.suggested !== 'none' && suggested ? d.suggested : 'none');
      setEntity(d.suggested !== 'none' ? (suggested ?? '') : '');
      lab.setMessage(
        `Started a ${d.label.toLowerCase()} from the template. Name it, pick its colours, then place it.`,
      );
    }
  }

  async function draftFrom(
    source: { reference: DemoReference } | { file: File } | { box: ZoneRect },
  ) {
    if (!target) return;
    setPending(true);
    lab.setError('');
    try {
      const from =
        'file' in source
          ? { imageDataUrl: await photoDataUrl(source.file) }
          : 'box' in source
            ? {
                box: thousandths(source.box),
                ...(mode === 'live' ? { imageDataUrl: lab.image } : {}),
              }
            : source;
      const r = await api<{ run: EvidenceRun; draft: FixtureDraft }>('fixtures/draft', {
        mode,
        scene: target,
        ...from,
        ...(hint.trim() ? { label: hint.trim() } : {}),
      });
      setDraft({ draft: r.draft, scene: target });
      lab.setBoxing(null);
      setLabel(r.draft.label);
      const suggested = lab.entities.find((e) => e.startsWith(`${r.draft.suggested}.`));
      setKind(r.draft.suggested !== 'none' && suggested ? r.draft.suggested : 'none');
      setEntity(r.draft.suggested !== 'none' ? (suggested ?? '') : '');
      lab.setSelected(r.run);
      lab.setMessage(
        `Drafted the ${r.draft.label.toLowerCase()}. Name it, say what it is, then place it.`,
      );
      void lab.refresh().catch(() => {});
    } catch (e) {
      lab.setError(e instanceof Error ? e : 'The draft failed.');
    } finally {
      setPending(false);
    }
  }

  if (placing && !placing.id)
    return (
      <Panel
        tiny="ADD A FIXTURE"
        title={placing.label}
        status="Click where it stands in the room: on a surface or the floor."
        tone="seen"
      >
        <div className="save-actions">
          <Button
            onClick={() =>
              lab.setPlacing({
                ...placing,
                turns: ((placing.turns + 1) % 4) as FixturePlacing['turns'],
              })
            }
          >
            Turn ↻
          </Button>
          <Button onClick={() => lab.setPlacing(null)}>Cancel</Button>
        </div>
      </Panel>
    );

  if (!draft && lab.boxing) {
    const rect = lab.boxing.rect;
    const big = Boolean(rect && rect.width > 0.02 && rect.height > 0.02);
    return (
      <Panel
        tiny="ADD A FIXTURE"
        title="Box it on the desk photo"
        status={
          mode === 'live'
            ? 'Drag a box around the thing; Spark names it and SAM outlines it.'
            : 'Drag a box around the mug, the book or the bottle in the demo office.'
        }
        tone="seen"
      >
        <div className="save-actions">
          <Button
            variant="primary"
            disabled={!big || pending || Boolean(busy) || !target}
            onClick={() => rect && void draftFrom({ box: rect })}
          >
            {pending ? 'Drafting…' : 'Draft from the box'}
          </Button>
          <Button onClick={() => lab.setBoxing(null)}>Cancel</Button>
        </div>
      </Panel>
    );
  }

  if (!draft) {
    const live = mode === 'live';
    const off = pending || Boolean(busy) || !target;
    return (
      <Panel
        tiny="ADD A FIXTURE"
        title="Start from a photo of the thing"
        status="One thing filling the frame, on a plain background: a mouse, a lamp, a switch."
        tone="seen"
      >
        <div className="fixture-drop" aria-disabled={!live}>
          <div className="save-actions">
            <PhotoButton
              variant="primary"
              capture
              disabled={!live || off}
              onFile={(file) => void draftFrom({ file })}
            >
              {pending && live ? 'Drafting…' : 'Take a photo'}
            </PhotoButton>
            <PhotoButton
              variant="secondary"
              disabled={!live || off}
              onFile={(file) => void draftFrom({ file })}
            >
              Upload
            </PhotoButton>
          </div>
          {live && (
            <Field label="What is it? (optional)">
              <input
                id="fixture-hint"
                value={hint}
                maxLength={40}
                placeholder="desk lamp"
                onChange={(e) => setHint(e.target.value)}
              />
            </Field>
          )}
          <p className="micro">
            {live
              ? 'Spark names it and SAM outlines it: up to 5 billed calls. Only this photo is sent.'
              : 'Demo drafts from the pictures below, no model calls. Switch to Live for your own.'}
          </p>
        </div>
        <Button
          variant="text"
          disabled={off || (live && !lab.image)}
          title={live && !lab.image ? 'Add a desk photo first.' : undefined}
          onClick={() => lab.startBoxing()}
        >
          Or box it on the desk photo →
        </Button>
        <ScanFixtures initial={target} />
        <Details summary="Start from a template" open>
          <p className="micro">
            Start directly from an archetype with pre-built states and poses — no photo needed.
          </p>
          <div className="starter-catalog" role="list" aria-label="Fixture starter templates">
            {STARTER_TEMPLATES.map((t) => {
              const meta = starterMeta(t);
              const preview = itemSprite(starterFixtureDraft(t).model, {
                scale: 1.8,
                resolution: 32,
              });
              return (
                <button
                  key={t}
                  role="listitem"
                  className="starter-card"
                  disabled={off}
                  onClick={() => startFromTemplate(t)}
                >
                  <img src={preview.url} alt="" />
                  <strong>{meta.label}</strong>
                  <small>
                    {meta.sizeCm.w}×{meta.sizeCm.d}×{meta.sizeCm.h} cm
                  </small>
                </button>
              );
            })}
          </div>
        </Details>
        {!live && (
          <div className="object-grid">
            {DEMO_REFERENCES.map((r) => (
              <button
                key={r}
                className="object-card fixture-reference"
                disabled={off}
                onClick={() => void draftFrom({ reference: r })}
              >
                <img src={`/${r}.svg`} alt="" />
                <strong>{REFERENCE_LABEL[r]}</strong>
                <small>{pending ? 'Drafting…' : 'Draft from this picture'}</small>
              </button>
            ))}
          </div>
        )}
      </Panel>
    );
  }

  const { draft: d } = draft;
  const fit = d.model.fit;
  const size = d.size;
  const ready = Boolean(label.trim() && target && (kind === 'none' || entity));
  return (
    <Panel
      tiny="REVIEW THE FIXTURE"
      title={label.trim() || d.label}
      status={d.description}
      tone="seen"
    >
      <div className="fixture-compare">
        {d.reference && (
          <img
            src={`/api/fixtures/reference?runId=${d.reference.runId}`}
            alt={`The reference photo of the ${d.label.toLowerCase()}`}
          />
        )}
        <ModelPreview model={d.model} />
      </div>
      {draft.template && draft.colors && (
        <div className="save-actions" aria-label="Template colours">
          <label className="item-slider">
            <span className="tiny">MAIN</span>
            <input
              type="color"
              aria-label="Template primary colour"
              value={draft.colors[0]}
              onChange={(e) =>
                startFromTemplate(draft.template!, [e.target.value.toLowerCase(), draft.colors![1]])
              }
            />
          </label>
          <label className="item-slider">
            <span className="tiny">ACCENT</span>
            <input
              type="color"
              aria-label="Template accent colour"
              value={draft.colors[1]}
              onChange={(e) =>
                startFromTemplate(draft.template!, [draft.colors![0], e.target.value.toLowerCase()])
              }
            />
          </label>
        </div>
      )}
      {fit && (
        <p className="micro">
          Outline match {Math.round(fit.iou * 100)}% · {d.model.parts.length} part
          {d.model.parts.length === 1 ? '' : 's'} · drawn as a {d.archetype}
        </p>
      )}
      <Field label="Name">
        <input
          id="fixture-name"
          value={label}
          maxLength={40}
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
      <span className="tiny">What is it?</span>
      <ControlPicker kind={kind} entity={entity} onKind={setKind} onEntity={setEntity} />
      <p className="micro">
        {d.suggested === 'none'
          ? 'Looks like just a thing: nothing to switch.'
          : `Looks like a ${d.suggested}.`}
      </p>
      {scenes.length > 1 && (
        <Field label="Room">
          <Select
            id="fixture-scene"
            value={target ?? ''}
            onChange={(id) => setScene(id as WorkScene)}
            options={scenes.map((s) => ({ value: s.id, label: s.label }))}
          />
        </Field>
      )}
      <div className="save-actions">
        <Button
          variant="primary"
          disabled={!ready}
          onClick={() =>
            lab.startPlacing({
              label: label.trim(),
              scene: target!,
              turns: 0,
              size,
              model: { label: label.trim(), parts: d.model.parts },
              reference: d.reference,
              control: controlOf(kind, entity),
              ...(d.states
                ? {
                    states: Object.fromEntries(
                      Object.entries(d.states).map(([k, v]) => [
                        k,
                        {
                          model: { label: label.trim(), parts: v.model.parts },
                          ...(v.size ? { size: v.size } : {}),
                          ...(v.reference !== undefined ? { reference: v.reference } : {}),
                        },
                      ]),
                    ),
                  }
                : {}),
            })
          }
        >
          Place it
          <Glyph type="arrow" />
        </Button>
        <Button onClick={() => setDraft(null)}>Start over</Button>
      </div>
    </Panel>
  );
}

/** What a saved fixture sends back to be saved again. */
function inputOf(f: Fixture): FixtureInput & FixturePlacing {
  return fixtureInput(f);
}

/** A placed fixture: switch it, move or turn it, change what it is, or remove it. */
export function FixturePanel({ id }: { id: string }) {
  const lab = useLab();
  const { memory, mode, placing } = lab;
  const { call, off } = useCall();
  const f = memory?.fixtures?.find((x) => x.id === id);
  const [kind, setKind] = useState<ControlKind>(f?.control.kind ?? 'none');
  const [entity, setEntity] = useState(f ? (fixtureEntity(f) ?? '') : '');
  const [result, setResult] = useState<LampResult | null>(null);
  const [newState, setNewState] = useState('');
  const activeSize = f ? fixtureSize(f) : { w: 1, d: 1, h: 1 };
  const [size, setSize] = useState(activeSize);
  const [lastStateKey, setLastStateKey] = useState(
    `${f?.id ?? ''}:${f?.state ?? ''}:${activeSize.w},${activeSize.d},${activeSize.h}`,
  );
  const stateKey = `${f?.id ?? ''}:${f?.state ?? ''}:${activeSize.w},${activeSize.d},${activeSize.h}`;
  if (stateKey !== lastStateKey) {
    setLastStateKey(stateKey);
    setSize(activeSize);
  }
  if (!f)
    return <Panel tiny="FIXTURE" title="Gone" status="This fixture is no longer in the room." />;
  const scene = f.scene === 'custom' ? memory?.scene : ISO_PRESETS[f.scene];
  const byScan = Boolean(f.scanned || f.model.source === 'placeholder');
  const resized = size.w !== activeSize.w || size.d !== activeSize.d || size.h !== activeSize.h;
  const entityId = fixtureEntity(f);
  const stateNames = fixtureStateNames(f);
  const where = `${f.scene === 'custom' ? roomLabel('custom', memory) : ISO_PRESETS[f.scene].label}${f.surfaceId ? '' : ', on the floor'}`;
  const liveBlocked = mode === 'live' && !lab.lampReady;
  const save = (next: FixtureInput, done: string) =>
    void call<DeskMemory>('fixtures/save', { fixture: next }, (m) => {
      lab.setMemory(m);
      lab.setMessage(done);
    });
  const setFixtureState = (
    payload: {
      state?: string | null;
      fixture?: NonNullable<FixtureInput['states']>[string];
      remove?: string;
    },
    done: string,
  ) =>
    void call<DeskMemory>('fixtures/state', { fixtureId: f.id, ...payload }, (m) => {
      lab.setMemory(m);
      lab.setMessage(done);
    });
  const control = (action: 'on' | 'off') =>
    void call<{ memory: DeskMemory; event: EvidenceRun<LampResult> | null }>(
      'fixtures/control',
      { fixtureId: f.id, action },
      (r) => {
        lab.setMemory(r.memory, false);
        if (r.event) {
          lab.setSelected(r.event);
          setResult(r.event.output);
          lab.setMessage(r.event.output.explanation);
        } else {
          lab.setMessage(`Set the ${f.label.toLowerCase()} to ${action}.`);
        }
      },
    );
  const moving = placing?.id === f.id;
  const linked = linkedFixtures(memory?.fixtures ?? [], f);
  return (
    <Panel
      tiny="FIXTURE"
      title={f.label}
      status={
        moving
          ? 'Click where it stands now. Esc cancels.'
          : entityId
            ? `${controlLabel(f)} · ${entityId} · in the ${where.toLowerCase()}`
            : f.state
              ? `${controlLabel(f)} · in the ${where.toLowerCase()}`
              : `Just a thing, in the ${where.toLowerCase()}.`
      }
      tone={f.control.kind === 'light' && f.state === 'on' ? 'warm' : entityId ? 'ok' : 'idle'}
    >
      {entityId && (
        <>
          <div className="save-actions">
            <Button variant="primary" disabled={off || liveBlocked} onClick={() => control('on')}>
              Turn on
            </Button>
            <Button disabled={off || liveBlocked} onClick={() => control('off')}>
              Turn off
            </Button>
          </div>
          {liveBlocked && (
            <p className="micro">Set the HA_* variables and HA_LIVE_ENABLED to switch it.</p>
          )}
          {result && (
            <p className="micro">
              {result.accepted ? 'Accepted' : 'Not accepted'} ·{' '}
              {result.stateConfirmed ? `reported ${result.state}` : 'state not confirmed'}
            </p>
          )}
        </>
      )}
      {linked.length > 0 && (
        <p className="micro">
          Also in{' '}
          {linked.map((l, i) => (
            <span key={l.id}>
              {i > 0 && ', '}
              <Button variant="text" onClick={() => lab.select({ kind: 'fixture', id: l.id })}>
                {l.scene === 'custom' ? roomLabel('custom', memory) : ISO_PRESETS[l.scene].label}
              </Button>
            </span>
          ))}
          : its name, model and switch stay the same in each.
        </p>
      )}
      <div className="save-actions">
        <Button
          size="sm"
          disabled={off}
          onClick={() => (moving ? lab.setPlacing(null) : lab.startPlacing(inputOf(f)))}
        >
          {moving ? 'Cancel move' : 'Move'}
        </Button>
        <Button
          size="sm"
          disabled={off || moving}
          onClick={() =>
            save(
              { ...inputOf(f), turns: ((f.turns + 1) % 4) as FixtureInput['turns'] },
              `Turned the ${f.label.toLowerCase()}.`,
            )
          }
        >
          Turn ↻
        </Button>
        <Button size="sm" disabled={off || moving} onClick={() => lab.openModel(f.id)}>
          {f.state ? `Edit “${f.state}” model` : 'Edit model'}
        </Button>
      </div>
      <Details summary="States" open={stateNames.length > 0}>
        {stateNames.length > 0 && (
          <div className="save-actions">
            {stateNames.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={f.state === s ? 'primary' : 'secondary'}
                disabled={off || moving}
                onClick={() => {
                  if (entityId && (s === 'on' || s === 'off') && !liveBlocked) control(s);
                  else
                    setFixtureState(
                      { state: f.state === s && !f.states?.[s] ? null : s },
                      `Set the ${f.label.toLowerCase()} to ${s}.`,
                    );
                }}
              >
                {s}
              </Button>
            ))}
            {f.state && f.states?.[f.state] && (
              <Button
                size="sm"
                variant="text"
                disabled={off || moving}
                onClick={() =>
                  setFixtureState(
                    { remove: f.state! },
                    `Removed the “${f.state}” state from the ${f.label.toLowerCase()}.`,
                  )
                }
              >
                Remove “{f.state}”
              </Button>
            )}
          </div>
        )}
        <div className="save-actions">
          <input
            aria-label="New state"
            placeholder="e.g. on, off, idle, sleeping"
            value={newState}
            maxLength={24}
            onChange={(e) => setNewState(e.target.value)}
          />
          <Button
            size="sm"
            disabled={off || moving || !newState.trim()}
            onClick={() => {
              const name = newState.trim();
              setNewState('');
              setFixtureState(
                { state: name },
                `Added state “${name}” to the ${f.label.toLowerCase()}.`,
              );
            }}
          >
            Add state
          </Button>
        </div>
        <p className="micro">
          Each state can have its own model and size. Select a state, then click Edit model or
          adjust Size to customise it.
        </p>
      </Details>
      <FixturePhoto fixture={f} disabled={off || moving} />
      <SculptFixture fixture={f} disabled={off || moving} />
      <FixtureCamera fixture={f} disabled={off || moving} />
      <p className="micro fixture-placed">
        {byScan ? (
          <>Placed by a scan: rescans move it. Drag or move it to keep it where you put it.</>
        ) : (
          <>
            Placed by you: scans leave it here.{' '}
            <Button
              variant="text"
              disabled={off || moving}
              onClick={() =>
                void lab.updateFixture(
                  f.id,
                  { scanned: true },
                  `Scans place the ${f.label.toLowerCase()} again.`,
                )
              }
            >
              Let scans place it
            </Button>
          </>
        )}
      </p>
      {lab.inRoomViewOf(f) && (
        <p className="micro">
          {f.room ? (
            <>
              Placed by hand in the room; the office desk follows its camera.{' '}
              <Button
                variant="text"
                disabled={off || moving}
                onClick={() =>
                  void lab.updateFixture(
                    f.id,
                    { room: null },
                    `The room shows the ${f.label.toLowerCase()} where the desk’s camera puts it again.`,
                  )
                }
              >
                Put it where the desk shows it
              </Button>
            </>
          ) : (
            'Placed where the desk’s camera sees it. Moving it here gives the room its own place for it.'
          )}
        </p>
      )}
      {scene && (
        <Field label="Stands on">
          <Select
            id="fixture-surface"
            value={(lab.inRoomViewOf(f) && f.room ? f.room.surfaceId : f.surfaceId) ?? ''}
            disabled={off || moving}
            options={[
              { value: '', label: 'The floor' },
              ...scene.surfaces.map((s) => ({ value: s.id, label: s.label })),
            ]}
            onChange={(value) => {
              const surfaceId = value || null;
              const name = scene.surfaces.find((s) => s.id === surfaceId)?.label ?? 'the floor';
              void lab.updateFixture(
                f.id,
                { surfaceId },
                `The ${f.label.toLowerCase()} stands on ${surfaceId ? name.toLowerCase() : name} now.`,
              );
            }}
          />
        </Field>
      )}
      <Details summary="What it is">
        <ControlPicker kind={kind} entity={entity} onKind={setKind} onEntity={setEntity} />
        <Button
          disabled={off || (kind !== 'none' && !entity)}
          onClick={() =>
            save(
              {
                ...inputOf(f),
                control: controlOf(kind, entity),
                // What it switches says nothing about where it stands.
                ...(f.scanned ? { scanned: true } : {}),
              },
              `The ${f.label.toLowerCase()} is now ${kind === 'none' ? 'just a thing' : `a ${kind}`}.`,
            )
          }
        >
          Save
        </Button>
      </Details>
      <Details summary="Size">
        <div className="fixture-size">
          {(['w', 'd', 'h'] as const).map((k) => (
            <Field key={k} label={{ w: 'Width', d: 'Depth', h: 'Height' }[k]}>
              <input
                type="number"
                min={0.1}
                max={8}
                step={0.05}
                value={size[k]}
                onChange={(e) =>
                  setSize({
                    ...size,
                    [k]: Math.min(8, Math.max(0.1, Number(e.target.value) || 0.1)),
                  })
                }
              />
            </Field>
          ))}
        </div>
        <p className="micro">
          In tiles of this scene, about {tileCm()} cm each. The model is scaled to fit, centred
          where it stands.
        </p>
        <Button
          disabled={off || moving || !resized}
          onClick={() => {
            if (f.state) {
              const m = fixtureModel(f);
              setFixtureState(
                {
                  state: f.state,
                  fixture: { model: { label: m.label, parts: m.parts }, size },
                },
                `Resized the “${f.state}” state of the ${f.label.toLowerCase()}.`,
              );
            } else {
              void lab.updateFixture(f.id, { size }, `Resized the ${f.label.toLowerCase()}.`);
            }
          }}
        >
          Save size
        </Button>
      </Details>
      <Details summary="Delete">
        <div className="save-actions">
          <Button
            variant="danger"
            disabled={off}
            onClick={() =>
              void call<DeskMemory>('fixtures/delete', { fixtureId: f.id }, (m) => {
                lab.setMemory(m);
                lab.setMessage(`Removed the ${f.label.toLowerCase()}.`);
                lab.select(null);
              })
            }
          >
            Delete “{f.label}”
          </Button>
          <Button
            variant="danger"
            disabled={off}
            onClick={() =>
              void call<DeskMemory>('fixtures/delete', { fixtureId: f.id, dismiss: true }, (m) => {
                lab.setMemory(m);
                lab.setMessage(
                  `Removed the ${f.label.toLowerCase()}. Scans will skip things named like it.`,
                );
                lab.select(null);
              })
            }
          >
            Not a fixture
          </Button>
        </div>
        <p className="micro">“Not a fixture” also tells scans to skip it.</p>
      </Details>
    </Panel>
  );
}

/**
 * A lamp that is part of the room's layout: it stands for one light, which
 * can be switched from here. Which light is chosen in the layout editor.
 */
const TRACK_STATUS = {
  seen: 'where the camera last saw it',
  moved: 'moved where the camera saw it',
  missing: 'missing: the camera lost it, so it stands where it was last seen',
} as const;
/**
 * Following a fixture with the camera: SAM looks where it should stand, a
 * person confirms which outline it is, and from then on its place follows
 * what the camera sees and it can decide rules, like an object.
 */
function FixtureCamera({ fixture: f, disabled }: { fixture: Fixture; disabled: boolean }) {
  const lab = useLab();
  const { busy, segmentation, segmentRunId, now, watch } = lab;
  const found =
    segmentRunId && segmentation?.concept === f.label.trim().toLowerCase()
      ? segmentation.detections
      : [];
  const watched = watch?.on && watch.things.some((t) => t.id === f.id);
  return (
    <Details summary="In the camera" open={Boolean(f.track) || found.length > 0}>
      <p className="micro">
        {f.track
          ? `Followed: ${TRACK_STATUS[f.track.status]} · seen ${ago(f.track.observation.observedAt, now)}${watched ? ' · the server is watching it' : ''}.`
          : 'Not followed. Find it in the camera so it can follow and decide rules.'}
      </p>
      <div className="save-actions">
        <Button
          disabled={disabled || Boolean(busy)}
          onClick={() => void lab.findFixture(f.id)}
          title="Point SAM at where it should stand in the camera's view (one call)"
        >
          {busy === 'find-fixture' ? 'Looking…' : f.track ? 'Find it again' : 'Find in camera'}
        </Button>
        {f.track && (
          <Button variant="text" disabled={disabled} onClick={() => void lab.untrackFixture(f.id)}>
            Stop following
          </Button>
        )}
      </div>
      {found.map((d) => (
        <Button
          key={d.objectId}
          disabled={disabled || Boolean(busy)}
          onClick={() => void lab.anchorFixture(f.id, d.objectId)}
        >
          It’s outline #{d.objectId}
        </Button>
      ))}
    </Details>
  );
}

export function LampPanel({ id }: { id: string }) {
  const lab = useLab();
  const { call, off } = useCall();
  const [result, setResult] = useState<LampResult | null>(null);
  const lamp = builtInLamps(lab).find((l) => l.id === id);
  if (!lamp)
    return <Panel tiny="BUILT-IN LAMP" title="Gone" status="This lamp is no longer in the room." />;
  const on = lab.lightsOn.has(lamp.entity);
  const liveBlocked = lab.mode === 'live' && !lab.lampReady;
  const sceneLabel = roomLabel(lamp.scene, lab.memory);
  const control = (action: 'on' | 'off') =>
    void call<{ memory: DeskMemory; event: EvidenceRun<LampResult> }>(
      'fixtures/control',
      { entityId: lamp.entity, action },
      (r) => {
        lab.setMemory(r.memory, false);
        lab.setSelected(r.event);
        setResult(r.event.output);
        lab.setMessage(r.event.output.explanation);
      },
    );
  return (
    <Panel
      tiny="BUILT-IN LAMP"
      title={lamp.prop.label}
      status={
        lamp.entity
          ? `Part of the ${sceneLabel.toLowerCase()} layout · ${lamp.entity} · ${on ? 'on' : 'off'}`
          : 'Part of the layout, with no light set.'
      }
      tone={on ? 'warm' : 'idle'}
    >
      {lamp.entity && (
        <div className="save-actions">
          <Button variant="primary" disabled={off || liveBlocked} onClick={() => control('on')}>
            Turn on
          </Button>
          <Button disabled={off || liveBlocked} onClick={() => control('off')}>
            Turn off
          </Button>
        </div>
      )}
      {liveBlocked && (
        <p className="micro">Set the HA_* variables and HA_LIVE_ENABLED to switch it.</p>
      )}
      {result && (
        <p className="micro">
          {result.accepted ? 'Accepted' : 'Not accepted'} ·{' '}
          {result.stateConfirmed ? `reported ${result.state}` : 'state not confirmed'}
        </p>
      )}
      {lamp.scene === 'custom' ? (
        <Button variant="text" disabled={off} onClick={() => lab.editLayout()}>
          Choose its light in the layout →
        </Button>
      ) : (
        <p className="micro">
          A preset room’s lamps can’t be changed. Edit a layout of your own to choose another light.
        </p>
      )}
    </Panel>
  );
}

/** Under this many pixels across, a crop is too small to model a thing well. */
const SMALL_CROP_PX = 60;
/**
 * Another photo of a fixture, fitted and fused with its model: what to do
 * when the room's camera saw it too small. Says so when its crop was.
 */
function FixturePhoto({ fixture, disabled }: { fixture: Fixture; disabled: boolean }) {
  const lab = useLab();
  const { mode, busy } = lab;
  const fit = fixtureModel(fixture).fit;
  const small = fit?.cropPx && Math.max(fit.cropPx.width, fit.cropPx.height) < SMALL_CROP_PX;
  const off = disabled || Boolean(busy) || (mode === 'live' && !lab.metaReady);
  const add = (file: File) =>
    void photoDataUrl(file)
      .then((url) => lab.addFixturePhoto(fixture.id, url))
      .catch((e: unknown) => lab.setError(e instanceof Error ? e : 'Could not read the photo.'));
  return (
    <div className="fixture-photo">
      {small && (
        <p className="micro fixture-photo-small">
          Fitted from a crop {Math.max(fit.cropPx!.width, fit.cropPx!.height)} px across, too small
          to model well. A close photo of it will help.
        </p>
      )}
      <div className="row">
        {mode === 'live' ? (
          <>
            <PhotoButton
              variant={small ? 'primary' : 'secondary'}
              capture
              disabled={off}
              onFile={add}
            >
              {busy === 'fixture-photo' ? 'Fitting…' : 'Take a close photo'}
            </PhotoButton>
            <PhotoButton variant="ghost" disabled={off} onFile={add}>
              Upload
            </PhotoButton>
          </>
        ) : (
          <Button
            variant={small ? 'primary' : 'secondary'}
            disabled={off}
            onClick={() => void lab.addFixturePhoto(fixture.id)}
          >
            {busy === 'fixture-photo' ? 'Fitting…' : 'Add the demo’s close photo'}
          </Button>
        )}
      </div>
      <p className="micro">
        {fit
          ? `Fitted from ${fit.views} view${fit.views === 1 ? '' : 's'}. Another photo is fitted and fused with them, a closer one counting for more.`
          : 'A photo of it is fitted as a draft is, and becomes its model.'}
      </p>
    </div>
  );
}

/**
 * Model a fixture with AI: Spark rebuilds its model in our own parts from the
 * picture of it, starting from the model it has, and the editor opens on it.
 */
function SculptFixture({ fixture, disabled }: { fixture: Fixture; disabled: boolean }) {
  const lab = useLab();
  const { mode, busy, memory } = lab;
  const group = new Set([
    fixture.id,
    ...linkedFixtures(memory?.fixtures ?? [], fixture).map((x) => x.id),
  ]);
  const [note, setNote] = useState('');
  const lifted = memory?.illustration?.layers?.sprites.some((x) => group.has(x.fixtureId));
  // As the server finds a picture: its cut-out, its fitted crop, else the scan's crop of it
  // seen through the calibrated camera.
  const scanned =
    Boolean(fixtureReference(fixture)) &&
    fixture.scene === 'custom' &&
    Boolean(memory?.scene) &&
    Boolean(memory && calibrationOf(memory));
  const pictured =
    lifted || Boolean(fixtureModel(fixture).fit?.crop ?? fixture.model.fit?.crop) || scanned;
  const why =
    mode !== 'live'
      ? 'Modelling with AI asks Spark, so it runs in Live mode.'
      : !lab.metaReady
        ? 'Live calls aren’t available: set MODEL_API_KEY and META_LIVE_ENABLED, or raise today’s spend limit.'
        : !pictured
          ? 'Lift the fixtures off the room’s picture, or draft it from a photo, first.'
          : null;
  const off = disabled || Boolean(busy) || Boolean(why);
  const go = () => void lab.sculptFixture(fixture.id, note.trim() || undefined);
  return (
    <div className="sculpt-fixture">
      <form
        className="brush-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          if (!off) go();
        }}
      >
        <textarea
          aria-label={`What to know about the ${fixture.label.toLowerCase()} before modelling it`}
          rows={2}
          maxLength={300}
          value={note}
          disabled={off}
          placeholder="Optional: “it’s a Dyson Pure Cool tower fan”, “give it a round base”"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!off) go();
            }
          }}
        />
        <Button type="submit" disabled={off}>
          {busy === 'sculpt' ? 'Modelling…' : 'Model with AI'}
        </Button>
      </form>
      <p className="micro">
        {why ??
          `Spark rebuilds its model in editable parts from its ${lifted ? 'cut-out' : 'photo'}, keeping locked parts${note.trim() ? ', and looks up what you name first (catalog, then the web)' : ''} · ${note.trim() ? '3' : '2'} Spark calls, ~$0.05–${note.trim() ? '0.15' : '0.10'}, a minute or two.`}
      </p>
    </div>
  );
}
