import { useEffect } from 'react';
import {
  coachDay,
  demoHistory,
  midnightOf,
  type CoachNudge,
  type CoachView,
  type Mode,
} from '@livinglayer/domain';
import { api } from '../../api';
import { DAY_END, DAY_START } from '../demoDay';
import { createStore, useStore } from './store';

/**
 * The room coach as the page has it: the live coach's view (polled), nudges
 * "Check now" brought in the demo, the ones dismissed, and the last quiet
 * answer. In a store, since the notifications over the room and the dock
 * both show it.
 */
interface Coach {
  live: CoachView | null;
  /** Demo nudges from "Check now", as of the replay's minute. */
  checked: CoachNudge[];
  dismissed: readonly string[];
  /** Why the last "Check now" didn't nudge, or a note on how it did. */
  said: string | null;
  checking: boolean;
}

const coachStore = createStore<Coach>({
  live: null,
  checked: [],
  dismissed: [],
  said: null,
  checking: false,
});

export function useCoach<S>(select: (c: Coach) => S): S {
  return useStore(coachStore, select);
}

export function dismissNudge(id: string) {
  coachStore.set((c) => ({ ...c, dismissed: [...c.dismissed, id] }));
}

/** Look now: a nudge joins the notifications; else the dock says why it kept quiet. */
export async function checkCoach(mode: Mode, at?: number) {
  coachStore.set((c) => ({ ...c, checking: true, said: null }));
  try {
    const check = await api('coach/check', { mode, ...(at !== undefined ? { at } : {}) });
    const nudge = check.nudge;
    coachStore.set((c) => ({
      ...c,
      said: check.quiet ?? check.note,
      checked: nudge && mode === 'demo' ? [...c.checked, nudge] : c.checked,
      live:
        nudge && mode === 'live' && c.live
          ? { ...c.live, nudges: [...c.live.nudges.filter((n) => n.id !== nudge.id), nudge] }
          : c.live,
    }));
  } catch (e) {
    coachStore.set((c) => ({
      ...c,
      said: e instanceof Error ? e.message : 'The coach couldn’t look.',
    }));
  } finally {
    coachStore.set((c) => ({ ...c, checking: false }));
  }
}

export async function switchCoach(on: boolean) {
  const live = await api('coach/switch', { on });
  coachStore.set((c) => ({ ...c, live }));
}

/** How often the page asks the live coach what it said. */
const POLL_MS = 15_000;

/** Keep the live coach's view fresh while `active`. */
export function useLiveCoach(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const load = () =>
      api('coach/live')
        .then((live) => !stop && coachStore.set((c) => ({ ...c, live })))
        .catch(() => {});
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [active]);
}

let demoDay: { day: number; nudges: CoachNudge[] } | null = null;
/**
 * The coach over the demo's sample day, offline: a look every few minutes
 * from morning to night, worked out once a day. The replay shows each nudge
 * as its minute passes.
 */
export function demoCoachDay(): CoachNudge[] {
  const day = midnightOf(Date.now());
  if (demoDay?.day !== day) {
    const at = (minute: number) => day + minute * 60_000;
    const history = { ...demoHistory(at(DAY_END)), watched: null };
    demoDay = { day, nudges: coachDay(history, at(DAY_START), at(DAY_END)) };
  }
  return demoDay.nudges;
}
