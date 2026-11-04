/**
 * The film as scenes (docs/demo-video.md): each scene is recorded and judged
 * on its own, then the film joins them. A scene is a run of parts, cut one
 * after another: a scripted shot's cut (`bun run shot <name>`), a clip filmed
 * elsewhere (the phone), or a card. Its own lines (captions, and voice once
 * recorded) and lower thirds are timed from the scene's start, over whatever
 * part is on screen; a shot's own lines come with its cut.
 */
import type { Beat, Size } from './demo-shot.js';

export type Part =
  /** A scripted shot's cut, `out/demo-video/<shot>/cut.mp4`. */
  | { shot: string }
  /**
   * A clip filmed elsewhere, under `out/demo-video/` (e.g. `phone/plushie/1.mov`),
   * trimmed to `from`…`to` seconds and played `speed` times faster. Until it
   * exists, a slate of `seconds` says what to film (`note`).
   */
  | {
      clip: string;
      note: string;
      seconds: number;
      from?: number;
      to?: number;
      speed?: number;
      /** Keep the clip's own sound (a click, the room); off by default. */
      sound?: boolean;
    }
  /** Text on black: `typed` a letter at a time, or `plain`. */
  | { card: string; sub?: string; seconds: number; look?: 'plain' | 'typed' };

export interface SceneLine {
  text: string;
  /** Seconds from the scene's start. */
  at: number;
}
export interface SceneLower {
  title: string;
  sub: string;
  at: number;
  seconds?: number;
}
export interface Scene {
  /** Short and unique; also its voice folder, `voice/<name>/<n>.wav`. */
  name: string;
  /** Its number and title in docs/demo-video.md. */
  title: string;
  parts: Part[];
  lines?: SceneLine[];
  lowers?: SceneLower[];
}

/** Where each part starts in its scene, and the scene's length. */
export function timeline(lengths: number[]): { starts: number[]; length: number } {
  const starts: number[] = [];
  let at = 0;
  for (const len of lengths) {
    starts.push(at);
    at += len;
  }
  return { starts, length: at };
}

/** A clip's length on screen: its trimmed span at its speed. */
export function clipSeconds(part: Extract<Part, { clip: string }>, fileSeconds: number): number {
  const from = part.from ?? 0;
  const to = Math.min(part.to ?? fileSeconds, fileSeconds);
  return Math.max(0, to - from) / (part.speed ?? 1);
}

/**
 * The scene's overlays as beats at scene time: its cards, a slate for each
 * clip not filmed yet (and each shot not cut yet), its lines (each `seconds[i]`
 * long: the voice's, or an estimate) and its lower thirds.
 */
export function sceneBeats(
  scene: Scene,
  parts: { length: number; missing: string | null }[],
  seconds: number[],
): Beat[] {
  const { starts } = timeline(parts.map((p) => p.length));
  const beats: Beat[] = [];
  scene.parts.forEach((part, k) => {
    const t = starts[k]!;
    const dur = parts[k]!.length;
    if ('card' in part)
      beats.push({
        kind: 'card',
        t,
        dur,
        text: part.card,
        sub: part.sub ?? '',
        look: part.look ?? 'plain',
      });
    else if (parts[k]!.missing)
      beats.push({
        kind: 'card',
        t,
        dur,
        text: 'clip' in part ? `TO FILM · ${part.note}` : `TO CUT · bun run shot ${part.shot}`,
        sub: parts[k]!.missing!,
        look: 'slate',
      });
  });
  // A line's caption gives way to the next line's, so two never stack.
  const lines = scene.lines ?? [];
  lines.forEach((line, i) => {
    const next = lines[i + 1]?.at;
    const dur = next === undefined ? seconds[i]! : Math.min(seconds[i]!, next - line.at - 0.3);
    beats.push({ kind: 'line', t: line.at, i, dur });
  });
  for (const l of scene.lowers ?? [])
    beats.push({ kind: 'lower', t: l.at, dur: l.seconds ?? 3.2, title: l.title, sub: l.sub });
  return beats.sort((a, b) => a.t - b.t);
}

/**
 * ffmpeg's picture for a filmed clip: filled to `out` (cropped, never
 * letterboxed), at `fps`, played `speed` times faster.
 */
export function clipFilter(out: Size, fps: number, speed = 1): string {
  return [
    `scale=${out.width}:${out.height}:force_original_aspect_ratio=increase`,
    `crop=${out.width}:${out.height}`,
    'setsar=1',
    speed !== 1 ? `setpts=PTS/${speed}` : null,
    `fps=${fps}`,
    'format=yuv420p',
  ]
    .filter(Boolean)
    .join(',');
}
