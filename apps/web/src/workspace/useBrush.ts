import { useState } from 'react';
import type {
  AssistDraft,
  DeskMemory,
  EvidenceRun,
  Mode,
  SelectionShape,
  SelectResolve,
} from '@livinglayer/domain';
import { api } from '../api';
import type { AiTask } from './useLabState';

/** A point on the frame, in shares of its width and height. */
export interface Share {
  x: number;
  y: number;
}
/** What is being drawn: a box being dragged, or a polygon's points so far. */
export type BrushStroke =
  | { kind: 'rect'; a: Share; b: Share }
  | { kind: 'polygon'; points: Share[] };

/** A name mid-sentence: "Desk" becomes "desk", but "IKEA Alex desk" keeps its capitals. */
export const inSentence = (name: string) =>
  name.slice(1) === name.slice(1).toLowerCase() ? name[0]!.toLowerCase() + name.slice(1) : name;
/** A click this close to the first point closes the polygon. */
export const CLOSE_SHARE = 0.015;
const milli = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000);
/** A finished stroke as a selection, in thousandths; null when it has no area. */
export function shapeOf(stroke: BrushStroke): SelectionShape | null {
  if (stroke.kind === 'polygon')
    return stroke.points.length >= 3
      ? {
          kind: 'polygon',
          points: stroke.points.map((p) => ({ x: milli(p.x), y: milli(p.y) })),
        }
      : null;
  const box = {
    x1: milli(Math.min(stroke.a.x, stroke.b.x)),
    y1: milli(Math.min(stroke.a.y, stroke.b.y)),
    x2: milli(Math.max(stroke.a.x, stroke.b.x)),
    y2: milli(Math.max(stroke.a.y, stroke.b.y)),
  };
  return box.x2 - box.x1 >= 5 && box.y2 - box.y1 >= 5 ? { kind: 'rect', box } : null;
}

/**
 * The AI brush ([plan](../../../../docs/plans/ai-brush.md#8-the-brush-web)):
 * draw a box or a polygon on the camera's picture, see what it is, say what
 * to do, follow the job in the AI dialog, review the draft, put it in the
 * room. Follow-ups keep the selection and cost one reading. Live, the frame
 * is held when the selection is finished, so the request is about what was
 * drawn on, not what the camera shows by then.
 */
export function useBrush({
  mode,
  frameNow,
  followAi,
  closeAiTaskSoon,
  setMemory,
  showOwnScene,
  setMessage,
  setError,
}: {
  mode: Mode;
  frameNow: () => string | undefined;
  followAi: <T>(
    task: Pick<AiTask, 'title' | 'description'>,
    call: (jobId: string, signal: AbortSignal) => Promise<T>,
  ) => Promise<T | null>;
  /** Hide the AI dialog after a moment, unless another request starts first. */
  closeAiTaskSoon: (ms: number) => void;
  setMemory: (memory: DeskMemory) => void;
  /** Show the room's own scene, which the model was saved into. */
  showOwnScene: () => void;
  setMessage: (message: string) => void;
  setError: (error: string | Error) => void;
}) {
  const [stroke, setStroke] = useState<BrushStroke | null>(null);
  const [shape, setShape] = useState<SelectionShape | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const [resolved, setResolved] = useState<SelectResolve | null>(null);
  /** The requests about this selection, oldest first; the last is the draft under review. */
  const [runs, setRuns] = useState<EvidenceRun<AssistDraft>[]>([]);
  const [working, setWorking] = useState<'' | 'send' | 'save'>('');
  const last = runs.at(-1) ?? null;

  function clear() {
    setStroke(null);
    setShape(null);
    setHeld(null);
    setResolved(null);
    setRuns([]);
  }
  /** Finish a stroke: hold the frame (live), and ask what the selection is of (free). */
  async function finish(next: BrushStroke) {
    const s = shapeOf(next);
    setStroke(null);
    if (!s) return;
    setShape(s);
    setRuns([]);
    setResolved(null);
    setHeld(mode === 'live' ? (frameNow() ?? null) : null);
    try {
      setResolved(await api('select/resolve', { mode, shape: s }));
    } catch (e) {
      setError(e instanceof Error ? e : 'Couldn’t tell what the selection is of.');
    }
  }
  /** Esc: a polygon being drawn loses its points first, then the selection goes. */
  function escape(): boolean {
    if (stroke) return (setStroke(null), true);
    if (shape) return (clear(), true);
    return false;
  }
  /** Send what the person typed, about this selection, as a new request or a follow-up. */
  async function send(prompt: string) {
    if (!shape || working || !prompt.trim()) return;
    setWorking('send');
    try {
      const run = await followAi(
        {
          title: 'AI brush',
          description:
            mode === 'live'
              ? last
                ? 'Spark reads your follow-up; the model is checked through the room’s camera again.'
                : 'Spark reads your request, SAM outlines your selection, and a named product is looked up. Up to about $0.25.'
              : 'Demo: read, looked up in the bundled catalog and checked through the demo camera, with no model calls.',
        },
        (jobId, signal) =>
          api(
            'assist',
            {
              mode,
              prompt: prompt.trim(),
              jobId,
              ...(last
                ? { previous: last.id }
                : {
                    shape,
                    ...(mode === 'live' && held ? { imageDataUrl: held } : {}),
                  }),
            },
            { signal },
          ),
      );
      if (!run) {
        setMessage('The AI brush request was stopped before it finished.');
        return;
      }
      setRuns((r) => [...r, run]);
      const d = run.output;
      setMessage(
        d.question
          ? 'The AI brush has a question about your request.'
          : d.recipe
            ? `Drafted ${d.recipe.label}. Review it beside the frame, then put it in the room.`
            : 'Read your request; there was no model to change.',
      );
      // The steps are worth a glance; the review is beside the frame.
      closeAiTaskSoon(1200);
    } catch (e) {
      setError(e instanceof Error ? e : 'The AI brush failed.');
    } finally {
      setWorking('');
    }
  }
  /** Put the reviewed model in the room, and start over. */
  async function save() {
    if (!(last?.output.recipe || last?.output.variant) || working) return;
    setWorking('save');
    try {
      const { memory } = await api('assist/save', {
        mode,
        runId: last.id,
      });
      if (!memory) {
        setError('The model couldn’t be put in the room.');
        return;
      }
      setMemory(memory);
      // A preset room became the person's own scene to take it: show that one.
      showOwnScene();
      const v = last.output.variant;
      setMessage(
        v
          ? `${v.promotes ? `The ${inSentence(v.subject.label)} is a thing of its own now, with` : `The ${inSentence(v.subject.label)} has`} a ${v.state.replace(/-/g, ' ')} state beside its own model.${v.follows ? ' It shows while the camera sees it occupied.' : ''}`
          : `Put ${last.output.recipe!.label} in the room${last.output.place?.replaces ? `, in place of the ${inSentence(last.output.target?.label ?? 'old one')}` : ''}. The Iso view shows it.`,
      );
      clear();
    } catch (e) {
      setError(e instanceof Error ? e : 'The model couldn’t be put in the room.');
    } finally {
      setWorking('');
    }
  }
  return {
    stroke,
    setStroke,
    finish,
    shape,
    held,
    resolved,
    runs,
    last,
    working,
    send,
    save,
    clear,
    escape,
  };
}
export type Brush = ReturnType<typeof useBrush>;
