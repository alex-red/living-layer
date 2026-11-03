import { AIRichPreviewDialog, type AIStep } from '../AIRichPreviewDialog';
import { Button } from '../ui/controls';
import { useLab } from './LabContext';
import { RESULT_GLYPH } from './useLabState';

/** The lab's AI action, running or past, step by step in the AI dialog. */
export function AiTaskDialog() {
  const lab = useLab();
  const task = lab.aiTask;
  if (!task) return null;
  const steps: AIStep[] = (task.job?.steps ?? []).map((s) => ({
    ...s,
    state: s.state === 'waiting' ? 'pending' : s.state,
  }));
  // The model calls it made, as the run log keeps them, to inspect each one.
  const runs = (task.job?.runIds ?? []).flatMap((id) => lab.runs.find((r) => r.id === id) ?? []);
  // A past modelling run whose model was drawn can put it back on its fixture.
  const reapply =
    task.review &&
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
        : reapply
          ? { action: reapply }
          : {})}
      onHide={() => lab.setAiTask({ ...task, open: false })}
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
