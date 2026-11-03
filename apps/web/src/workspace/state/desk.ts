import { useEffect, useRef, useState, useMemo } from 'react';
import type { LabStatus, Mode, DeskMemory } from '@livinglayer/domain';
import { DEMO_LIGHTS, DEMO_SWITCHES } from '@livinglayer/domain';
import { api } from '../../api';
import { usd } from '../../cost';
import { lightStates } from '../labels';
import { UNDO_LIMIT } from './helpers';
import type { ViewSlice } from './view';
import type { FeedbackSlice } from './feedback';
import type { RunLogSlice } from './runlog';
import { useStableSlice } from './stable';
import type { Dispatch, RefObject, SetStateAction } from 'react';

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
    if (undoable && before && JSON.stringify(before) !== JSON.stringify(next)) {
      undo.current[next.mode] = [...undo.current[next.mode], before].slice(-UNDO_LIMIT);
      redo.current[next.mode] = [];
      edits.current++;
      setHistoryTick((t) => t + 1);
    }
    memoryWrites.current++;
    setMemories((current) => ({ ...current, [next.mode]: next }));
  };
  const refresh = async () => {
    const started = ++memoryWrites.current;
    const [nextStatus, nextRuns, demoDesk, liveDesk] = await Promise.all([
      api('status'),
      api('runs'),
      api('desk/demo'),
      api('desk/live'),
    ]);
    setStatus(nextStatus);
    setRuns(nextRuns);
    if (started === memoryWrites.current) setMemories({ demo: demoDesk, live: liveDesk });
    return { demo: demoDesk, live: liveDesk };
  };
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
  const proofCount = status ? Object.values(status.liveEvidence).filter(Boolean).length : 0;
  const lights = useMemo(
    () => (mode === 'demo' ? DEMO_LIGHTS : (status?.lamp.lights ?? [])),
    [mode, status?.lamp.lights],
  );
  /** Each light's last confirmed state in this mode, for lamps that glow. */
  const lightsOn = useMemo(
    () =>
      new Set(
        [...lightStates(memory, runs)].filter(([, s]) => s === 'on').map(([entity]) => entity),
      ),
    [memory, runs],
  );
  /** What a rule or a fixture may switch: the lights, then the switches. */
  const entities = useMemo(
    () => [...lights, ...(mode === 'demo' ? DEMO_SWITCHES : (status?.lamp.switches ?? []))],
    [lights, mode, status?.lamp.switches],
  );
  return useStableSlice({
    deskReady,
    edits,
    entities,
    historyTick,
    lampReady,
    lights,
    lightsOn,
    limitDraft,
    memories,
    memory,
    metaReady,
    proofCount,
    redo,
    refresh,
    restoreDesk,
    saveSpendLimit,
    setDeskReady,
    setHistoryTick,
    setLimitDraft,
    setMemory,
    spendShare,
    spendTone,
    status,
    undo,
  });
}
/** What the Desk slice of the lab offers: its state, derived values and actions. */
export interface DeskSlice {
  deskReady: boolean;
  edits: RefObject<number>;
  entities: string[];
  historyTick: number;
  lampReady: boolean;
  lights: string[];
  lightsOn: Set<string>;
  limitDraft: string;
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
  setDeskReady: Dispatch<SetStateAction<boolean>>;
  setHistoryTick: Dispatch<SetStateAction<number>>;
  setLimitDraft: Dispatch<SetStateAction<string>>;
  setMemory: (next: DeskMemory, undoable?: boolean) => void;
  spendShare: number;
  spendTone: string;
  status: LabStatus | undefined;
  undo: RefObject<Record<'demo' | 'live', DeskMemory[]>>;
}
