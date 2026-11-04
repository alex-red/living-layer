import type { SelectionShape } from '@livinglayer/domain';
import type { AiTask } from './state/ai-task-store';

/** Words longer than this are cut in the line, ending with an ellipsis. */
const SAID_CHARS = 60;

/** A data URL's bytes, from its base64. */
const bytesOf = (dataUrl: string) =>
  Math.round(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

/**
 * What an AI brush request carries to the server, for the dialog's first
 * step: the words, and the selection with the frame it was drawn on (live),
 * or only the words for a follow-up, which keeps the last request's.
 */
export function brushSending(
  prompt: string,
  shape: SelectionShape | null,
  frame: string | null,
): NonNullable<AiTask['sending']> {
  const said = prompt.length > SAID_CHARS ? `${prompt.slice(0, SAID_CHARS - 1)}…` : prompt;
  if (!shape) return { detail: `“${said}”, about your last request` };
  if (!frame) return { detail: `“${said}” and your selection` };
  return {
    detail: `“${said}”, your selection and the frame you drew on (${Math.round(bytesOf(frame) / 1024)} KB)`,
    image: frame,
  };
}
