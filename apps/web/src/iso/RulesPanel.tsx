import { useState } from 'react';
import {
  MAX_OTHER_OBJECTS,
  MAX_RULES,
  objectById,
  type DeskMemory,
  type EvidenceRun,
  type Mode,
  type PlacementDecision,
  type Segmentation,
  type ZoneRect,
} from '@livinglayer/domain';
import { api } from '../api';

type Events = { memory: DeskMemory; events: EvidenceRun<PlacementDecision>[] };
export interface RuleDraft {
  objectId: string;
  lightId: string;
  label: string;
  rect: ZoneRect | null;
}
const VERDICT: Record<string, string> = {
  inside: '✓ inside',
  outside: '— outside',
  blocked: '◌ blocked',
};
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * More objects, more zones, more lights. Each extra object is confirmed by
 * hand from a segmentation and then tracked in segmentations of its own
 * concept; each rule ties one object to one zone and one light.
 */
export function RulesPanel({
  mode,
  memory,
  segmentation,
  segmentRunId,
  lights,
  busy,
  draft,
  onDraft,
  onModel,
  onResult,
  onError,
}: {
  mode: Mode;
  memory?: DeskMemory;
  segmentation?: Segmentation;
  segmentRunId?: string;
  lights: string[];
  busy: boolean;
  /** A rule being set up; its zone is drawn on the iso surface. */
  draft: RuleDraft | null;
  onDraft: (draft: RuleDraft | null) => void;
  onModel: (objectId: string) => void;
  onResult: (
    memory: DeskMemory,
    message: string,
    events?: EvidenceRun<PlacementDecision>[],
  ) => void;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [pick, setPick] = useState('');
  const [label, setLabel] = useState('');
  const others = memory?.others ?? [];
  const rules = memory?.rules ?? [];
  const objects = [
    ...(memory?.object && memory.observation
      ? [{ id: memory.object.id, label: memory.object.label }]
      : []),
    ...others.filter((o) => o.observation).map((o) => ({ id: o.id, label: o.label })),
  ];
  // Masks from the newest segmentation that aren't the mug's current one.
  const choices =
    segmentation && segmentRunId
      ? segmentation.detections.filter(
          (d) =>
            !(
              memory?.observation?.segmentRunId === segmentRunId &&
              memory.observation.detectionId === d.objectId
            ),
        )
      : [];

  async function call<T>(path: string, body: object, done: (r: T) => void) {
    setPending(true);
    try {
      done(await api<T>(path, { mode, ...body }));
    } catch (e) {
      onError(e instanceof Error ? e.message : 'The request failed.');
    } finally {
      setPending(false);
    }
  }
  const summary = (events: EvidenceRun<PlacementDecision>[]) =>
    events.length
      ? events
          .map((e) => {
            const r = rules.find((x) => x.id === e.output.ruleId);
            return `${r?.label ?? 'Zone'}: ${e.output.decision}${e.output.action !== 'none' ? `, light ${e.output.action}` : ''}`;
          })
          .join(' · ')
      : 'No rules to check.';
  const off = busy || pending;

  return (
    <div className="rules-panel">
      <section aria-label="Remembered objects">
        <div className="item-head">
          <span className="tiny">OBJECTS · {others.length + (memory?.object ? 1 : 0)}</span>
        </div>
        <ul className="rules-list">
          {memory?.object && (
            <li>
              <span>
                {memory.object.label} <span className="tiny">MUG · MAIN ZONE</span>
              </span>
              <button className="link" disabled={off} onClick={() => onModel(memory.object!.id)}>
                Model
              </button>
            </li>
          )}
          {others.map((o) => {
            const canTrack =
              segmentation &&
              segmentRunId &&
              segmentRunId !== o.observation?.segmentRunId &&
              segmentation.concept.trim().toLowerCase() === o.concept.trim().toLowerCase();
            return (
              <li key={o.id} data-other={o.id}>
                <span>
                  {o.label}{' '}
                  <span className="tiny">
                    {o.concept.toUpperCase()}
                    {o.observation ? ` · ${time(o.observation.observedAt)}` : ''}
                  </span>
                </span>
                <span className="rules-actions">
                  <button
                    className="link"
                    disabled={off || !canTrack}
                    title={canTrack ? undefined : `Segment "${o.concept}" in a new frame first.`}
                    onClick={() =>
                      void call<Events>(
                        'desk/objects/track',
                        { objectId: o.id, segmentRunId },
                        (r) =>
                          onResult(
                            r.memory,
                            `Tracked the ${o.label}. ${summary(r.events)}`,
                            r.events,
                          ),
                      )
                    }
                  >
                    Track
                  </button>
                  <button className="link" disabled={off} onClick={() => onModel(o.id)}>
                    Model
                  </button>
                  <button
                    className="link"
                    disabled={off}
                    onClick={() =>
                      void call<DeskMemory>('desk/objects/forget', { objectId: o.id }, (m) =>
                        onResult(m, `Forgot the ${o.label} and its zones.`),
                      )
                    }
                  >
                    Forget
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
        {others.length < MAX_OTHER_OBJECTS && (
          <div className="rules-add">
            <select
              aria-label="Mask to remember"
              value={pick}
              disabled={!choices.length}
              onChange={(e) => {
                setPick(e.target.value);
                if (!label && segmentation) setLabel(segmentation.concept);
              }}
            >
              <option value="">
                {choices.length
                  ? `A "${segmentation!.concept}" mask…`
                  : 'Segment another object first'}
              </option>
              {choices.map((d) => (
                <option key={d.objectId} value={d.objectId}>
                  #{d.objectId}
                  {d.confidence != null ? ` · ${d.confidence.toFixed(2)}` : ''}
                </option>
              ))}
            </select>
            <input
              aria-label="Object name"
              placeholder="Name"
              maxLength={40}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <button
              className="secondary"
              disabled={off || !pick || !label.trim()}
              onClick={() =>
                void call<Events>(
                  'desk/objects/select',
                  { segmentRunId, detectionId: pick, label: label.trim() },
                  (r) => {
                    setPick('');
                    setLabel('');
                    onResult(r.memory, `Remembered the ${label.trim()}.`, r.events);
                  },
                )
              }
            >
              Remember
            </button>
          </div>
        )}
      </section>
      <section aria-label="Placement rules">
        <div className="item-head">
          <span className="tiny">
            RULES · {rules.length}/{MAX_RULES}
          </span>
          <button
            className="secondary"
            disabled={off || !rules.length}
            onClick={() =>
              void call<Events>('desk/rules/verify', {}, (r) =>
                onResult(r.memory, summary(r.events), r.events),
              )
            }
          >
            Check rules
          </button>
        </div>
        <ul className="rules-list">
          {rules.map((r) => {
            const d = r.lastDecision?.output;
            return (
              <li key={r.id} data-rule={r.id}>
                <span>
                  {r.label}{' '}
                  <span className="tiny">
                    {(memory && objectById(memory, r.objectId)?.label.toUpperCase()) ?? 'GONE'} →{' '}
                    {r.lightId}
                  </span>
                  <br />
                  <span className="tiny">
                    {d
                      ? `${VERDICT[d.decision]}${d.action !== 'none' ? ` · LIGHT ${d.action.toUpperCase()}` : ''}`
                      : 'NOT CHECKED'}
                  </span>
                </span>
                <button
                  className="link"
                  disabled={off}
                  onClick={() =>
                    void call<DeskMemory>('desk/rules/delete', { ruleId: r.id }, (m) =>
                      onResult(m, `Removed "${r.label}".`),
                    )
                  }
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
        {draft ? (
          <div className="rules-new">
            <select
              aria-label="Rule object"
              value={draft.objectId}
              onChange={(e) => onDraft({ ...draft, objectId: e.target.value, rect: null })}
            >
              {objects.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Rule light"
              value={draft.lightId}
              onChange={(e) => onDraft({ ...draft, lightId: e.target.value })}
            >
              {lights.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <input
              aria-label="Rule name"
              placeholder="Zone name"
              maxLength={40}
              value={draft.label}
              onChange={(e) => onDraft({ ...draft, label: e.target.value })}
            />
            <span className="tiny">
              {draft.rect
                ? `ZONE ${Math.round(draft.rect.width * 100)}×${Math.round(draft.rect.height * 100)}%`
                : 'DRAG ON THE SURFACE TO DRAW THE ZONE'}
            </span>
            <button
              className="primary"
              disabled={off || !draft.rect || !draft.label.trim() || !draft.lightId}
              onClick={() =>
                void call<DeskMemory>(
                  'desk/rules/save',
                  {
                    rule: {
                      label: draft.label.trim(),
                      objectId: draft.objectId,
                      lightId: draft.lightId,
                      rect: draft.rect,
                    },
                  },
                  (m) => {
                    onDraft(null);
                    onResult(
                      m,
                      `Saved "${draft.label.trim()}". Check rules or track the object to try it.`,
                    );
                  },
                )
              }
            >
              Save rule
            </button>
            <button className="secondary" onClick={() => onDraft(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="secondary"
            disabled={off || !objects.length || !lights.length || rules.length >= MAX_RULES}
            onClick={() =>
              onDraft({ objectId: objects[0]!.id, lightId: lights[0]!, label: '', rect: null })
            }
          >
            Add a zone
          </button>
        )}
        {!lights.length && (
          <small>Set HA_ENTITY_ID (and HA_EXTRA_ENTITY_IDS for more) to choose lights.</small>
        )}
      </section>
    </div>
  );
}
