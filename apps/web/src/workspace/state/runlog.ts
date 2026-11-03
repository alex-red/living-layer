import { useState, useMemo } from 'react';
import type { EvidenceRun, Mode, RunKind } from '@livinglayer/domain';
import { runCost } from '@livinglayer/domain';
import { usd } from '../../cost';
import { LOG_PAGE, RUN_KINDS, median } from './helpers';
import type { ViewSlice } from './view';
import type { FeedbackSlice } from './feedback';
import { useStableSlice } from './stable';

/** The RunLog slice of the lab's state. */
export function useRunLogSlice(deps: ViewSlice & FeedbackSlice) {
  const { boot, setDrawer, setError, setMessage } = deps;
  const [runs, setRuns] = useState<EvidenceRun[]>([]);
  const [selected, setSelected] = useState<EvidenceRun>();
  const [logKind, setLogKind] = useState<RunKind | 'all'>(
    RUN_KINDS.includes(boot.prefs.logKind as RunKind) ? (boot.prefs.logKind as RunKind) : 'all',
  );
  const [logMode, setLogMode] = useState<Mode | 'all'>(boot.prefs.logMode as Mode | 'all');
  const [failuresOnly, setFailuresOnly] = useState(boot.prefs.failuresOnly);
  const [logLimit, setLogLimit] = useState(LOG_PAGE);
  function costNote(run: EvidenceRun) {
    const cost = runCost(run);
    return cost === null ? '' : ` · ≈ ${usd(cost)}`;
  }
  const filteredRuns = useMemo(
    () =>
      runs.filter(
        (run) =>
          (logKind === 'all' || run.kind === logKind) &&
          (logMode === 'all' || run.mode === logMode) &&
          (!failuresOnly || run.status === 'failed'),
      ),
    [runs, logKind, logMode, failuresOnly],
  );
  const logStats = useMemo(
    () => ({
      failed: filteredRuns.filter((r) => r.status === 'failed').length,
      medianMs: median(filteredRuns.map((r) => r.durationMs)),
      cost: filteredRuns.reduce((sum, r) => sum + (runCost(r) ?? 0), 0),
    }),
    [filteredRuns],
  );
  function inspect(run: EvidenceRun) {
    setSelected(run);
    setDrawer(true);
  }
  function copyRun(run: EvidenceRun) {
    navigator.clipboard
      .writeText(JSON.stringify(run, null, 2))
      .then(() => setMessage(`Run ${run.id.slice(0, 8)} copied as JSON.`))
      .catch(() => setError('The clipboard is unavailable. Select the JSON below instead.'));
  }
  return useStableSlice({
    copyRun,
    costNote,
    failuresOnly,
    filteredRuns,
    inspect,
    logKind,
    logLimit,
    logMode,
    logStats,
    runs,
    selected,
    setFailuresOnly,
    setLogKind,
    setLogLimit,
    setLogMode,
    setRuns,
    setSelected,
  });
}
export type RunLogSlice = ReturnType<typeof useRunLogSlice>;
