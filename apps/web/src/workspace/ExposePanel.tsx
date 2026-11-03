import { useState } from 'react';
import {
  keyFromName,
  exposedEntityId,
  sensorOptions,
  zonesIn,
  MAIN_ZONE,
  SOURCE_KINDS,
  type DeskMemory,
  type ExposedEntity,
  type ExposedInput,
  type ExposedState,
  type ExposeKind,
  type ExposeSource,
} from '@livinglayer/domain';
import { Button, Check } from '../ui/controls';
import {
  useDesk,
  useFeedback,
  useLabParts,
  useNavigation,
  useTracking,
  useView,
} from './LabContext';
import { Details, Panel, useCall, type Tone } from './panel';

/** A ready-made entity: what it is for, and how it starts. */
interface Preset {
  id: string;
  label: string;
  hint: string;
  needsZone?: boolean;
  needsThing?: boolean;
  make: (memory: DeskMemory, zone: string, thing: string) => Omit<ExposedInput, 'key'>;
}
const PRESETS: Preset[] = [
  {
    id: 'presence',
    label: 'Presence',
    hint: 'On while a zone looks different from how it looks empty, even with someone sitting still. Local and free: you show it the zone empty once.',
    needsZone: true,
    make: (_, zone) => ({
      name: 'Presence',
      kind: 'binary_sensor',
      deviceClass: 'occupancy',
      source: { kind: 'occupied', zoneId: zone, holdS: 30, samConfirm: false },
    }),
  },
  {
    id: 'motion',
    label: 'Motion',
    hint: 'On while something moves in a zone, off after 5 minutes of stillness. Free and quick, but it can’t tell someone sitting very still from an empty room.',
    needsZone: true,
    make: (_, zone) => ({
      name: 'Motion',
      kind: 'binary_sensor',
      deviceClass: 'motion',
      source: { kind: 'motion', zoneId: zone, holdS: 300 },
    }),
  },
  {
    id: 'in_zone',
    label: 'Object in a zone',
    hint: 'On while SAM last saw the zone’s object inside it.',
    needsZone: true,
    make: (memory, zone) => ({
      name: zoneLabel(memory, zone),
      kind: 'binary_sensor',
      deviceClass: 'occupancy',
      source: { kind: 'in_zone', zoneId: zone },
    }),
  },
  {
    id: 'zone_of',
    label: 'Where an object is',
    hint: 'Which of an object’s zones it is in, or none.',
    needsThing: true,
    make: (memory, _, thing) => ({
      name: `${thingLabel(memory, thing)} zone`,
      kind: 'sensor',
      source: { kind: 'zone_of', objectId: thing },
    }),
  },
  {
    id: 'missing',
    label: 'Missing',
    hint: 'On when the watcher can’t find a thing any more.',
    needsThing: true,
    make: (memory, _, thing) => ({
      name: `${thingLabel(memory, thing)} missing`,
      kind: 'binary_sensor',
      deviceClass: 'problem',
      source: { kind: 'status', thingId: thing },
    }),
  },
  {
    id: 'watching',
    label: 'Watching',
    hint: 'On while the server watches the camera.',
    make: () => ({
      name: 'Watching',
      kind: 'binary_sensor',
      deviceClass: 'running',
      source: { kind: 'watching' },
    }),
  },
  {
    id: 'events',
    label: 'Zone events',
    hint: 'An event each time SAM confirms an object entered or left a zone, for automations that react to the moment.',
    needsZone: true,
    make: (memory, zone) => ({
      name: `${zoneLabel(memory, zone)} events`,
      kind: 'event',
      source: { kind: 'in_zone', zoneId: zone },
    }),
  },
  {
    id: 'tracker',
    label: 'Object tracker',
    hint: 'A device tracker: the zone an object is in, home when it is in none, away when it is missing.',
    needsThing: true,
    make: (memory, _, thing) => ({
      name: thingLabel(memory, thing),
      kind: 'device_tracker',
      source: { kind: 'zone_of', objectId: thing },
    }),
  },
  {
    id: 'watch_switch',
    label: 'Watching switch',
    hint: 'A switch Home Assistant can flip to turn watching on and off, with the camera last chosen here.',
    make: () => ({ name: 'Watching', kind: 'switch', source: { kind: 'watching' } }),
  },
  {
    id: 'check_rules',
    label: 'Check rules button',
    hint: 'A button in Home Assistant that checks every rule, as Check rules does here.',
    make: () => ({ name: 'Check rules', kind: 'button', source: { kind: 'check_rules' } }),
  },
];
const KIND_LABEL: Record<ExposeKind, string> = {
  binary_sensor: 'on / off (binary sensor)',
  sensor: 'a value (sensor)',
  switch: 'a switch Home Assistant can flip',
  button: 'a button Home Assistant can press',
  device_tracker: 'a device tracker',
  event: 'events (entered, left)',
};
const BINARY_CLASSES = ['occupancy', 'presence', 'motion', 'problem', 'running', 'opening'];
const SOURCE_LABEL: Record<ExposeSource['kind'], string> = {
  in_zone: 'an object is in a zone',
  any_inside: 'any of several zones holds its object',
  zone_of: 'which zone an object is in',
  status: 'whether a thing is seen or missing',
  motion: 'something moves in a zone',
  occupied: 'someone is in a zone (compared with it empty)',
  watching: 'the server is watching',
  check_rules: 'checking every rule',
};

