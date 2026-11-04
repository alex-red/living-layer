import { useEffect } from 'react';
import {
  COACH_ACTIONS,
  COACH_SNOOZE_MIN,
  DEMO_DAY,
  actionEvents,
  coachDay,
  demoHistory,
  midnightOf,
  type CoachNudge,
  type CoachSnooze,
  type StatEvent,
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
  /** Demo: what the nudges' buttons did, as the person's own events, and the topics snoozed. */
  extra: StatEvent[];
  snoozes: CoachSnooze[];
  /** Nudges acted on, by id: what each says now it's done. */
  acted: Record<string, string>;
  /** A question a button asked, for the dock's Ask to put. */
  askNext: string | null;
}

const coachStore = createStore<Coach>({
  live: null,
  checked: [],
  dismissed: [],
  said: null,
  checking: false,
  extra: [],
  snoozes: [],
  acted: {},
  askNext: null,
});

export function useCoach<S>(select: (c: Coach) => S): S {
  return useStore(coachStore, select);
}

export function dismissNudge(id: string) {
  coachStore.set((c) => ({ ...c, dismissed: [...c.dismissed, id] }));
}

/**
 * Do what a nudge's button says, in the demo: the sip, break or light off
 * joins the sample day's history from the replay's minute (so the coach's
 * later nudges follow from it, and the lamp goes dark), and the nudge says
 * it's done. Live, the buttons wait for now.
 */
export function actOnNudge(nudge: CoachNudge, at: number) {
  const action = COACH_ACTIONS[nudge.topic];
  coachStore.set((c) => ({
    ...c,
    extra: [...c.extra, ...actionEvents(nudge, at)],
    acted: { ...c.acted, [nudge.id]: action.done },
    askNext: action.does === 'ask' ? (action.ask ?? c.askNext) : c.askNext,
  }));
}

/** Add the person's own events to the demo's sample day (the litter card's drawer emptied), as a nudge's button does. */
export function addDemoEvents(events: readonly StatEvent[]) {
  coachStore.set((c) => ({ ...c, extra: [...c.extra, ...events] }));
}

/** Keep a nudge's topic quiet for a while from the replay's minute, and put the nudge away. */
export function snoozeNudge(nudge: CoachNudge, at: number) {
  coachStore.set((c) => ({
    ...c,
    snoozes: [...c.snoozes, { topic: nudge.topic, from: at, to: at + COACH_SNOOZE_MIN * 60_000 }],
    dismissed: [...c.dismissed, nudge.id],
  }));
}

export function takeAskNext(): string | null {
  const q = coachStore.get().askNext;
  if (q) coachStore.set((c) => ({ ...c, askNext: null }));
  return q;
}

/**
 * Whether the demo's lamp is on at `minute`: as the sample day has it, unless
 * a nudge's button switched it off since the day last switched it.
 */
export function demoLampAt(minute: number, scripted: boolean, extra: readonly StatEvent[]) {
  const day = midnightOf(Date.now());
  const off = extra
    .filter((e) => e.thingId === 'lamp' && e.key === 'power' && e.value === false)
    .map((e) => (e.at - day) / 60_000)
    .filter((m) => m <= minute)
    .at(-1);
  if (off === undefined) return scripted;
  const switchedSince = DEMO_DAY.some((e) => e.lamp !== undefined && e.at > off && e.at <= minute);
  return switchedSince ? scripted : false;
}

/**
 * Look now: a nudge joins the notifications; else the dock says why it kept quiet.
 * In the demo it looks for the room on screen (`scene`), so what it brings is shown there.
 */
export async function checkCoach(mode: Mode, at?: number, scene?: string | null) {
  coachStore.set((c) => ({ ...c, checking: true, said: null }));
  try {
    const check = await api('coach/check', {
      mode,
      ...(at !== undefined ? { at } : {}),
      ...(scene ? { scene } : {}),
    });
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

let demoDay: {
  day: number;
  extra: readonly StatEvent[];
  snoozes: readonly CoachSnooze[];
  scene: string | null;
  nudges: CoachNudge[];
} | null = null;
/**
 * The coach over the demo's sample day for the room on screen, offline: a
 * look every few minutes from morning to night (the fridge's own day about
 * its food, the litter box room's about the cat's visits and its drawer, or
 * the one the other rooms share), following what the nudges'
 * buttons did. Worked out again only when one of those changes.
 */
export function demoCoachDay(
  extra: readonly StatEvent[],
  snoozes: readonly CoachSnooze[],
  scene: string | null,
): CoachNudge[] {
  const day = midnightOf(Date.now());
  // The fridge and the litter box room keep days of their own; the rest share one.
  scene = scene === 'fridge' || scene === 'litter' ? scene : null;
  if (
    demoDay?.day !== day ||
    demoDay.extra !== extra ||
    demoDay.snoozes !== snoozes ||
    demoDay.scene !== scene
  ) {
    const at = (minute: number) => day + minute * 60_000;
    const history = { ...demoHistory(at(DAY_END)), watched: null };
    history.events = [...history.events, ...extra].sort((a, b) => a.at - b.at);
    demoDay = {
      day,
      extra,
      snoozes,
      scene,
      nudges: coachDay(history, at(DAY_START), at(DAY_END), snoozes, scene),
    };
  }
  return demoDay.nudges;
}
