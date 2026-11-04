import { useState } from 'react';
import { gpuTrackerLine, type TrackerBackend, type WatchView } from '@livinglayer/domain';
import { api } from './api';
import { Segmented, type Option } from './ui/controls';

const LABEL: Record<TrackerBackend, string> = {
  local: 'This machine',
  vision: 'Apple Vision',
  gpu: 'GPU node',
};

/**
 * What follows things for the live watcher, switched from its health bar:
 * this machine alone, steered by Apple Vision, or the GPU tracker node
 * correcting it. Apple Vision shows only on a server with Apple silicon; the
 * GPU choice is there but off until the server has one configured.
 */
export function TrackerBackendSwitch({ watch }: { watch: WatchView }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (watch.mode !== 'live') return null;
  // A server older than the page sends no backends: only this machine then.
  const backends = watch.backends ?? ['local'];
  const shown = (['local', 'vision', 'gpu'] as const).filter(
    (value) => value !== 'vision' || backends.includes(value),
  );
  const options: Option<TrackerBackend>[] = shown.map((value) => ({
    value,
    label: LABEL[value],
    ...(backends.includes(value)
      ? {}
      : {
          disabled: true,
          title: 'No GPU tracker is configured: set GPU_TRACKER_URL and GPU_TRACKER_TOKEN in .env',
        }),
  }));
  const choose = async (backend: TrackerBackend) => {
    setError('');
    setBusy(true);
    try {
      // The watcher's own stream brings the new view.
      await api('watch/backend', { backend });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not switch the tracker.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tracker-backend">
      <Segmented
        label="Tracker"
        value={watch.backend ?? 'local'}
        options={options}
        onChange={(backend) => void choose(backend)}
        disabled={busy}
      />
      {error && <p className="health-why">{error}</p>}
    </div>
  );
}

/** Apple Vision's rows in the watcher's health detail, while it is the backend. */
export function visionRows(watch: WatchView): [string, string][] {
  const v = watch.vision;
  if (!v) return [];
  if (v.state !== 'steering')
    return [
      [
        'Apple Vision',
        v.state === 'stopped' ? 'stopped: frames go on without it' : 'could not start',
      ],
    ];
  return [
    ['Vision answer', v.ms === null ? '—' : `${v.ms} ms`],
    ['Found by Vision', `${v.found} beyond the usual search`],
    ['Dropped', `${v.dropped} frame${v.dropped === 1 ? '' : 's'} while it answered`],
  ];
}

/**
 * The GPU tracker's rows in the watcher's health detail, while it is the
 * backend. The rows above them stay this machine's: the local match still
 * reads every frame here, and the GPU tracker only corrects it.
 */
export function gpuRows(watch: WatchView): [string, string][] {
  const gpu = watch.gpu;
  if (!gpu) return [];
  if (gpu.state !== 'following') return [['GPU', gpuTrackerLine(gpu)]];
  return [
    ['GPU step', gpu.ms === null ? '—' : `${Math.round(gpu.ms)} ms`],
    [
      'GPU results',
      // Still frames are skipped there: about one a second on a still desk, more as things move.
      `${gpu.rate}/s${gpu.sinceMs === null ? '' : `, last ${(gpu.sinceMs / 1000).toFixed(1)} s ago`}`,
    ],
    ['GPU places', `${gpu.placing} of ${watch.things.length}`],
    ['Fixed by GPU', `${gpu.fixes}${gpu.reseeds ? `, ${gpu.reseeds} handed back` : ''}`],
    ...(gpu.overruled ? [['GPU overruled', `${gpu.overruled}`] as [string, string]] : []),
  ];
}
