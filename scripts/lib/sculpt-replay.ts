/**
 * A stored sculpt run's answers read again with this tree (`bun run sculpt`):
 * each answer through `readSculpt`, as the route reads it now, and scored
 * against the picture Spark was shown.
 */
import { scoreAgainst, type FitInput, type IsoItem } from '@livinglayer/domain';
import { cropInput } from '../../apps/server/src/item.js';
import { readSculpt, type SculptAnswers } from '../../apps/server/src/fixture/sculpt.js';
import type { Evidence } from './evidence.js';

export interface Replayed {
  runId: string;
  kept: SculptAnswers;
  picture: Buffer;
  input: FitInput;
  /** The model the run kept, and its score then. */
  then: { item: IsoItem | null; iou: number | null };
  answers: { note: string; iouThen: number | null; item: IsoItem | null; iouNow: number | null }[];
}

/** Null when the run kept no answers (it is older than keeping them). */
export async function replaySculpt(ev: Evidence, ref: string): Promise<Replayed | null> {
  const run = ev.run<{ item?: IsoItem; iou?: number }>(ref, 'fixture');
  const json = ev.asset(`${run.id}/answers.json`);
  const picture = ev.asset(`${run.id}/picture.png`);
  if (!json || !picture) return null;
  const kept = JSON.parse(json.toString('utf8')) as SculptAnswers;
  const input = await cropInput(picture, run.output.item?.label ?? kept.baseLabel);
  const answers = await Promise.all(
    kept.answers.map(async ({ answer, iou }) => {
      const item = await readSculpt(kept.baseLabel, answer);
      return {
        note: answer.note,
        iouThen: iou,
        item,
        iouNow: item ? scoreAgainst(item, input, kept.elevation).iou : null,
      };
    }),
  );
  return {
    runId: run.id,
    kept,
    picture,
    input,
    then: { item: run.output.item ?? null, iou: run.output.iou ?? null },
    answers,
  };
}
