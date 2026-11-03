import { useState, type ReactNode } from 'react';
import {
  MAX_ZONE_DEPTH,
  MAX_ZONE_REPEAT,
  MAX_ZONE_STEPS,
  MAX_ZONE_WAIT_S,
  countSteps,
  hexRgb,
  rgbHex,
  stepEntities,
  stepThings,
  type LightLook,
  type ZoneActions,
  type ZoneCondition,
  type ZoneStep,
} from '@livinglayer/domain';
import { Button, IconButton, NumberInput, Segmented, Select } from '../ui/controls';
import './zone-actions.css';

/** A thing the zone counts, for an `if` that asks about it. */
export type ZoneThing = { id: string; label: string };

/**
 * How a light looks when its zone turns it on: its own colour and brightness
 * (Home Assistant restores them), warm white, or a colour, at a brightness.
 */
function LookPicker({
  value,
  onChange,
  disabled,
}: {
  value: LightLook | undefined;
  onChange: (look: LightLook) => void;
  disabled?: boolean;
}) {
  const look = value ?? { kind: 'keep' };
  const brightness = look.kind === 'keep' ? 80 : look.brightness;
  const rgb = look.kind === 'color' ? look.rgb : ([255, 120, 40] as [number, number, number]);
  return (
    <div className="look-picker">
      <Select
        aria-label="Light look"
        value={look.kind}
        disabled={disabled}
        onChange={(kind) =>
          onChange(
            kind === 'keep'
              ? { kind }
              : kind === 'warm'
                ? { kind, brightness }
                : { kind, rgb, brightness },
          )
        }
        options={[
          { value: 'keep', label: 'in its own colour' },
          { value: 'warm', label: 'in warm white' },
          { value: 'color', label: 'in a colour' },
        ]}
      />
      {look.kind === 'color' && (
        <input
          type="color"
          aria-label="Light colour"
          disabled={disabled}
          value={rgbHex(look.rgb)}
          onChange={(e) => onChange({ ...look, rgb: hexRgb(e.target.value) })}
        />
      )}
      {look.kind !== 'keep' && (
        <label className="look-brightness">
          <input
            type="range"
            min={1}
            max={100}
            aria-label="Light brightness"
            disabled={disabled}
            value={look.brightness}
            onChange={(e) => onChange({ ...look, brightness: Number(e.target.value) })}
          />
          <output>{look.brightness}%</output>
        </label>
      )}
    </div>
  );
}

/** Why steps can't be saved yet, or null: a switch with no device, or a question about a thing not watched. */
export function actionsProblem(actions: ZoneActions, watches: 'any' | string[]): string | null {
  const all = [...actions.onEnter, ...actions.onLeave];
  if (stepEntities(all).includes('')) return 'Choose a device for each switch step.';
  if (watches !== 'any' && stepThings(all).some((id) => !watches.includes(id)))
    return 'A step asks about a thing this zone doesn’t watch.';
  return null;
}

/** What every step list in one editor shares. */
interface Ctx {
  entities: string[];
  things: ZoneThing[];
  disabled: boolean;
  /** Steps left before the zone's limit. */
  room: number;
}

const KIND_LABEL: Record<ZoneStep['kind'], string> = {
  switch: 'Switch',
  wait: 'Wait',
  if: 'If',
  repeat: 'Repeat',
};
const KIND_MARK: Record<ZoneStep['kind'], string> = {
  switch: '⏻',
  wait: '◷',
  if: '⑂',
  repeat: '↻',
};

function newStep(kind: ZoneStep['kind'], ctx: Ctx): ZoneStep {
  switch (kind) {
    case 'switch':
      return { kind, entityId: ctx.entities[0] ?? '', to: 'on' };
    case 'wait':
      return { kind, seconds: 60 };
    case 'if':
      return { kind, condition: { kind: 'occupied', is: true }, then: [], else: [] };
    case 'repeat':
      return { kind, times: 2, steps: [] };
  }
}

