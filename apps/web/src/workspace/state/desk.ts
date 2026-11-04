import { useEffect, useRef, useState, useMemo } from 'react';
import type { HaView, LabStatus, Mode, DeskMemory } from '@livinglayer/domain';
import {
  DEMO_DESKTOP_NODE,
  DEMO_LIGHTS,
  DEMO_SWITCHES,
  desktopNodeEntity,
} from '@livinglayer/domain';
import { api, apiIfChanged } from '../../api';
import { usd } from '../../cost';
import { lightStates } from '../labels';
import { haStore } from '../../watch';
import { useStore } from './store';
import { pushHistory, sameDesk } from './helpers';
import { thingsChanged } from '../../session';
import type { ViewSlice } from './view';
import type { FeedbackSlice } from './feedback';
import type { RunLogSlice } from './runlog';
import { useStableSlice } from './stable';
import type { Dispatch, RefObject, SetStateAction } from 'react';

type Desks = { demo: DeskMemory; live: DeskMemory };
/** How often the open lab asks whether its desk changed elsewhere (a script, another tab), ms. */
const DESK_POLL_MS = 3000;

/** The Desk slice of the lab's state. */
export function useDeskSlice(deps: ViewSlice & FeedbackSlice & RunLogSlice): DeskSlice {
  const { mode, runs, setError, setMessage, setRuns } = deps;
  const [status, setStatus] = useState<LabStatus>();
  const [memories, setMemories] = useState<Partial<Record<Mode, DeskMemory>>>({});
  const memory = memories[mode];
  /**
   * Bumped by every memory write. A refresh applies its desk memory only if
   * nothing newer landed while it was in flight, so a slow fire-and-forget
   * refresh can't put back a memory from before a draft or a track.
   */
  const memoryWrites = useRef(0);
  // Each mode's desks from before (undo) and after (redo) the person's edits.
  const undo = useRef<Record<Mode, DeskMemory[]>>({ demo: [], live: [] });
  const redo = useRef<Record<Mode, DeskMemory[]>>({ demo: [], live: [] });
  const [historyTick, setHistoryTick] = useState(0);
  /** Edits, undos and redos so far; a named save notes the count it was saved or loaded at. */
  const edits = useRef(0);
  /** A new desk memory; an edit can be undone, a sighting (`undoable` false) can't. */
  const setMemory = (next: DeskMemory, undoable = true) => {
    const before = memories[next.mode];
    if (undoable && before && !sameDesk(before, next)) {
      undo.current[next.mode] = pushHistory(undo.current[next.mode], before);
      redo.current[next.mode] = [];
      edits.current++;
      setHistoryTick((t) => t + 1);
    }
    memoryWrites.current++;
    setMemories((current) => ({ ...current, [next.mode]: next }));
  };
  /** The runs as last fetched, by the server's tag, so an unchanged log isn't sent again. */
  const runsTag = useRef<string | undefined>(undefined);
  const running = useRef<Promise<Desks> | null>(null);
  const queued = useRef<Promise<Desks> | null>(null);
  const fetchAll = async (): Promise<Desks> => {
    const started = ++memoryWrites.current;
    const [nextStatus, nextRuns, demoDesk, liveDesk] = await Promise.all([
      api('status'),
      apiIfChanged('runs', runsTag.current),
      api('desk/demo'),
      api('desk/live'),
    ]);
    setStatus(nextStatus);
    if (nextRuns) {
      runsTag.current = nextRuns.tag;
      setRuns(nextRuns.data);
    }
    if (started === memoryWrites.current)
      // A desk that hasn't changed keeps its object, so what is worked out from it isn't again.
      setMemories((current) => {
        const demo = current.demo && sameDesk(current.demo, demoDesk) ? current.demo : demoDesk;
        const live = current.live && sameDesk(current.live, liveDesk) ? current.live : liveDesk;
        return demo === current.demo && live === current.live ? current : { demo, live };
      });
    return { demo: demoDesk, live: liveDesk };
  };
  /**
   * Fetch the status, the runs and both desks. Asked while a fetch is under
   * way, it fetches once more after it (one more for every ask meanwhile), so
   * an answer is never from before the ask, and a burst of asks costs two fetches.
   */
  const refresh = (): Promise<Desks> => {
    if (!running.current) {
      running.current = fetchAll().finally(() => {
        running.current = null;
      });
      return running.current;
    }
    queued.current ??= running.current
      .catch(() => {})
      .then(() => {
        queued.current = null;
        return refresh();
      });
    return queued.current;
  };
  /** Each desk's tag as last applied, so an unchanged desk answers 304 and isn't sent again. */
  const deskTags = useRef<Partial<Record<Mode, string>>>({});
  /** The desks as last rendered, for the poll, which outlives a render. */
  const memoriesNow = useRef(memories);
  memoriesNow.current = memories;
  // A desk saved by a script (`bun run thing`) or another tab shows here within a few seconds.
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      const started = memoryWrites.current;
      try {
        const next = await apiIfChanged(`desk/${mode}`, deskTags.current[mode]);
        // Not applied when a write of this tab's landed meanwhile: its tag is kept, so it is asked again.
        if (!next || stopped || started !== memoryWrites.current) return;
        deskTags.current[mode] = next.tag;
        // Things changed elsewhere are edits too, so the named save in use offers to keep them.
        const shown = memoriesNow.current[mode];
        if (shown && thingsChanged(shown, next.data)) edits.current++;
        setMemories((current) => {
          const had = current[mode];
          return had && sameDesk(had, next.data) ? current : { ...current, [mode]: next.data };
        });
      } catch {
        // The server is away or restarting; the next poll asks again.
      }
    };
    const timer = window.setInterval(() => void poll(), DESK_POLL_MS);
    const shown = () => void poll();
    document.addEventListener('visibilitychange', shown);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [mode]);
  // Autosave: choices and desks go to this browser as the person works, once
  // the server's desks have loaded so an empty first render never overwrites them.
  const [deskReady, setDeskReady] = useState(false);
  /** Put a whole desk on the server, for an import, an undo or redo, or the demo. */
  async function restoreDesk(next: DeskMemory) {
    const saved = await api('desk/restore', { mode: next.mode, memory: next });
    memoryWrites.current++;
    setMemories((current) => ({ ...current, [saved.mode]: saved }));
    return saved;
  }
  const metaReady = Boolean(
    status?.meta.configured &&
    status.meta.enabled &&
    status.meta.spentToday < status.meta.spendLimit,
  );
  const lampReady = Boolean(status?.lamp.configured && status.lamp.enabled);
  const spendShare = status
    ? Math.min(1, status.meta.spentToday / Math.max(0.01, status.meta.spendLimit))
    : 0;
  const spendTone = spendShare >= 1 ? 'blocked' : spendShare >= 0.8 ? 'unsure' : 'ok';
  const [limitDraft, setLimitDraft] = useState('');
  const spendLimit = status?.meta.spendLimit;
  useEffect(() => {
    if (spendLimit !== undefined) setLimitDraft(String(spendLimit));
  }, [spendLimit]);
  async function saveSpendLimit(usdLimit: number | null) {
    try {
      const saved = await api('settings/spend-limit', { usd: usdLimit });
      setMessage(`Daily Meta spending limit set to ${usd(saved.spendLimit)}.`);
      setError('');
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The limit could not be saved.');
    }
  }
  /** Whether tracking may call SAM or Spark; off until someone turns it on. */
  const trackingAi = Boolean(status?.tracking.ai);
  async function saveTrackingAi(on: boolean) {
    try {
      const saved = await api('settings/tracking-ai', { on });
      setMessage(
        saved.on
          ? 'Tracking may call AI now: SAM outlines by name and finds lost things, Spark suggests objects. Billed.'
          : 'Tracking runs on this machine only: no SAM or Spark calls.',
      );
      setError('');
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The setting could not be saved.');
    }
  }
  const proofCount = status ? Object.values(status.liveEvidence).filter(Boolean).length : 0;
  const lights = useMemo(
    () => (mode === 'demo' ? DEMO_LIGHTS : (status?.lamp.lights ?? [])),
    [mode, status?.lamp.lights],
  );
  /**
   * Each light's state, for lamps that glow: as Home Assistant reports it now
   * when it is connected (live), else as it was last confirmed in this mode.
   */
  const haStates = useStore(haStore, (v) => (v?.link === 'connected' ? v.states : null));
  /** Home Assistant's devices as it reports them now, while live and connected; else null. */
  const liveHa = useStore(haStore, (v) => (mode === 'live' && v?.link === 'connected' ? v : null));
  /** Each device's state as far as it is known: Home Assistant's now (live), else the last confirmed. */
  const deviceStates = useMemo(() => {
    const states = new Map<string, string>(lightStates(memory, runs));
    if (mode === 'live' && haStates)
      for (const [entity, state] of Object.entries(haStates)) states.set(entity, state);
    return states;
  }, [memory, runs, mode, haStates]);
  const lightsOn = useMemo(
    () => new Set([...deviceStates].filter(([, s]) => s === 'on').map(([entity]) => entity)),
    [deviceStates],
  );
  /** What a rule or a fixture may switch: the lights, then the switches. */
  const entities = useMemo(
    () => [
      ...lights,
      ...(mode === 'demo' ? DEMO_SWITCHES : (status?.lamp.switches ?? [])),
      ...(mode === 'demo'
        ? [desktopNodeEntity(DEMO_DESKTOP_NODE.id)]
        : (status?.lamp.desktops ?? [])),
    ],
    [lights, mode, status?.lamp.switches, status?.lamp.desktops],
  );
  return useStableSlice({
    deskReady,
    deviceStates,
    edits,
    entities,
    historyTick,
    lampReady,
    lights,
    lightsOn,
    limitDraft,
    liveHa,
    memories,
    memory,
    metaReady,
    proofCount,
    redo,
    refresh,
    restoreDesk,
    saveSpendLimit,
    saveTrackingAi,
    setDeskReady,
    setHistoryTick,
    setLimitDraft,
    setMemory,
    spendShare,
    spendTone,
    status,
    trackingAi,
    undo,
  });
}
/** What the Desk slice of the lab offers: its state, derived values and actions. */
export interface DeskSlice {
  deskReady: boolean;
  deviceStates: Map<string, string>;
  edits: RefObject<number>;
  entities: string[];
  historyTick: number;
  lampReady: boolean;
  lights: string[];
  lightsOn: Set<string>;
  limitDraft: string;
  liveHa: HaView | null;
  memories: Partial<Record<'demo' | 'live', DeskMemory>>;
  memory: DeskMemory | undefined;
  metaReady: boolean;
  proofCount: number;
  redo: RefObject<Record<'demo' | 'live', DeskMemory[]>>;
  refresh: () => Promise<{
    demo: DeskMemory;
    live: DeskMemory;
  }>;
  restoreDesk: (next: DeskMemory) => Promise<DeskMemory>;
  saveSpendLimit: (usdLimit: number | null) => Promise<void>;
  saveTrackingAi: (on: boolean) => Promise<void>;
  setDeskReady: Dispatch<SetStateAction<boolean>>;
  setHistoryTick: Dispatch<SetStateAction<number>>;
  setLimitDraft: Dispatch<SetStateAction<string>>;
  setMemory: (next: DeskMemory, undoable?: boolean) => void;
  spendShare: number;
  spendTone: string;
  status: LabStatus | undefined;
  trackingAi: boolean;
  undo: RefObject<Record<'demo' | 'live', DeskMemory[]>>;
}
