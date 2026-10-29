import { useRef, useState, type ReactNode } from 'react';
import {
  DEMO_REFERENCES,
  ISO_PRESETS,
  fixtureEntity,
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
  type ZoneRect,
} from '@livinglayer/domain';
import { api } from '../api';
import { Glyph } from '../Glyph';
import { itemSprite } from '../iso/sprites';
import type { FixturePlacing } from '../iso/IsoView';
import { useLab } from './LabContext';
import { builtInLamps, controlLabel, roomLabel } from './labels';
import { pinScene } from './progress';
import { Details, Panel, useCall } from './panel';
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
  className,
  capture,
  disabled,
  onFile,
  children,
}: {
  className: string;
  capture?: boolean;
  disabled: boolean;
  onFile: (file: File) => void;
  children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className={className} disabled={disabled} onClick={() => input.current?.click()}>
        {children}
      </button>
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

/**
 * Add a fixture, photo first: one picture of the thing is drafted into a
 * model, then the person names it, says what it is and puts it down.
 */
export function NewFixturePanel() {
  const lab = useLab();
  const { mode, busy, placing } = lab;
  const scenes = useScenes();
  const [draft, setDraft] = useState<{ draft: FixtureDraft; scene: WorkScene } | null>(null);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<ControlKind>('none');
  const [entity, setEntity] = useState('');
  const [scene, setScene] = useState<WorkScene | null>(lab.workScene && pinScene(lab.workScene));
  const [pending, setPending] = useState(false);
  /** What the person says it is, before drafting; Spark is told. */
  const [hint, setHint] = useState('');
  const target = scene && scenes.some((s) => s.id === scene) ? scene : (scenes[0]?.id ?? null);

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
          <button
            className="secondary"
            onClick={() =>
              lab.setPlacing({
                ...placing,
                turns: ((placing.turns + 1) % 4) as FixturePlacing['turns'],
              })
            }
          >
            Turn ↻
          </button>
          <button className="secondary" onClick={() => lab.setPlacing(null)}>
            Cancel
          </button>
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
            ? 'Drag a box around the thing. Spark sees only what is around the box; SAM outlines it.'
            : 'Drag a box around the mug, the book or the bottle on the illustrated desk.'
        }
        tone="seen"
      >
        <div className="save-actions">
          <button
            className="primary"
            disabled={!big || pending || Boolean(busy) || !target}
            onClick={() => rect && void draftFrom({ box: rect })}
          >
            {pending ? 'Drafting…' : 'Draft from the box'}
          </button>
          <button className="secondary" onClick={() => lab.setBoxing(null)}>
            Cancel
          </button>
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
        status="One thing, filling most of the frame, on a plain background. A mouse, a lamp, a wall switch."
        tone="seen"
      >
        <div className="fixture-drop" aria-disabled={!live}>
          <div className="save-actions">
            <PhotoButton
              className="primary"
              capture
              disabled={!live || off}
              onFile={(file) => void draftFrom({ file })}
            >
              {pending && live ? 'Drafting…' : 'Take a photo'}
            </PhotoButton>
            <PhotoButton
              className="secondary"
              disabled={!live || off}
              onFile={(file) => void draftFrom({ file })}
            >
              Upload
            </PhotoButton>
          </div>
          {live && (
            <>
              <label className="input-label" htmlFor="fixture-hint">
                What is it? (optional)
              </label>
              <input
                id="fixture-hint"
                value={hint}
                maxLength={40}
                placeholder="desk lamp"
                onChange={(e) => setHint(e.target.value)}
              />
            </>
          )}
          <p className="micro">
            {live
              ? 'Spark names it and SAM outlines it: up to five billed calls, refused up front if today’s limit can’t cover them. Only this photo is sent.'
              : 'Demo mode drafts from the bundled pictures below, with no model call. Switch to Live to use your own photo.'}
          </p>
        </div>
        <button
          className="text-button"
          disabled={off || (live && !lab.image)}
          title={live && !lab.image ? 'Add a desk photo first.' : undefined}
          onClick={() => lab.startBoxing()}
        >
          Or box it on the desk photo →
        </button>
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
  // A draft is sized for the scene it was made for; another scene has another scale.
  const k = target ? tileCm(draft.scene, lab.memory?.scene) / tileCm(target, lab.memory?.scene) : 1;
  const size = { w: d.size.w * k, d: d.size.d * k, h: d.size.h * k };
  const ready = Boolean(label.trim() && target && (kind === 'none' || entity));
  return (
    <Panel
      tiny="REVIEW THE FIXTURE"
      title={label.trim() || d.label}
      status={d.description}
      tone="seen"
    >
      <div className="fixture-compare">
        <img
          src={`/api/fixtures/reference?runId=${d.reference.runId}`}
          alt={`The reference photo of the ${d.label.toLowerCase()}`}
        />
        <ModelPreview model={d.model} />
      </div>
      {fit && (
        <p className="micro">
          Outline match {Math.round(fit.iou * 100)}% · {d.model.parts.length} part
          {d.model.parts.length === 1 ? '' : 's'} · drawn as a {d.archetype}
        </p>
      )}
      <label className="input-label" htmlFor="fixture-name">
        Name
      </label>
      <input
        id="fixture-name"
        value={label}
        maxLength={40}
        onChange={(e) => setLabel(e.target.value)}
      />
      <span className="input-label">What is it?</span>
      <ControlPicker kind={kind} entity={entity} onKind={setKind} onEntity={setEntity} />
      <p className="micro">
        {d.suggested === 'none'
          ? 'Looks like just a thing: nothing to switch.'
          : `Looks like a ${d.suggested}.`}
      </p>
      {scenes.length > 1 && (
        <>
          <label className="input-label" htmlFor="fixture-scene">
            Room
          </label>
          <select
            id="fixture-scene"
            value={target ?? ''}
            onChange={(e) => setScene(e.target.value as WorkScene)}
          >
            {scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="save-actions">
        <button
          className="primary"
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
            })
          }
        >
          Place it
          <Glyph type="arrow" />
        </button>
        <button className="secondary" onClick={() => setDraft(null)}>
          Start over
        </button>
      </div>
    </Panel>
  );
}

