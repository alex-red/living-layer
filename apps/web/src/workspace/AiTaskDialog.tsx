import { AIRichPreviewDialog, type AIStep } from '../AIRichPreviewDialog';
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
      onHide={() => lab.setAiTask({ ...task, open: false })}
      footer={
        runs.length ? (
          <span className="aip-runs">
            Its runs:
            {runs.map((run) => (
              <button
                key={run.id}
                className="text-button"
                onClick={() => {
                  lab.closeAiTask();
                  lab.inspect(run);
                }}
              >
                <span aria-hidden="true">{RESULT_GLYPH[run.status]}</span> {run.kind}{' '}
                <code>{run.id.slice(0, 8)}</code>
              </button>
            ))}
          </span>
        ) : undefined
      }
    />
  );
}
