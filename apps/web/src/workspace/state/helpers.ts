import type {
  EvidenceRun,
  RoomMarks,
  Segmentation,
  Detection,
  Job,
  DeskMemory,
  PlacementDecision,
  RunKind,
  DeskObservation,
  LumaFrame,
  UnitBox,
} from '@livinglayer/domain';
import { isRun, runFailure, toLuma } from '@livinglayer/domain';

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
const LUMA_WIDTH = 160;
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
const lumaCanvas = document.createElement('canvas');
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
type ProbeKind = 'text' | 'discover' | 'segment' | 'lamp';
export const isProbe = (kind: RunKind): kind is ProbeKind =>
  ['text', 'discover', 'segment', 'lamp'].includes(kind);

/** One short line on what a run returned, for the log and the inspector. */
export function runDetail(run: EvidenceRun): string {
  if (run.status === 'failed') return runFailure(run)?.message ?? 'Failed';
  if (isRun(run, 'segment')) {
    const s = run.output;
    return `"${s.concept}" · ${s.detections.length} mask${s.detections.length === 1 ? '' : 's'}`;
  }
  if (isRun(run, 'discover')) {
    const s = run.output;
    return `${s.objects.length} object${s.objects.length === 1 ? '' : 's'}: ${s.objects.map((o) => o.label).join(', ')}`;
  }
  if (isRun(run, 'scene')) {
    const g = run.output;
    return `${g.kind} · ${g.visibleProps.length} prop${g.visibleProps.length === 1 ? '' : 's'} seen`;
  }
  if (isRun(run, 'layout')) {
    const l = run.output;
    return `${l.draft.items.length} templates · ${l.draft.summary}`;
  }
  if (isRun(run, 'item')) {
    const item = run.output;
    return `${item.label} · ${item.parts.length} parts · ${item.source}`;
  }
  if (isRun(run, 'fixture')) {
    // A scan maps several things, a picture find locates them, and a draft models one.
    const o = run.output;
    if (!o || typeof o !== 'object') return '';
    if ('sculpted' in o)
      return `${o.label} modelled with AI · ${o.parts} parts · overlap ${Math.round(o.iou * 100)}%`;
    if ('found' in o)
      return `found on the picture · ${o.found.filter((f) => f.seen).length} of ${o.found.length}`;
    if ('mapped' in o) {
      const { mapped } = o;
      const added = mapped.filter((m) => m.fixture).length;
      return `scan · ${mapped.length} found · ${added} added${mapped.length ? `: ${mapped.map((m) => m.label).join(', ')}` : ''}`;
    }
    if ('views' in o)
      return `${o.model.label} · another photo, ${o.views} views fused · ${Math.round(o.iou * 100)}% outline match`;
    if ('shaped' in o)
      return `${o.item.label} · SAM 3D shape ${o.kept ? 'kept' : 'not kept'} · ${Math.round(o.iou * 100)}% outline match`;
    if (!o.model) return '';
    return `${o.label} · ${o.model.parts.length} parts · looks like ${o.suggested === 'none' ? 'just a thing' : `a ${o.suggested}`}`;
  }
  if (isRun(run, 'lamp')) return `state ${run.output.state}`;
  if (isRun(run, 'placement')) {
    // What the zone saw happen, then what its light did.
    const p = run.output;
    const what = p.transition?.replace('_', ' ') ?? p.decision;
    const light = p.lamp
      ? `${p.lamp.entityId} ${p.lamp.action ?? 'on'}: ${p.action}`
      : p.action === 'none'
        ? 'no light switched'
        : `light ${p.action}`;
    return `${what} · ${light}`;
  }
  return '';
}
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