/** The editor: what happens as something enters, and as the zone empties. */
export function ZoneActionsEditor({
  value,
  onChange,
  entities,
  things,
  disabled = false,
  who = 'something',
}: {
  value: ZoneActions;
  onChange: (next: ZoneActions) => void;
  entities: string[];
  things: ZoneThing[];
  disabled?: boolean;
  /** What enters, in words: "the mug", "anything". */
  who?: string;
}) {
  const used = countSteps(value.onEnter) + countSteps(value.onLeave);
  const ctx: Ctx = { entities, things, disabled, room: MAX_ZONE_STEPS - used };
  return (
    <div className="zone-actions">
      <Trigger
        mark="→"
        title={`When ${who} enters`}
        hint="Runs once each time the zone fills."
        steps={value.onEnter}
        onChange={(onEnter) => onChange({ ...value, onEnter })}
        ctx={ctx}
      />
      <Trigger
        mark="←"
        title="When it empties"
        hint="Runs once as the last thing leaves."
        steps={value.onLeave}
        onChange={(onLeave) => onChange({ ...value, onLeave })}
        ctx={ctx}
      />
      <p className="micro">
        A new trigger stops steps still running from the last one. {used}/{MAX_ZONE_STEPS} steps.
      </p>
    </div>
  );
}

function Trigger({
  mark,
  title,
  hint,
  steps,
  onChange,
  ctx,
}: {
  mark: string;
  title: string;
  hint: string;
  steps: ZoneStep[];
  onChange: (steps: ZoneStep[]) => void;
  ctx: Ctx;
}) {
  return (
    <section className="za-trigger" aria-label={title}>
      <header>
        <span className="za-trigger-mark" aria-hidden="true">
          {mark}
        </span>
        <strong>{title}</strong>
        <span className="micro">{steps.length ? hint : 'Nothing happens.'}</span>
      </header>
      <StepList steps={steps} onChange={onChange} ctx={ctx} depth={1} />
    </section>
  );
}