/** The mug, other objects and tracked fixtures, which entities can follow. */
function things(memory: DeskMemory | null | undefined) {
  return [
    ...(memory?.object ? [{ id: memory.object.id, label: memory.object.label }] : []),
    ...(memory?.others ?? []).map((o) => ({ id: o.id, label: o.label })),
    ...(memory?.fixtures ?? [])
      .filter((f) => f.track)
      .map((f) => ({ id: f.id, label: `${f.label} (fixture)` })),
  ];
}
const thingLabel = (memory: DeskMemory, id: string) =>
  things(memory).find((t) => t.id === id)?.label ?? 'Object';
const zoneLabel = (memory: DeskMemory, id: string) =>
  zonesIn(memory).find((z) => z.id === id)?.label ?? 'Zone';

/** What an entity shows, as a sentence. */
function sourceSentence(memory: DeskMemory, e: Pick<ExposedEntity, 'source'>): string {
  const s = e.source;
  switch (s.kind) {
    case 'in_zone': {
      const zone = zonesIn(memory).find((z) => z.id === s.zoneId);
      return zone ? `whether ${zone.who} is in “${zone.label}”` : 'a zone that is gone';
    }
    case 'any_inside':
      return `whether any of ${s.zoneIds.map((z) => `“${zoneLabel(memory, z)}”`).join(', ')} holds its object`;
    case 'zone_of':
      return `which zone the ${thingLabel(memory, s.objectId)} is in`;
    case 'status':
      return `whether the ${thingLabel(memory, s.thingId)} is seen or missing`;
    case 'motion':
      return `motion in “${zoneLabel(memory, s.zoneId)}”, held for ${s.holdS} s`;
    case 'occupied':
      return `whether “${zoneLabel(memory, s.zoneId)}” looks occupied, compared with it empty${s.samConfirm ? ', confirmed by SAM (billed)' : ''}`;
    case 'watching':
      return 'whether the server is watching the camera';
    case 'check_rules':
      return 'a press that checks every rule';
  }
}
/** A state as the outline and inspector show it. */
export function stateLabel(s: ExposedState | undefined): string {
  if (!s) return 'waiting';
  if (!s.available) return 'unavailable';
  if (s.kind === 'button') return 'button';
  if (s.kind === 'event') return s.state ? `last: ${s.state}` : 'no events yet';
  return s.kind === 'binary_sensor' ? (s.state === 'ON' ? 'on' : 'off') : (s.state ?? '');
}
function stateTone(s: ExposedState | undefined): Tone {
  if (!s) return 'idle';
  if (!s.available) return 'unsure';
  return s.state === 'ON' ? 'ok' : 'seen';
}

