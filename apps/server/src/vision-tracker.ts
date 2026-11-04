import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LumaFrame, UnitBox } from '@livinglayer/domain';
import { PROJECT_ROOT } from './config.js';

const SOURCE = join(PROJECT_ROOT, 'services/vision-tracker/main.swift');
/** Vision's boxes below this confidence aren't passed on. */
const MIN_CONFIDENCE = 0.3;
/** A frame the helper hasn't answered by then goes on without its boxes. */
const STEP_TIMEOUT_MS = 250;

/** Where the helper is built: by its source's hash, so a change to it builds it again. */
export function visionTrackerBinary(dataDir: string) {
  const hash = createHash('sha256').update(readFileSync(SOURCE)).digest('hex').slice(0, 12);
  return join(dataDir, 'bin', `vision-tracker-${hash}`);
}

/**
 * Apple Vision's object tracker in a small Swift helper, on Apple silicon
 * only (`VISION_TRACKER`). It tells the watcher where to look for a thing
 * that moved: the template match searches there first and still decides
 * (`stepLocalTrack`'s `hint`). About 0.35 ms a thing at the watcher's
 * 320 × 240, a few MB, and nothing to download: it is part of macOS.
 */
export class VisionTracker {
  private queue = Promise.resolve();
  private lines: AsyncIterator<string>;
  private dead = false;
  private constructor(private proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>) {
    this.lines = readLines(proc.stdout);
    void proc.exited.then(() => (this.dead = true));
  }
  /** Runs `command`, which speaks the helper's protocol; tests pass a stand-in. */
  static spawn(command: string[]): VisionTracker {
    return new VisionTracker(
      Bun.spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' }),
    );
  }
  /**
   * The helper, built with `swiftc` the first time (a few seconds), or null
   * off Apple silicon, without Xcode's command line tools, or when it won't
   * build. Never throws.
   */
  static async load(dataDir: string): Promise<VisionTracker | null> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return null;
    try {
      const binary = visionTrackerBinary(dataDir);
      if (!existsSync(binary)) {
        const swiftc = Bun.which('swiftc');
        if (!swiftc) return null;
        mkdirSync(join(dataDir, 'bin'), { recursive: true });
        const building = `${binary}.building`;
        const build = Bun.spawn([swiftc, '-O', SOURCE, '-o', building], {
          stdout: 'ignore',
          stderr: 'ignore',
        });
        if ((await build.exited) !== 0) return null;
        renameSync(building, binary);
        // Builds of an older source aren't run again.
        for (const name of readdirSync(join(dataDir, 'bin')))
          if (name.startsWith('vision-tracker-') && join(dataDir, 'bin', name) !== binary)
            rmSync(join(dataDir, 'bin', name), { force: true });
      }
      return VisionTracker.spawn([binary]);
    } catch {
      return null;
    }
  }
  /**
   * Where Vision sees each thing in `frame`, started from or carried on from
   * `boxes`. Things it lost, or isn't sure of, are left out; so is everything
   * when the helper is slow or has stopped. One frame at a time.
   */
  step(frame: LumaFrame, boxes: ReadonlyMap<string, UnitBox>): Promise<Map<string, UnitBox>> {
    const next = this.queue.then(() => this.run(frame, boxes));
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private async run(frame: LumaFrame, boxes: ReadonlyMap<string, UnitBox>) {
    const seen = new Map<string, UnitBox>();
    if (this.dead || !boxes.size) return seen;
    const things = [...boxes].map(([id, b]) => ({ id, box: [b.x, b.y, b.width, b.height] }));
    const header = JSON.stringify({ width: frame.width, height: frame.height, things });
    this.proc.stdin.write(`${header}\n`);
    this.proc.stdin.write(frame.data);
    this.proc.stdin.flush();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(
      (resolve) => (timer = setTimeout(() => resolve(null), STEP_TIMEOUT_MS)),
    );
    const line = await Promise.race([this.lines.next(), late]);
    clearTimeout(timer);
    // Too slow: its answers would arrive a frame behind from now on, so it is stopped.
    if (!line) this.close();
    if (!line || line.done) return seen;
    const answer = JSON.parse(line.value) as { boxes: Record<string, number[]> };
    for (const [id, [x, y, width, height, confidence]] of Object.entries(answer.boxes))
      if (boxes.has(id) && confidence! >= MIN_CONFIDENCE)
        seen.set(id, { x: x!, y: y!, width: width!, height: height! });
    return seen;
  }
  close() {
    this.dead = true;
    this.proc.kill();
  }
}

async function* readLines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = text.indexOf('\n')) >= 0) {
      yield text.slice(0, end);
      text = text.slice(end + 1);
    }
  }
}
