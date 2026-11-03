import {
  FOOD_LEFT,
  addDays,
  dayOf,
  fixtureInput,
  foodKeeps,
  foodNow,
  type DeskMemory,
  type Fixture,
  type Food,
  type FoodLeft,
} from '@livinglayer/domain';
import { Button, Field, Select } from '../ui/controls';
import { useNow } from '../useNow';
import { useDesk, useFeedback, useLabParts } from './LabContext';
import { Details, useCall } from './panel';
import './food-card.css';

/** Whether a thing is kept as food: it has food set, is named like it, or stands in the fridge. */
const isFood = (f: Fixture) =>
  Boolean(f.food) || f.scene === 'fridge' || foodKeeps(f.label) !== null;

/** Fields set, the rest left out, so an emptied one is gone. */
const clean = (food: Food): Food | undefined => {
  const kept = Object.fromEntries(Object.entries(food).filter(([, v]) => v)) as Food;
  return Object.keys(kept).length ? kept : undefined;
};

/**
 * A food thing's use-by day, when it was opened and how much is left: set by
 * the person, not seen by the camera, and shown in the Things list and over
 * it in the room.
 */
export function FoodCard({ fixture: f }: { fixture: Fixture }) {
  const lab = useLabParts(useFeedback(), useDesk());
  const { call, off } = useCall();
  const now = useNow(60_000);
  if (!isFood(f)) return null;
  const food = f.food ?? {};
  const today = dayOf(now);
  const keeps = foodKeeps(f.label);
  const status = foodNow(f.food, now);
  const name = f.label.toLowerCase();
  const save = (change: Food, done: string) => {
    const next = clean({ ...food, ...change });
    const { food: _, ...input } = fixtureInput(f);
    void call<DeskMemory>(
      'fixtures/save',
      { fixture: { ...input, ...(next ? { food: next } : {}) } },
      (m) => {
        lab.setMemory(m);
        lab.setMessage(done);
      },
    );
  };
  // Opened today, it keeps its usual days opened, unless its own date comes sooner.
  const openedUseBy =
    keeps === null
      ? food.expires
      : food.expires && food.expires < addDays(today, keeps)
        ? food.expires
        : addDays(today, keeps);
  return (
    <Details summary={`Food${status ? ` · ${status.text}` : ''}`} open>
      {status && (
        <p className={`food-status ${status.tone}`} role="status">
          {status.text}
        </p>
      )}
      <div className="food-fields">
        <Field label="Use by">
          <input
            type="date"
            value={food.expires ?? ''}
            disabled={off}
            onChange={(e) =>
              save(
                { expires: e.target.value || undefined },
                e.target.value
                  ? `The ${name} is good until ${e.target.value}.`
                  : `Cleared the ${name}’s use-by day.`,
              )
            }
          />
        </Field>
        <Field label="Opened">
          <input
            type="date"
            value={food.opened ?? ''}
            max={today}
            disabled={off}
            onChange={(e) =>
              save(
                { opened: e.target.value || undefined },
                e.target.value
                  ? `The ${name} was opened ${e.target.value}.`
                  : `The ${name} isn’t opened.`,
              )
            }
          />
        </Field>
        <Field label="Left">
          <Select
            value={food.left ?? 'full'}
            disabled={off}
            options={FOOD_LEFT.map((l) => ({ value: l, label: l[0]!.toUpperCase() + l.slice(1) }))}
            onChange={(left: FoodLeft) =>
              save(
                { left: left === 'full' ? undefined : left },
                left === 'empty' ? `The ${name} is empty.` : `The ${name} is ${left}.`,
              )
            }
          />
        </Field>
      </div>
      <div className="save-actions">
        <Button
          size="sm"
          disabled={off || food.opened === today}
          title={
            keeps === null
              ? undefined
              : `A ${name} usually keeps ${keeps} days once opened: its use-by day moves to then if that is sooner.`
          }
          onClick={() =>
            save(
              { opened: today, ...(openedUseBy ? { expires: openedUseBy } : {}) },
              `Opened the ${name} today${openedUseBy ? `; use it by ${openedUseBy}` : ''}.`,
            )
          }
        >
          Opened today
        </Button>
      </div>
    </Details>
  );
}