function StepList({
  steps,
  onChange,
  ctx,
  depth,
}: {
  steps: ZoneStep[];
  onChange: (steps: ZoneStep[]) => void;
  ctx: Ctx;
  /** 1 for a trigger's own steps, 2 inside an `if` or `repeat`, … */
  depth: number;
}) {
  const set = (i: number, step: ZoneStep) => onChange(steps.map((s, j) => (j === i ? step : s)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="za-list">
      {steps.map((s, i) => (
        <StepCard
          // Steps have no ids; the index is their place, which moving changes on purpose.
          key={`${i}-${s.kind}`}
          step={s}
          ctx={ctx}
          depth={depth}
          onChange={(next) => set(i, next)}
          onMove={(by) => move(i, by)}
          canUp={i > 0}
          canDown={i < steps.length - 1}
          onRemove={() => onChange(steps.filter((_, j) => j !== i))}
        />
      ))}
      <AddStep
        ctx={ctx}
        nests={depth < MAX_ZONE_DEPTH}
        onAdd={(kind) => onChange([...steps, newStep(kind, ctx)])}
      />
    </div>
  );
}

function AddStep({
  ctx,
  nests,
  onAdd,
}: {
  ctx: Ctx;
  /** Whether `if` and `repeat` may go here. */
  nests: boolean;
  onAdd: (kind: ZoneStep['kind']) => void;
}) {
  const [open, setOpen] = useState(false);
  const full = ctx.room <= 0;
  if (!open)
    return (
      <Button
        variant="ghost"
        size="sm"
        className="za-add"
        disabled={ctx.disabled || full}
        title={full ? `A zone keeps up to ${MAX_ZONE_STEPS} steps.` : undefined}
        onClick={() => setOpen(true)}
      >
        + Add step
      </Button>
    );
  const kinds: { kind: ZoneStep['kind']; hint: string; off?: string }[] = [
    {
      kind: 'switch',
      hint: 'Turn a light or switch on or off',
      ...(ctx.entities.length ? {} : { off: 'No devices to switch yet.' }),
    },
    { kind: 'wait', hint: 'Pause before the next step' },
    {
      kind: 'if',
      hint: 'Do one thing or another',
      ...(nests ? {} : { off: 'Steps nest only so deep.' }),
    },
    {
      kind: 'repeat',
      hint: 'Do some steps a few times',
      ...(nests ? {} : { off: 'Steps nest only so deep.' }),
    },
  ];
  return (
    <div className="za-menu" role="group" aria-label="Add a step">
      {kinds.map((k) => (
        <button
          key={k.kind}
          type="button"
          aria-label={KIND_LABEL[k.kind]}
          className="za-menu-item"
          disabled={Boolean(k.off)}
          title={k.off ?? k.hint}
          onClick={() => {
            onAdd(k.kind);
            setOpen(false);
          }}
        >
          <span className={`za-mark ${k.kind}`} aria-hidden="true">
            {KIND_MARK[k.kind]}
          </span>
          <span>
            <strong>{KIND_LABEL[k.kind]}</strong>
            <span className="micro">{k.off ?? k.hint}</span>
          </span>
        </button>
      ))}
      <Button variant="text" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}

function StepCard({
  step,
  ctx,
  depth,
  onChange,
  onMove,
  canUp,
  canDown,
  onRemove,
}: {
  step: ZoneStep;
  ctx: Ctx;
  depth: number;
  onChange: (step: ZoneStep) => void;
  onMove: (by: -1 | 1) => void;
  canUp: boolean;
  canDown: boolean;
  onRemove: () => void;
}) {
  const { disabled } = ctx;
  return (
    <div className={`za-step ${step.kind}`}>
      <div className="za-step-head">
        <span className={`za-mark ${step.kind}`} aria-hidden="true">
          {KIND_MARK[step.kind]}
        </span>
        <span className="za-kind">{KIND_LABEL[step.kind]}</span>
        <span className="za-step-tools">
          <IconButton
            size="sm"
            label="Move up"
            disabled={disabled || !canUp}
            onClick={() => onMove(-1)}
          >
            ↑
          </IconButton>
          <IconButton
            size="sm"
            label="Move down"
            disabled={disabled || !canDown}
            onClick={() => onMove(1)}
          >
            ↓
          </IconButton>
          <IconButton size="sm" label="Remove step" disabled={disabled} onClick={onRemove}>
            ×
          </IconButton>
        </span>
      </div>
      <div className="za-step-body">
        <StepFields step={step} ctx={ctx} onChange={onChange} />
      </div>
      {step.kind === 'if' && (
        <>
          <Branch label="Then">
            <StepList
              steps={step.then}
              ctx={ctx}
              depth={depth + 1}
              onChange={(then) => onChange({ ...step, then })}
            />
          </Branch>
          <Branch label="Otherwise">
            <StepList
              steps={step.else}
              ctx={ctx}
              depth={depth + 1}
              onChange={(otherwise) => onChange({ ...step, else: otherwise })}
            />
          </Branch>
        </>
      )}
      {step.kind === 'repeat' && (
        <Branch label="Do">
          <StepList
            steps={step.steps}
            ctx={ctx}
            depth={depth + 1}
            onChange={(steps) => onChange({ ...step, steps })}
          />
        </Branch>
      )}
    </div>
  );
}

function Branch({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="za-branch">
      <span className="tiny">{label}</span>
      {children}
    </div>
  );
}

/** A wait's number and unit: whole minutes show as minutes. */
const waitParts = (seconds: number) =>
  seconds >= 60 && seconds % 60 === 0
    ? { n: seconds / 60, unit: 'min' as const }
    : { n: seconds, unit: 's' as const };

function StepFields({
  step,
  ctx,
  onChange,
}: {
  step: ZoneStep;
  ctx: Ctx;
  onChange: (step: ZoneStep) => void;
}) {
  const { disabled } = ctx;
  switch (step.kind) {
    case 'switch': {
      const known = ctx.entities.includes(step.entityId);
      return (
        <>
          <div className="za-row">
            <Segmented
              label="Turn on or off"
              disabled={disabled}
              value={step.to}
              onChange={(to) =>
                onChange(
                  to === 'off' ? { kind: 'switch', entityId: step.entityId, to } : { ...step, to },
                )
              }
              options={[
                { value: 'on', label: 'Turn on' },
                { value: 'off', label: 'Turn off' },
              ]}
            />
            <Select
              aria-label="Device"
              disabled={disabled}
              value={step.entityId}
              onChange={(entityId) => {
                const { look: _, ...rest } = step;
                onChange(
                  entityId.startsWith('light.') ? { ...step, entityId } : { ...rest, entityId },
                );
              }}
              options={[
                ...(known
                  ? []
                  : [{ value: step.entityId, label: step.entityId || 'Choose a device' }]),
                ...ctx.entities.map((e) => ({ value: e, label: e })),
              ]}
            />
          </div>
          {step.to === 'on' && step.entityId.startsWith('light.') && (
            <LookPicker
              value={step.look}
              disabled={disabled}
              onChange={(look) =>
                onChange(
                  look.kind === 'keep'
                    ? { kind: 'switch', entityId: step.entityId, to: 'on' }
                    : { ...step, look },
                )
              }
            />
          )}
        </>
      );
    }
    case 'wait': {
      const { n, unit } = waitParts(step.seconds);
      const max = unit === 'min' ? MAX_ZONE_WAIT_S / 60 : MAX_ZONE_WAIT_S;
      return (
        <div className="za-row">
          <NumberInput
            aria-label="Wait for"
            className="za-num"
            disabled={disabled}
            min={1}
            max={max}
            value={n}
            onChange={(v) => onChange({ ...step, seconds: unit === 'min' ? v * 60 : v })}
          />
          <Select
            aria-label="Wait unit"
            disabled={disabled}
            value={unit}
            onChange={(u) =>
              onChange({
                ...step,
                seconds: u === 'min' ? Math.min(MAX_ZONE_WAIT_S, n * 60) : Math.min(59, n) || 1,
              })
            }
            options={[
              { value: 's', label: n === 1 ? 'second' : 'seconds' },
              { value: 'min', label: n === 1 ? 'minute' : 'minutes' },
            ]}
          />
        </div>
      );
    }
    case 'if':
      return (
        <ConditionFields
          condition={step.condition}
          ctx={ctx}
          onChange={(condition) => onChange({ ...step, condition })}
        />
      );
    case 'repeat':
      return (
        <div className="za-row">
          <NumberInput
            aria-label="Times"
            className="za-num"
            disabled={disabled}
            min={2}
            max={MAX_ZONE_REPEAT}
            value={step.times}
            onChange={(times) => onChange({ ...step, times })}
          />
          <span className="za-word">times</span>
        </div>
      );
  }
}

/** The questions an `if` can ask, as one choice: the zone, each thing it counts, or the time. */
function ConditionFields({
  condition: c,
  ctx,
  onChange,
}: {
  condition: ZoneCondition;
  ctx: Ctx;
  onChange: (c: ZoneCondition) => void;
}) {
  const value =
    c.kind === 'occupied'
      ? c.is
        ? 'occupied'
        : 'empty'
      : c.kind === 'inside'
        ? `${c.is ? 'in' : 'out'}:${c.thingId}`
        : 'time';
  const known = c.kind !== 'inside' || ctx.things.some((t) => t.id === c.thingId);
  return (
    <>
      <div className="za-row">
        <Select
          aria-label="Condition"
          disabled={ctx.disabled}
          value={value}
          onChange={(v) => {
            if (v === 'occupied' || v === 'empty')
              onChange({ kind: 'occupied', is: v === 'occupied' });
            else if (v === 'time') onChange({ kind: 'time', from: '22:00', to: '07:00' });
            else
              onChange({
                kind: 'inside',
                thingId: v.slice(v.indexOf(':') + 1),
                is: v.startsWith('in:'),
              });
          }}
          options={[
            { value: 'occupied', label: 'the zone is still occupied' },
            { value: 'empty', label: 'the zone is empty' },
            ...ctx.things.flatMap((t) => [
              { value: `in:${t.id}`, label: `the ${t.label} is inside` },
              { value: `out:${t.id}`, label: `the ${t.label} is not inside` },
            ]),
            ...(known ? [] : [{ value, label: 'a forgotten thing…' }]),
            { value: 'time', label: 'it is between…' },
          ]}
        />
      </div>
      {c.kind === 'time' && (
        <div className="za-row">
          <input
            type="time"
            aria-label="From"
            disabled={ctx.disabled}
            value={c.from}
            onChange={(e) => e.target.value && onChange({ ...c, from: e.target.value })}
          />
          <span className="za-word">and</span>
          <input
            type="time"
            aria-label="To"
            disabled={ctx.disabled}
            value={c.to}
            onChange={(e) => e.target.value && onChange({ ...c, to: e.target.value })}
          />
        </div>
      )}
    </>
  );
}
