import { useEffect } from 'react';
import { Button, IconButton } from './ui/controls';
import { installPointerMarks } from './pointer-marks';
import {
  formatElapsed,
  isRecordKey,
  pickRecordingType,
  recordingBitrate,
  recordingFileName,
} from './recording';
import { useNow } from './useNow';
import { createStore, useStore } from './workspace/state/store';
import './recorder.css';

/**
 * Recording this tab to a video file, from the menu or ⌘⇧E (Ctrl+Shift+E) on
 * any page. Chrome asks which tab to share, offering this one first; a short
 * count lets its dialog close before the take starts. While recording, a dot
 * follows the pointer and rings on clicks (the capture leaves the cursor
 * out), and a small control shows the time; hide it for a take without it,
 * then stop with the shortcut or Chrome's "Stop sharing". The file downloads
 * when it stops.
 */
type RecorderState =
  | { phase: 'idle'; error?: string }
  | { phase: 'asking' }
  | { phase: 'counting'; left: number }
  | { phase: 'recording'; startedAt: number; hidden: boolean };

const recorderStore = createStore<RecorderState>({ phase: 'idle' });

const COUNT_FROM = 3;
const FPS = 30;
const MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform);
const RECORD_KEYS = MAC ? '⌘ ⇧ E' : 'Ctrl Shift E';

let take: { stream: MediaStream; recorder?: MediaRecorder; unmark?: () => void } | null = null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Two frames, so what was just taken off the page is gone from the capture too. */
const settle = () =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));

function fail(error: string) {
  take?.stream.getTracks().forEach((t) => t.stop());
  take?.unmark?.();
  take = null;
  recorderStore.set({ phase: 'idle', error });
}

export async function startRecording() {
  if (recorderStore.get().phase !== 'idle') return;
  const type =
    typeof MediaRecorder === 'undefined'
      ? null
      : pickRecordingType((t) => MediaRecorder.isTypeSupported(t));
  if (!type || !navigator.mediaDevices?.getDisplayMedia)
    return fail('This browser can’t record a tab. Use Chrome, or `bun run record`.');
  recorderStore.set({ phase: 'asking' });
  const dpr = window.devicePixelRatio || 1;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'browser',
        frameRate: { ideal: FPS },
        width: { ideal: Math.round(innerWidth * dpr) },
        height: { ideal: Math.round(innerHeight * dpr) },
      },
      audio: false,
      // Chrome's own options: offer this tab first, and no tab switching mid-take.
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
    } as DisplayMediaStreamOptions);
  } catch {
    // Cancelled in Chrome's dialog: nothing to say.
    return recorderStore.set({ phase: 'idle' });
  }
  take = { stream };
  const [track] = stream.getVideoTracks();
  track?.addEventListener('ended', stopRecording);
  for (let left = COUNT_FROM; left > 0; left--) {
    recorderStore.set({ phase: 'counting', left });
    await wait(1000);
    if (take?.stream !== stream) return;
  }
  recorderStore.set({ phase: 'recording', startedAt: Date.now(), hidden: false });
  take.unmark = installPointerMarks();
  await settle();
  if (take?.stream !== stream) return;
  const { width = innerWidth * dpr, height = innerHeight * dpr } = track?.getSettings() ?? {};
  const chunks: Blob[] = [];
  const startedAt = new Date();
  const recorder = new MediaRecorder(stream, {
    mimeType: type,
    videoBitsPerSecond: recordingBitrate(width, height, FPS),
  });
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: type.split(';')[0] });
    if (!blob.size) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = recordingFileName(startedAt, type);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  recorder.onerror = () => fail('The recording stopped with an error.');
  take.recorder = recorder;
  // A chunk a second, so a long take never waits on one huge buffer.
  recorder.start(1000);
  recorderStore.set({ phase: 'recording', startedAt: Date.now(), hidden: false });
}

function stopRecording() {
  const current = take;
  take = null;
  if (current?.recorder?.state === 'recording') current.recorder.stop();
  current?.stream.getTracks().forEach((t) => t.stop());
  current?.unmark?.();
  recorderStore.set({ phase: 'idle' });
}

const toggleRecording = () =>
  recorderStore.get().phase === 'idle' ? void startRecording() : stopRecording();

/** Whether a take is being set up or running: anything the take shouldn't show hides then. */
export const useRecording = () => useStore(recorderStore, (s) => s.phase !== 'idle');

/** The shortcut, and what shows while a take is set up or running. Mounted once, on every page. */
export function Recorder() {
  const state = useStore(recorderStore);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !isRecordKey(e, MAC)) return;
      e.preventDefault();
      toggleRecording();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => stopRecording, []);

  if (state.phase === 'idle')
    return state.error ? (
      <div className="recorder recorder-error" role="alert">
        <span>{state.error}</span>
        <IconButton label="Dismiss" size="sm" onClick={() => recorderStore.set({ phase: 'idle' })}>
          ×
        </IconButton>
      </div>
    ) : null;
  if (state.phase === 'asking') return null;
  if (state.phase === 'counting')
    return (
      <div className="recorder-count" role="status" aria-live="assertive">
        <span key={state.left}>{state.left}</span>
        <small>Recording starts · {RECORD_KEYS} stops</small>
      </div>
    );
  if (state.hidden) return null;
  return <RecordingControl startedAt={state.startedAt} />;
}

function RecordingControl({ startedAt }: { startedAt: number }) {
  const now = useNow(500);
  return (
    <div className="recorder" role="status" aria-label="Recording this tab">
      <span className="recorder-dot" aria-hidden="true" />
      <span className="recorder-time">{formatElapsed(now - startedAt)}</span>
      <Button size="sm" variant="ghost" onClick={stopRecording}>
        Stop
      </Button>
      <IconButton
        label={`Hide this during the take (stop with ${RECORD_KEYS})`}
        size="sm"
        onClick={() =>
          recorderStore.set((s) => (s.phase === 'recording' ? { ...s, hidden: true } : s))
        }
      >
        –
      </IconButton>
    </div>
  );
}
