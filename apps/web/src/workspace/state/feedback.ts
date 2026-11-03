import { useState } from 'react';
import { ApiError } from '../../api';
import type { Issue } from '../../ProviderUi';
import type { ViewSlice } from './view';
import { useStableSlice } from './stable';

/** The Feedback slice of the lab's state. */
export function useFeedbackSlice(deps: ViewSlice) {
  const { boot, mode } = deps;
  const [busy, setBusy] = useState('');
  const [issue, setIssue] = useState<Issue | null>(null);
  const error = issue?.message ?? '';
  /** Show a failure: a plain sentence, or an API error with the provider's own reason. */
  const setError = (e: string | Error) =>
    setIssue(
      !e
        ? null
        : typeof e === 'string'
          ? { message: e }
          : e instanceof ApiError
            ? { message: e.message, code: e.code, detail: e.detail, runId: e.runId }
            : { message: e.message },
    );
  const [message, setMessage] = useState(
    boot.save
      ? 'Welcome back. Your session was restored from this browser.'
      : 'Start with the room: use the demo office, or photograph your own.',
  );
  // Drives the ambient warm-up. Only a confirmed lamp state turns it on.
  const [lamp, setLamp] = useState<'off' | 'virtual' | 'live'>('off');
  const light = () => setLamp(mode === 'demo' ? 'virtual' : 'live');
  const capsuleTone = error ? 'blocked' : busy ? 'busy' : lamp !== 'off' ? 'warm' : 'idle';

  return useStableSlice({
    busy,
    capsuleTone,
    error,
    issue,
    lamp,
    light,
    message,
    setBusy,
    setError,
    setIssue,
    setLamp,
    setMessage,
  });
}
export type FeedbackSlice = ReturnType<typeof useFeedbackSlice>;
