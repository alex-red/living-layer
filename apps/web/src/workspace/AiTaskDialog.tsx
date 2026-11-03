import { AIRichPreviewDialog, type AIStep } from '../AIRichPreviewDialog';
import { Button } from '../ui/controls';
import { useLab } from './LabContext';
import { setAiTask, useAiTask } from './state/ai-task-store';
import { RESULT_GLYPH } from './useLabState';

/** The lab's AI action, running or past, step by step in the AI dialog. */
export function AiTaskDialog() {
  const lab = useLab();
  const task = useAiTask();
  if (!task) return null;
  const steps: AIStep[] = (task.job?.steps ?? []).map((s) => ({
    ...s,
    state: s.state === 'waiting' ? 'pending' : s.state,
  }));
  // The model calls it made, as the run log keeps them, to inspect each one.
  const runs = (task.job?.runIds ?? []).flatMap((id) => lab.runs.find((r) => r.id === id) ?? []);
  // The last run can be reverted; an older modelling run can put its model back on its fixture.
  const last = lab.lastAiRun?.jobId === task.jobId && task.status === 'done';
  const after = last
    ? { label: 'Revert', onClick: () => void lab.revertLastAiRun(), quiet: true }
    : task.review &&
        runs.some((r) => r.status === 'completed' && (r.output as { sculpted?: string }).sculpted)
      ? { label: 'Re-Apply', onClick: () => void lab.reapplyAiRun(task.jobId) }
      : undefined;
  return (
    <AIRichPreviewDialog
      open={task.open}
      title={task.title}
      description={task.review ? undefined : task.description}
      steps={steps}
      status={task.status}
      error={task.error}
      startedAt={task.startedAt}
      review={task.review}
      onStop={lab.stopAiTask}
      onClose={lab.closeAiTask}
      {...(task.next
        ? {
            action: {
              label: task.next.label,
              onClick: () => {
                const next = task.next!;
                lab.closeAiTask();
                next.run();
              },
            },
          }
        : after
          ? { action: after }
          : {})}
      onHide={() => setAiTask({ ...task, open: false })}
      footer={
        runs.length ? (
          <span className="aip-runs">
            Its runs:
            {runs.map((run) => (
              <Button
                key={run.id}
                variant="text"
                onClick={() => {
                  lab.closeAiTask();
                  lab.inspect(run);
                }}
              >
                <span aria-hidden="true">{RESULT_GLYPH[run.status]}</span> {run.kind}{' '}
                <code>{run.id.slice(0, 8)}</code>
              </Button>
            ))}
          </span>
        ) : undefined
      }
    />
  );
}
