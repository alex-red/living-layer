import type {
  EvidenceRun,
  Scene,
  RoomMarks,
  Segmentation,
  Detection,
  FixtureDraft,
  MappedThing,
  PictureFind,
  Job,
  LampResult,
  DeskMemory,
  PlacementDecision,
  RunKind,
  DeskObservation,
  LumaFrame,
  UnitBox,
  SceneGuess,
  SavedItem,
} from '@livinglayer/domain';
import { toLuma } from '@livinglayer/domain';

export const BUSY: Record<string, string> = {
  text: 'Checking the connection',
  discover: 'Discovering objects',
  segment: 'Finding the shape',
  lamp: 'Switching the lamp',
  select: 'Remembering the mug',
  zone: 'Saving the zone',
  verify: 'Checking placement',
  reset: 'Resetting desk memory',
  track: 'Tracking the mug',
  autopin: 'Finding the desk',
  illustrate: 'Drawing the room',
  scan: 'Scanning and mapping',
  reapply: 'Applying the model again',
  camera: 'Updating the camera setting',
  undo: 'Undoing',
  revert: 'Reverting the AI run',
  redo: 'Redoing',
  restore: 'Loading the save',
};
/** What calibrating by hand starts from: marks found so far, the room's size and the frame. */
export interface HandCalibration {
  marks: RoomMarks | null;
  room: { w: number; d: number };
  heightCm?: number;
  frame: { width: number; height: number };
}
/** A job as it shows once stopped: what was running or waiting is stopped. */
export function stoppedJob(job: Job): Job {
  return {
    ...job,
    stopped: true,
    done: true,
    steps: job.steps.map((s) =>
      s.state === 'running' || s.state === 'waiting' ? { ...s, state: 'stopped' } : s,
    ),
  };
}
export const TRANSITION: Record<NonNullable<PlacementDecision['transition']>, string> = {
  entered: 'Entered the zone',
  stayed_inside: 'Still inside',
  left: 'Left the zone',
  stayed_outside: 'Still outside',
};
/** Local following samples the camera this often, on frames this wide. */
export const FOLLOW_MS = 100;
export const LUMA_WIDTH = 160;
/**
 * Gaps between SAM checks while following the live camera. A zone crossing
 * waits briefly; re-anchoring backs off while the mug stays lost, so a mug
 * that can't be told from its surroundings doesn't call SAM every few frames.
 */
export const CONFIRM_GAP_MS = 2000;
export const REANCHOR_GAP_MS = { first: 2000, max: 30_000 };
/** Good local steps in a row (about 3 s) before re-anchoring is trusted to have worked. */
export const RECOVERED_STEPS = 30;
/** Times a wanted camera is tried again before waiting for the person, after it dropped. */
export const REOPEN_TRIES = 4;
export const lumaCanvas = document.createElement('canvas');
/** Downsample any image or video frame to grayscale for the local tracker. */
export function lumaOf(source: HTMLImageElement | HTMLVideoElement): LumaFrame {
  const [w, h] =
    source instanceof HTMLVideoElement
      ? [source.videoWidth, source.videoHeight]
      : [source.naturalWidth, source.naturalHeight];
  lumaCanvas.width = LUMA_WIDTH;
  lumaCanvas.height = Math.max(1, Math.round((LUMA_WIDTH * h) / w));
  const context = lumaCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser cannot read frames for local following.');
  context.drawImage(source, 0, 0, lumaCanvas.width, lumaCanvas.height);
  const { data } = context.getImageData(0, 0, lumaCanvas.width, lumaCanvas.height);
  return toLuma(data, lumaCanvas.width, lumaCanvas.height);
}
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read the frame for local following.'));
    img.src = src;
  });
}
/** SAM's mask for `d`, drawn onto a frame-sized 0/1 grid at the tracker's resolution. */
export function maskOf(
  d: Detection,
  frame: Segmentation['frame'],
  luma: LumaFrame,
): Uint8Array | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = luma.width;
  canvas.height = luma.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return undefined;
  context.scale(luma.width / frame.width, luma.height / frame.height);
  context.translate(d.box.x, d.box.y);
  context.scale(d.box.width / d.mask.width, d.box.height / d.mask.height);
  context.fill(new Path2D(d.mask.svgPath), 'evenodd');
  const alpha = context.getImageData(0, 0, luma.width, luma.height).data;
  const mask = new Uint8Array(luma.width * luma.height);
  // Only pixels mostly inside the mask, so edge pixels blended with the background stay out.
  for (let i = 0; i < mask.length; i++) mask[i] = alpha[i * 4 + 3]! > 160 ? 1 : 0;
  return mask;
}
export const unitBox = (o: DeskObservation): UnitBox => ({
  x: o.box.x / o.frame.width,
  y: o.box.y / o.frame.height,
  width: o.box.width / o.frame.width,
  height: o.box.height / o.frame.height,
});
/** Box centre as a share of the frame, for comparing observations across frames. */
export const centre = (o: DeskObservation) => ({
  x: (o.box.x + o.box.width / 2) / o.frame.width,
  y: (o.box.y + o.box.height / 2) / o.frame.height,
});
export const RESULT_GLYPH: Record<EvidenceRun['status'], string> = {
  completed: '✓',
  no_match: '◌',
  unconfirmed: '◌',
  failed: '×',
};
export const RUN_KINDS: RunKind[] = [
  'text',
  'discover',
  'segment',
  'scene',
  'layout',
  'photo',
  'illustration',
  'item',
  'fixture',
  'assist',
  'lamp',
  'observation',
  'zone',
  'placement',
];
export const LOG_PAGE = 10;
/** Undo steps kept per mode. */
export const UNDO_LIMIT = 50;
/** Whether a desk holds anything a person made: an object, a pin, a scene, a rule. */
export const deskIsBlank = (d: DeskMemory) =>
  !d.object &&
  !d.surface &&
  !d.scene &&
  !d.zone &&
  !d.item &&
  !d.others?.length &&
  !d.rules?.length &&
  !d.fixtures?.length;
