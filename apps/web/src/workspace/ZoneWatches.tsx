import { useEffect, useState } from 'react';
import {
  mugOf,
  mugSighting,
  otherObjects,
  placedFixtures,
  ruleWho,
  type DeskMemory,
  type PlacementRule,
} from '@livinglayer/domain';
import { Button } from '../ui/controls';
import { useDesk, useFeedback, useLabParts } from './LabContext';
import { useCall } from './panel';
import type { ZoneThing } from './ZoneActions';

/** What sets a zone off: anything the camera follows, or the things named, one or all of them. */
type ZoneTriggers = Pick<PlacementRule, 'objects' | 'match'>;

/** What a zone can watch: every thing the camera follows, the mug among them. */
export function zoneThings(memory: DeskMemory | null | undefined): ZoneThing[] {
  const mug = mugOf(memory);
  return [
    ...(mug && mugSighting(memory) ? [{ id: mug.id, label: mug.label }] : []),
    ...(otherObjects(memory) ?? [])
      .filter((o) => o.observation)
      .map((o) => ({ id: o.id, label: o.label })),
    // A fixture the camera follows can fill a zone too.
    ...placedFixtures(memory)
      .filter((f) => f.track)
      .map((f) => ({ id: f.id, label: f.label })),
  ];
}

/** The same triggers, with `all` dropped once fewer than two things are named. */
function tidy(t: ZoneTriggers): ZoneTriggers {
  return t.match && (t.objects === 'any' || t.objects.length < 2) ? { objects: t.objects } : t;
}

/**
 * Pick what sets a zone off: anything, or one thing or several, and with
 * several, whether any one of them fills it or only all of them together.
 */
export function ZoneWatches({
  value,
  onChange,
  things,
  memory,
  disabled,
}: {
  value: ZoneTriggers;
  onChange: (next: ZoneTriggers) => void;
  things: ZoneThing[];
  memory: DeskMemory | null | undefined;
  disabled?: boolean;
}) {
  const named = value.objects === 'any' ? [] : value.objects;
  const toggle = (id: string) => {
    const next = named.includes(id) ? named.filter((x) => x !== id) : [...named, id];
    // In the things' own order; none picked watches anything.
    const objects = next.length ? things.map((t) => t.id).filter((x) => next.includes(x)) : 'any';
    onChange(tidy({ ...value, objects }));
  };
  const who = memory ? ruleWho(memory, value) : 'something';
  return (
    <>
      <div className="zone-chips" role="group" aria-label="What the zone watches">
        <button
          type="button"
          className="zone-chip"
          aria-pressed={value.objects === 'any'}
          disabled={disabled}
          onClick={() => onChange({ objects: 'any' })}
        >
          Anything
        </button>
        {things.map((t) => (
          <button
            key={t.id}
            type="button"
            className="zone-chip"
            aria-pressed={named.includes(t.id)}
            disabled={disabled}
            onClick={() => toggle(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {named.length > 1 && (
        <div className="zone-chips" role="group" aria-label="How many of them">
          <button
            type="button"
            className="zone-chip"
            aria-pressed={value.match !== 'all'}
            disabled={disabled}
            onClick={() => onChange({ objects: value.objects })}
          >
            Any one of them
          </button>
          <button
            type="button"
            className="zone-chip"
            aria-pressed={value.match === 'all'}
            disabled={disabled}
            onClick={() => onChange({ objects: value.objects, match: 'all' })}
          >
            All of them
          </button>
        </div>
      )}
      <p className="micro">
        {value.objects === 'any'
          ? 'Occupied while anything the camera follows stands inside.'
          : value.match === 'all'
            ? `Occupied only while ${who} all stand inside together.`
            : `Occupied while ${who} stands inside.`}
      </p>
    </>
  );
}

/** A saved zone's triggers, changed in place: saving starts its inside/outside story again. */
export function SavedZoneWatches({
  rule,
  exclude = [],
}: {
  rule: PlacementRule;
  exclude?: string[];
}) {
  const lab = useLabParts(useFeedback(), useDesk());
  const { memory } = lab;
  const { call, off } = useCall();
  const shown: ZoneTriggers = tidy({
    objects: rule.objects,
    ...(rule.match ? { match: rule.match } : {}),
  });
  const shownKey = JSON.stringify(shown);
  const [draft, setDraft] = useState(shown);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `shownKey` stands for the value's content
  useEffect(() => setDraft(shown), [shownKey]);
  const things = zoneThings(memory).filter((t) => !exclude.includes(t.id));
  const dirty = JSON.stringify(draft) !== shownKey;
  return (
    <>
      <ZoneWatches
        value={draft}
        onChange={setDraft}
        things={things}
        memory={memory}
        disabled={off}
      />
      {dirty && (
        <div className="save-actions">
          <Button
            size="sm"
            variant="primary"
            disabled={off}
            onClick={() =>
              void call<DeskMemory>(
                'desk/rules/options',
                { ruleId: rule.id, triggers: draft },
                (m) => {
                  lab.setMemory(m);
                  lab.setMessage(
                    `"${rule.label}" now watches ${memory ? ruleWho(memory, draft) : 'them'}. It is checked afresh.`,
                  );
                },
              )
            }
          >
            Save
          </Button>
          <Button size="sm" disabled={off} onClick={() => setDraft(shown)}>
            Cancel
          </Button>
        </div>
      )}
    </>
  );
}