/** A source for `kind`, keeping what it can of the one before. */
function sourceOf(
  kind: ExposeSource['kind'],
  prev: ExposeSource,
  zone: string,
  thing: string,
): ExposeSource {
  const z = 'zoneId' in prev ? prev.zoneId : 'zoneIds' in prev ? prev.zoneIds[0]! : zone;
  const t = 'objectId' in prev ? prev.objectId : 'thingId' in prev ? prev.thingId : thing;
  switch (kind) {
    case 'in_zone':
      return { kind, zoneId: z };
    case 'any_inside':
      return { kind, zoneIds: [z] };
    case 'zone_of':
      return { kind, objectId: t };
    case 'status':
      return { kind, thingId: t };
    case 'motion':
      return { kind, zoneId: z, holdS: 'holdS' in prev ? prev.holdS : 300 };
    case 'occupied':
      return { kind, zoneId: z, holdS: 30, samConfirm: false };
    case 'watching':
    case 'check_rules':
      return { kind };
  }
}

/** The form for one entity, new or saved. */
function EntityEditor({
  entity,
  onSaved,
}: {
  entity?: ExposedEntity;
  onSaved: (id: string) => void;
}) {
  const lab = useLabParts(useFeedback(), useDesk());
  const { memory } = lab;
  const { call, off } = useCall();
  const zones = memory ? zonesIn(memory) : [];
  const list = things(memory);
  const firstZone = zones[0]?.id ?? MAIN_ZONE;
  const firstThing = list[0]?.id ?? '';
  const [draft, setDraft] = useState<Omit<ExposedInput, 'key'> | null>(entity ?? null);
  const [key, setKey] = useState(entity?.key ?? '');
  const [keyEdited, setKeyEdited] = useState(Boolean(entity));
  if (!memory) return null;
  const set = (patch: Partial<Omit<ExposedInput, 'key'>>) => {
    const next = { ...draft!, ...patch };
    setDraft(next);
    if (!keyEdited && patch.name !== undefined) setKey(keyFromName(patch.name));
  };
  if (!draft) {
    const why = (p: Preset) =>
      p.needsZone && !zones.length ? 'zone' : p.needsThing && !list.length ? 'thing' : null;
    const preset = (p: Preset) => (
      <Button
        key={p.id}
        className="expose-preset"
        disabled={Boolean(why(p))}
        onClick={() => {
          const made = p.make(memory, firstZone, firstThing);
          setDraft(made);
          setKey(keyFromName(made.name));
        }}
      >
        <strong>{p.label}</strong>
        <small>{p.hint}</small>
      </Button>
    );
    const later = (reason: 'zone' | 'thing') => PRESETS.filter((p) => why(p) === reason);
    return (
      <div className="expose-presets">
        {PRESETS.filter((p) => !why(p)).map(preset)}
        {later('thing').length > 0 && (
          <>
            <p className="micro expose-later">
              After you remember an object (under Objects in the outline):
            </p>
            {later('thing').map(preset)}
          </>
        )}
        {later('zone').length > 0 && (
          <>
            <p className="micro expose-later">
              After you draw a zone (Add rule, under Rules in the outline):
            </p>
            {later('zone').map(preset)}
          </>
        )}
      </div>
    );
  }
  const s = draft.source;
  const kinds = SOURCE_KINDS[s.kind];
  const input = { ...draft, key, ...(entity ? { id: entity.id } : {}) } as ExposedInput;
  const options = sensorOptions(memory, { ...input, id: entity?.id ?? '' } as ExposedEntity);
  const zonePicker = (value: string, onChange: (id: string) => void, label: string) => (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {zones.map((z) => (
        <option key={z.id} value={z.id}>
          {z.label} ({z.who})
        </option>
      ))}
    </select>
  );
  const thingPicker = (value: string, onChange: (id: string) => void) => (
    <select aria-label="Thing" value={value} onChange={(e) => onChange(e.target.value)}>
      {list.map((t) => (
        <option key={t.id} value={t.id}>
          {t.label}
        </option>
      ))}
    </select>
  );
  return (
    <>
      <div className="rule-builder">
        <span>Name</span>
        <input
          aria-label="Entity name"
          maxLength={60}
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <span>Key</span>
        <input
          aria-label="Entity key"
          maxLength={48}
          value={key}
          onChange={(e) => {
            setKeyEdited(true);
            setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
          }}
        />
        <span>Shows</span>
        <select
          aria-label="What it shows"
          value={s.kind}
          onChange={(e) => {
            const kind = e.target.value as ExposeSource['kind'];
            set({
              source: sourceOf(kind, s, firstZone, firstThing),
              ...(SOURCE_KINDS[kind].includes(draft.kind) ? {} : { kind: SOURCE_KINDS[kind][0]! }),
            });
          }}
        >
          {(Object.keys(SOURCE_LABEL) as ExposeSource['kind'][]).map((k) => (
            <option
              key={k}
              value={k}
              disabled={
                (['in_zone', 'any_inside', 'motion', 'occupied'].includes(k) && !zones.length) ||
                (['zone_of', 'status'].includes(k) && !list.length)
              }
            >
              {SOURCE_LABEL[k]}
            </option>
          ))}
        </select>
        {(s.kind === 'in_zone' || s.kind === 'motion' || s.kind === 'occupied') && (
          <>
            <span>Zone</span>
            {zonePicker(s.zoneId, (zoneId) => set({ source: { ...s, zoneId } }), 'Zone')}
          </>
        )}
        {s.kind === 'motion' && (
          <>
            <span>Hold</span>
            <input
              aria-label="Seconds of stillness before off"
              type="number"
              min={5}
              max={3600}
              value={s.holdS}
              onChange={(e) => set({ source: { ...s, holdS: Math.round(Number(e.target.value)) } })}
            />
          </>
        )}
        {s.kind === 'occupied' && (
          <>
            <span>Hold</span>
            <input
              aria-label="Seconds it stays on after the zone looks empty"
              type="number"
              min={0}
              max={3600}
              value={s.holdS}
              onChange={(e) => set({ source: { ...s, holdS: Math.round(Number(e.target.value)) } })}
            />
          </>
        )}
        {s.kind === 'zone_of' && (
          <>
            <span>Object</span>
            {thingPicker(s.objectId, (objectId) => set({ source: { ...s, objectId } }))}
          </>
        )}
        {s.kind === 'status' && (
          <>
            <span>Thing</span>
            {thingPicker(s.thingId, (thingId) => set({ source: { ...s, thingId } }))}
          </>
        )}
        <span>As</span>
        <select
          aria-label="Entity kind"
          value={draft.kind}
          onChange={(e) => set({ kind: e.target.value as ExposeKind })}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        {draft.kind === 'binary_sensor' && (
          <>
            <span>Class</span>
            <select
              aria-label="Device class"
              value={draft.deviceClass ?? ''}
              onChange={(e) => set({ deviceClass: e.target.value || undefined })}
            >
              <option value="">none</option>
              {BINARY_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {s.kind === 'any_inside' && (
        <fieldset className="expose-zones">
          <legend className="micro">Zones</legend>
          {zones.map((z) => (
            <Check
              key={z.id}
              checked={s.zoneIds.includes(z.id)}
              onChange={(on) => {
                const zoneIds = on ? [...s.zoneIds, z.id] : s.zoneIds.filter((id) => id !== z.id);
                if (zoneIds.length) set({ source: { ...s, zoneIds } });
              }}
            >
              {z.label} ({z.who})
            </Check>
          ))}
        </fieldset>
      )}
      {s.kind === 'occupied' && (
        <label className="expose-opt-in">
          <input
            type="checkbox"
            checked={s.samConfirm}
            onChange={(e) => set({ source: { ...s, samConfirm: e.target.checked } })}
          />{' '}
          Also ask SAM whether a person is there before it turns on. <strong>Billed:</strong> one
          live call each time the zone starts to look occupied, at most once a minute. Off,
          everything stays on this computer.
        </label>
      )}
      <p className="micro">
        In Home Assistant: <code>{key ? exposedEntityId({ kind: draft.kind, key }) : '…'}</code>
        {options ? ` · one of ${options.join(', ')}` : ''}
      </p>
      <div className="save-actions">
        <Button
          variant="primary"
          disabled={off || !draft.name.trim() || !/^[a-z0-9_]{1,48}$/.test(key)}
          onClick={() =>
            void call<DeskMemory>('expose/save', { entity: input }, (m) => {
              lab.setMemory(m, false);
              const saved = entity
                ? entity.id
                : m.exposed?.find((e) => e.key === key && e.kind === draft.kind)?.id;
              lab.setMessage(`Saved ${exposedEntityId({ kind: draft.kind, key })}.`);
              if (saved) onSaved(saved);
            })
          }
        >
          {entity ? 'Save changes' : 'Show in Home Assistant'}
        </Button>
        <Button onClick={() => (entity ? onSaved(entity.id) : setDraft(null))}>
          {entity ? 'Cancel' : 'Back'}
        </Button>
      </div>
    </>
  );
}

/** Teach a zone how it looks empty, so an occupied entity can tell when someone is there. */
function EmptyLook({ zoneId, learned }: { zoneId: string; learned: boolean }) {
  const lab = useLabParts(useFeedback(), useTracking());
  const { call, off } = useCall();
  return (
    <div className="save-actions">
      <Button
        variant={learned ? 'secondary' : 'primary'}
        disabled={off || !lab.watching}
        title={lab.watching ? undefined : 'Turn on watching first.'}
        onClick={() =>
          void call<{ method: 'features' | 'pixels' }>('expose/learn-empty', { zoneId }, (r) =>
            lab.setMessage(
              r.method === 'features'
                ? 'Learned how the zone looks empty, from the feature model.'
                : 'Learned how the zone looks empty, from grey levels: light changes can fool this. bun run fetch-model adds the feature model.',
            ),
          )
        }
      >
        {learned ? 'Learn it empty again' : 'It’s empty now: learn it'}
      </Button>
    </div>
  );
}

/** What the broker is doing, in one line; in the demo, what it would have sent. */
function BrokerNote() {
  const lab = useLabParts(useView(), useTracking());
  const view = lab.expose;
  if (!view) return null;
  return (
    <>
      <p className="micro">{view.broker.note}</p>
      {view.commands.length > 0 && (
        <Details summary="Commands from Home Assistant">
          <ul className="expose-log">
            {view.commands.map((c, n) => (
              <li key={`${c.at}${n}`}>
                <code>ll_{c.key}</code> {c.action}: {c.result}
              </li>
            ))}
          </ul>
        </Details>
      )}
      {lab.mode === 'demo' && view.log.length > 0 && (
        <Details summary="What it would publish">
          <ul className="expose-log">
            {view.log.slice(0, 12).map((l, n) => (
              <li key={`${l.at}${n}`}>
                <code>{l.topic}</code> {l.payload === '' ? '(cleared)' : l.payload}
              </li>
            ))}
          </ul>
        </Details>
      )}
    </>
  );
}

const MQTT_SNIPPET = `MQTT_URL=mqtt://homeassistant.local:1883
MQTT_USERNAME=livinglayer
MQTT_PASSWORD=its-password
MQTT_LIVE_ENABLED=true`;

/**
 * Live, with no broker set up: how entities reach Home Assistant, and the
 * `.env` lines that connect it. Picking entities still works meanwhile.
 */
function MqttSetup() {
  const lab = useLabParts(useFeedback());
  return (
    <div className="expose-setup" role="note">
      <strong>Not publishing yet: connect MQTT first</strong>
      <p className="micro">
        Living Layer sends these to Home Assistant over MQTT, the way Zigbee2MQTT devices appear.
        You can pick them now; they show up once it’s connected.
      </p>
      <ol className="devices-steps">
        <li>
          In Home Assistant, add the Mosquitto broker (Settings → Add-ons) and the MQTT integration
          it suggests.
        </li>
        <li>
          Put these in <code>.env</code>, with a Home Assistant user’s name and password (the add-on
          accepts them), then restart the server:
          <pre className="devices-snippet">{MQTT_SNIPPET}</pre>
          <Button
            variant="text"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(MQTT_SNIPPET)
                .then(() => lab.setMessage('Copied the .env lines.'))
                .catch(() => {})
            }
          >
            Copy
          </Button>
        </li>
      </ol>
    </div>
  );
}

export function NewEntityPanel() {
  const lab = useLabParts(useView(), useDesk(), useNavigation());
  const unset = lab.mode === 'live' && !(lab.status?.mqtt.configured && lab.status.mqtt.enabled);
  return (
    <Panel
      tiny="HOME ASSISTANT"
      title="Show in Home Assistant"
      status="Pick one. It appears in Home Assistant under the Living Layer device."
      tone="seen"
    >
      <p className="micro">
        Gives Home Assistant what Living Layer sees, for its automations and dashboards. To let
        Living Layer switch your lights instead,{' '}
        <Button variant="text" onClick={() => lab.select({ kind: 'devices' })}>
          pick devices it can switch →
        </Button>
      </p>
      {unset && <MqttSetup />}
      <EntityEditor onSaved={(id) => lab.select({ kind: 'entity', id })} />
      {!unset && <BrokerNote />}
    </Panel>
  );
}

export function EntityPanel({ id }: { id: string }) {
  const lab = useLabParts(useFeedback(), useDesk(), useTracking(), useNavigation());
  const { memory } = lab;
  const { call, off } = useCall();
  const [editing, setEditing] = useState(false);
  const e = memory?.exposed?.find((x) => x.id === id);
  if (!memory || !e) return <NewEntityPanel />;
  const s = lab.expose?.states.find((x) => x.id === id);
  const entityId = exposedEntityId(e);
  const topic = `livinglayer/${e.key}`;
  return (
    <Panel
      tiny={`HOME ASSISTANT · ${e.kind === 'binary_sensor' ? 'BINARY SENSOR' : 'SENSOR'}`}
      title={e.name}
      status={
        s && !s.available
          ? `Unavailable: ${s.reason ?? 'no state yet.'}`
          : `Now: ${stateLabel(s)}${s?.attributes.stale ? ' (last verdict; nobody is watching)' : ''}.`
      }
      tone={stateTone(s)}
    >
      <p className="rule-sentence">
        <strong>{entityId}</strong> shows {sourceSentence(memory, e)}.
      </p>
      {editing ? (
        <EntityEditor entity={e} onSaved={() => setEditing(false)} />
      ) : (
        <div className="save-actions">
          <Button onClick={() => setEditing(true)}>Change</Button>
          <Button
            onClick={() =>
              void navigator.clipboard
                ?.writeText(entityId)
                .then(() => lab.setMessage(`Copied ${entityId}.`))
                .catch(() => {})
            }
          >
            Copy entity id
          </Button>
        </div>
      )}
      {e.source.kind === 'occupied' && (
        <EmptyLook zoneId={e.source.zoneId} learned={Boolean(s?.attributes.method)} />
      )}
      {(e.kind === 'switch' || e.kind === 'button') && (
        <p className="micro">
          Home Assistant can {e.kind === 'switch' ? 'flip' : 'press'} this; it does what the
          workspace’s own {e.kind === 'switch' ? 'watching switch' : 'Check rules'} does. Live only.
        </p>
      )}
      <BrokerNote />
      {s && Object.keys(s.attributes).length > 0 && (
        <Details summary="Attributes">
          <dl className="expose-attrs">
            {Object.entries(s.attributes).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v === null ? '—' : String(v)}</dd>
              </div>
            ))}
          </dl>
        </Details>
      )}
      <Details summary="Topics">
        <p className="micro">
          State <code>{topic}/state</code>, attributes <code>{topic}/attributes</code>, availability{' '}
          <code>{topic}/availability</code> and <code>livinglayer/status</code>, all retained. The
          prefixes come from MQTT_BASE_TOPIC and MQTT_DISCOVERY_PREFIX.
        </p>
      </Details>
      <Details summary="Delete">
        <Button
          variant="danger"
          disabled={off}
          onClick={() =>
            void call<DeskMemory>('expose/delete', { id: e.id }, (m) => {
              lab.setMemory(m, false);
              lab.setMessage(`Removed ${entityId} from Home Assistant.`);
              lab.select(null);
            })
          }
        >
          Remove {entityId}
        </Button>
      </Details>
    </Panel>
  );
}