/** What a saved fixture sends back to be saved again. */
function inputOf(f: Fixture): FixtureInput & FixturePlacing {
  return {
    id: f.id,
    label: f.label,
    scene: f.scene,
    surfaceId: f.surfaceId,
    at: f.at,
    turns: f.turns,
    size: f.size,
    model: { label: f.model.label, parts: f.model.parts },
    reference: f.reference,
    control: f.control,
  };
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
  if (!f)
    return <Panel tiny="FIXTURE" title="Gone" status="This fixture is no longer in the room." />;
  const entityId = fixtureEntity(f);
  const where = `${f.scene === 'custom' ? roomLabel('custom', memory) : ISO_PRESETS[f.scene].label}${f.surfaceId ? '' : ', on the floor'}`;
  const liveBlocked = mode === 'live' && !lab.lampReady;
  const save = (next: FixtureInput, done: string) =>
    void call<DeskMemory>('fixtures/save', { fixture: next }, (m) => {
      lab.setMemory(m);
      lab.setMessage(done);
    });
  const control = (action: 'on' | 'off') =>
    void call<{ memory: DeskMemory; event: EvidenceRun<LampResult> }>(
      'fixtures/control',
      { fixtureId: f.id, action },
      (r) => {
        lab.setMemory(r.memory, false);
        lab.setSelected(r.event);
        setResult(r.event.output);
        lab.setMessage(r.event.output.explanation);
      },
    );
  const moving = placing?.id === f.id;
  return (
    <Panel
      tiny="FIXTURE"
      title={f.label}
      status={
        moving
          ? 'Click where it stands now. Esc cancels.'
          : entityId
            ? `${controlLabel(f)} · ${entityId} · in the ${where.toLowerCase()}`
            : `Just a thing, in the ${where.toLowerCase()}.`
      }
      tone={f.control.kind === 'light' && f.state === 'on' ? 'warm' : entityId ? 'ok' : 'idle'}
    >
      {entityId && (
        <>
          <div className="save-actions">
            <button className="primary" disabled={off || liveBlocked} onClick={() => control('on')}>
              Turn on
            </button>
            <button
              className="secondary"
              disabled={off || liveBlocked}
              onClick={() => control('off')}
            >
              Turn off
            </button>
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
      <div className="save-actions">
        <button
          className="secondary"
          disabled={off}
          onClick={() => (moving ? lab.setPlacing(null) : lab.startPlacing(inputOf(f)))}
        >
          {moving ? 'Cancel move' : 'Move'}
        </button>
        <button
          className="secondary"
          disabled={off || moving}
          onClick={() =>
            save(
              { ...inputOf(f), turns: ((f.turns + 1) % 4) as FixtureInput['turns'] },
              `Turned the ${f.label.toLowerCase()}.`,
            )
          }
        >
          Turn ↻
        </button>
        <button className="secondary" disabled={off || moving} onClick={() => lab.openModel(f.id)}>
          Edit model
        </button>
      </div>
      <Details summary="What it is">
        <ControlPicker kind={kind} entity={entity} onKind={setKind} onEntity={setEntity} />
        <button
          className="secondary"
          disabled={off || (kind !== 'none' && !entity)}
          onClick={() =>
            save(
              { ...inputOf(f), control: controlOf(kind, entity) },
              `The ${f.label.toLowerCase()} is now ${kind === 'none' ? 'just a thing' : `a ${kind}`}.`,
            )
          }
        >
          Save
        </button>
      </Details>
      <Details summary="Delete">
        <button
          className="text-button destructive"
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
        </button>
      </Details>
    </Panel>
  );
}

/**
 * A lamp that is part of the room's layout: it stands for one light, which
 * can be switched from here. Which light is chosen in the layout editor.
 */
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
          : 'Part of the layout, with no light configured to stand for.'
      }
      tone={on ? 'warm' : 'idle'}
    >
      {lamp.entity && (
        <div className="save-actions">
          <button className="primary" disabled={off || liveBlocked} onClick={() => control('on')}>
            Turn on
          </button>
          <button
            className="secondary"
            disabled={off || liveBlocked}
            onClick={() => control('off')}
          >
            Turn off
          </button>
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
        <button className="text-button" disabled={off} onClick={() => lab.editLayout()}>
          Choose its light in the layout →
        </button>
      ) : (
        <p className="micro">
          A preset room’s lamps can’t be changed. Edit a layout of your own to choose another light.
        </p>
      )}
    </Panel>
  );
}