export type ProbeKind = 'text' | 'discover' | 'segment' | 'lamp';
export const isProbe = (kind: RunKind): kind is ProbeKind =>
  ['text', 'discover', 'segment', 'lamp'].includes(kind);

/** One short line on what a run returned, for the log and the inspector. */
export function runDetail(run: EvidenceRun): string {
  const output = run.output as Record<string, unknown> | null;
  if (run.status === 'failed')
    return (output?.error as { message?: string } | undefined)?.message ?? 'Failed';
  switch (run.kind) {
    case 'segment': {
      const s = run.output as Segmentation;
      return `"${s.concept}" · ${s.detections.length} mask${s.detections.length === 1 ? '' : 's'}`;
    }
    case 'discover': {
      const s = run.output as Scene;
      return `${s.objects.length} object${s.objects.length === 1 ? '' : 's'}: ${s.objects.map((o) => o.label).join(', ')}`;
    }
    case 'scene': {
      const g = run.output as SceneGuess;
      return `${g.kind} · ${g.visibleProps.length} prop${g.visibleProps.length === 1 ? '' : 's'} seen`;
    }
    case 'layout': {
      const l = run.output as { draft: { items: unknown[]; summary: string } };
      return `${l.draft.items.length} templates · ${l.draft.summary}`;
    }
    case 'item': {
      const item = run.output as SavedItem;
      return `${item.label} · ${item.parts.length} parts · ${item.source}`;
    }
    case 'fixture': {
      // A scan maps several things, a picture find locates them, and a draft models one.
      if (run.output && typeof run.output === 'object' && 'sculpted' in run.output) {
        const o = run.output as unknown as { label: string; parts: number; iou: number };
        return `${o.label} modelled with AI · ${o.parts} parts · overlap ${Math.round(o.iou * 100)}%`;
      }
      if (run.output && typeof run.output === 'object' && 'found' in run.output) {
        const { found } = run.output as PictureFind;
        return `found on the picture · ${found.filter((f) => f.seen).length} of ${found.length}`;
      }
      if (run.output && typeof run.output === 'object' && 'mapped' in run.output) {
        const { mapped } = run.output as { mapped: MappedThing[] };
        const added = mapped.filter((m) => m.fixture).length;
        return `scan · ${mapped.length} found · ${added} added${mapped.length ? `: ${mapped.map((m) => m.label).join(', ')}` : ''}`;
      }
      if (run.output && typeof run.output === 'object' && 'views' in run.output) {
        const o = run.output as unknown as { model: { label: string }; views: number; iou: number };
        return `${o.model.label} · another photo, ${o.views} views fused · ${Math.round(o.iou * 100)}% outline match`;
      }
      if (run.output && typeof run.output === 'object' && 'shaped' in run.output) {
        const o = run.output as unknown as { item: { label: string }; kept: boolean; iou: number };
        return `${o.item.label} · SAM 3D shape ${o.kept ? 'kept' : 'not kept'} · ${Math.round(o.iou * 100)}% outline match`;
      }
      const f = run.output as FixtureDraft;
      if (!f?.model) return '';
      return `${f.label} · ${f.model.parts.length} parts · looks like ${f.suggested === 'none' ? 'just a thing' : `a ${f.suggested}`}`;
    }
    case 'lamp':
      return `state ${(run.output as LampResult).state}`;
    case 'placement': {
      const p = run.output as PlacementDecision;
      return `${p.decision} · lamp ${p.action}`;
    }
    default:
      return '';
  }
}
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
