/**
 * The director of `bun run shot`: drives the lab in a fresh Chrome through a
 * shot, captures the page over the DevTools screencast at 2×, and logs each
 * beat (a line said, a zoom target, a lower third, a speed change) for the
 * compose step. The voice paces the take: `say` waits for its line's length,
 * which is the voice file's when there is one, else an estimate.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
} from '@playwright/test';
import { installPointerMarks } from '../../apps/web/src/pointer-marks.js';
import { estimateSeconds, type Beat, type Box, type Size, type Take } from './demo-shot.js';
import { ffmpegArgs, framesDue } from './record.js';

export const LAB = 'http://127.0.0.1:43430';
const API = 'http://127.0.0.1:43431';

export interface Shot {
  name: string;
  /** Where it sits in docs/demo-video.md, e.g. "0:15"; the film is cut in this order. */
  at: string;
  /** What it shows, for listings. */
  about: string;
  /** The voice over, one entry a line; captions are these words. */
  lines: string[];
  /** Off camera: from a fresh demo to the shot's first frame. */
  setup(d: Director): Promise<void>;
  /** On camera. */
  run(d: Director): Promise<void>;
  /** Off camera, after the cut: undo what the take left (a Live shot leaves the lab as it found it). */
  after?(d: Director): Promise<void>;
}

export interface DirectorOptions {
  view: Size;
  scale: number;
  fps: number;
  /** Where the voice files are: `<dir>/<shot>/<n>.wav`, n from 1. */
  voiceDir: string;
  /** The shot's folder: the take, or what the page showed when it failed. */
  dir: string;
  /** False to rehearse: drive the lab, capture nothing. */
  record: boolean;
  /** Say cues aloud and wait for them (`--cue`), for a take that needs a hand in the room. */
  cues?: boolean;
}

/** A line's voice file, if it has been recorded. */
export const voiceFile = (voiceDir: string, shot: string, i: number) =>
  ['wav', 'm4a', 'mp3', 'aiff']
    .map((ext) => join(voiceDir, shot, `${i + 1}.${ext}`))
    .find(existsSync);

export function audioSeconds(file: string): number {
  const probe = spawnSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  const s = Number(String(probe.stdout).trim());
  if (!(s > 0)) throw new Error(`Can't read the length of ${file}`);
  return s;
}

/** Each line's length: its voice file's, or the estimate until it has one. */
export function lineSeconds(shot: Shot, voiceDir: string): number[] {
  return shot.lines.map((text, i) => {
    const file = voiceFile(voiceDir, shot.name, i);
    return file ? audioSeconds(file) : estimateSeconds(text);
  });
}

export class Director {
  readonly beats: Beat[] = [];
  page!: Page;
  private context!: BrowserContext;
  private profile = '';
  private started = 0;
  private pointer = { x: 0, y: 0 };
  private durations: number[];
  private stopRecording: (() => Promise<void>) | null = null;

  constructor(
    readonly shot: Shot,
    readonly options: DirectorOptions,
  ) {
    this.durations = lineSeconds(shot, options.voiceDir);
    this.pointer = { x: options.view.width * 0.62, y: options.view.height * 0.55 };
  }

  async open() {
    const { view, scale } = this.options;
    this.profile = mkdtempSync(join(tmpdir(), 'lab-shot-'));
    this.context = await chromium.launchPersistentContext(this.profile, {
      headless: true,
      channel: 'chrome',
      viewport: view,
      deviceScaleFactor: scale,
      // A headless screencast arrives at CSS pixels unless the scale is forced.
      args: [`--force-device-scale-factor=${scale}`, '--hide-scrollbars'],
    });
    await this.context.addInitScript(
      `(() => { const marks = ${installPointerMarks.toString()}; if (document.documentElement) marks(); else addEventListener('DOMContentLoaded', marks); })()`,
    );
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
  }

  /** The demo back to its preset, the lab open in Demo mode on its first screen. */
  async freshDemo() {
    const res = await fetch(`${API}/api/desk/demo/reset`, { method: 'POST' });
    if (!res.ok) throw new Error(`Resetting the demo: ${res.status} ${await res.text()}`);
    // ?recording hides the dev server's reload card.
    await this.page.goto(`${LAB}/?recording`);
    await this.page.getByRole('button', { name: 'Demo', exact: true }).click({ timeout: 20_000 });
  }

  /**
   * The lab open in Live, as it is: nothing is reset, so a Live shot shows the
   * real room and changes only what it does on camera.
   */
  async live() {
    await this.page.goto(`${LAB}/?recording`);
    const live = this.page
      .getByRole('group', { name: 'Data source' })
      .getByRole('button', { name: 'Live', exact: true });
    await live.waitFor({ timeout: 20_000 });
    if ((await live.getAttribute('aria-pressed')) !== 'true') await live.click();
  }

  /** Start capturing. Everything before this is off camera. */
  async roll() {
    await this.page.mouse.move(this.pointer.x, this.pointer.y);
    // Let the set-up's transitions and toasts settle before the first frame.
    await this.page.waitForTimeout(1200);
    const dir = this.options.dir;
    if (!this.options.record) {
      this.started = performance.now();
      return;
    }
    const { fps, view, scale } = this.options;
    const ffmpeg = spawn('ffmpeg', ffmpegArgs(join(dir, 'take.mp4'), fps, 14), {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    const encoded = new Promise<number | null>((done) => ffmpeg.on('close', done));
    let latest: Buffer | undefined;
    let written = 0;
    const cdp: CDPSession = await this.context.newCDPSession(this.page);
    cdp.on('Page.screencastFrame', (f) => {
      latest = Buffer.from(f.data, 'base64');
      if (!this.started) this.started = performance.now();
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 92,
      maxWidth: view.width * scale,
      maxHeight: view.height * scale,
    });
    // The screencast sends a frame only when the page changes: write the latest at a steady rate.
    const tick = setInterval(
      () => {
        if (!latest || !this.started) return;
        for (let n = framesDue(performance.now() - this.started, written, fps); n > 0; n--) {
          ffmpeg.stdin.write(latest);
          written++;
        }
      },
      1000 / fps / 2,
    );
    while (!this.started) await this.page.waitForTimeout(20);
    this.stopRecording = async () => {
      clearInterval(tick);
      await cdp.send('Page.stopScreencast').catch(() => {});
      ffmpeg.stdin.end();
      if ((await encoded) !== 0 || !written) throw new Error('ffmpeg could not encode the take');
    };
  }

  /** Stop, and what compose needs. */
  async cut(): Promise<Take> {
    const length = this.now();
    await this.stopRecording?.();
    const { view, scale, fps } = this.options;
    return { shot: this.shot.name, view, scale, fps, length, beats: this.beats };
  }

  async close(failed?: unknown) {
    if (failed && this.page) await this.snap('failed');
    await this.context?.close().catch(() => {});
    if (this.profile) rmSync(this.profile, { recursive: true, force: true });
  }

  /** The page now, as `<name>.png` and its accessibility tree as `<name>.yaml`, for writing a shot. */
  async snap(name: string) {
    await this.page
      .screenshot({ path: join(this.options.dir, `${name}.png`), scale: 'css' })
      .catch(() => {});
    const tree = await this.page
      .locator('body')
      .ariaSnapshot()
      .catch(() => '');
    await Bun.write(join(this.options.dir, `${name}.yaml`), tree);
  }

  // ---- The shot's vocabulary ----

  /** Seconds since rolling. */
  now = () => (this.started ? (performance.now() - this.started) / 1000 : 0);
  wait = (seconds: number) => this.page.waitForTimeout(seconds * 1000);

  /** Say line i and wait for it, plus a breath. */
  async say(i: number, breath = 0.35) {
    const end = this.sayOver(i);
    await this.until(end + breath);
  }

  /** Start line i and carry on; returns the take time it ends at (for `until`). */
  sayOver(i: number): number {
    const dur = this.durations[i];
    if (dur === undefined) throw new Error(`${this.shot.name} has no line ${i}`);
    const t = this.now();
    this.beats.push({ kind: 'line', t, i, dur });
    return t + dur;
  }

  /** Wait until take time t (e.g. the end of a line started with sayOver). */
  async until(t: number) {
    const left = t - this.now();
    if (left > 0) await this.wait(left);
  }

  /** Ease the camera to a thing (or `part` of it), or back to the whole page with null. */
  async focus(
    target: Locator | null,
    { pad = 24, part }: { pad?: number; part?: (b: Box) => Box } = {},
  ) {
    const raw = target ? await target.boundingBox() : null;
    if (target && !raw) throw new Error(`focus: ${target} is not on screen`);
    const b = raw && part ? part(raw) : raw;
    this.beats.push({
      kind: 'focus',
      t: this.now(),
      box: b && {
        x: b.x - pad,
        y: b.y - pad,
        width: b.width + 2 * pad,
        height: b.height + 2 * pad,
      },
    });
  }

  lower(title: string, sub: string, dur = 3.4) {
    this.beats.push({ kind: 'lower', t: this.now() + 0.2, dur, title, sub });
  }

  title(text: string, sub = '', dur = 2.6) {
    this.beats.push({ kind: 'title', t: this.now(), dur, text, sub });
  }

  /** From now the cut plays `speed` times faster (setup and waits); `fast(1)` ends it. */
  fast(speed = 3) {
    this.beats.push({ kind: 'speed', t: this.now(), speed });
  }

  /** Glide the pointer to a point, eased, as a hand would. */
  async glide(x: number, y: number, seconds = 0.5) {
    const from = this.pointer;
    const steps = Math.max(8, Math.round(seconds * 60));
    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      const e = u * u * (3 - 2 * u);
      await this.page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await this.page.waitForTimeout((seconds * 1000) / steps);
    }
    this.pointer = { x, y };
  }

  private async centre(target: Locator) {
    await target.waitFor({ state: 'visible', timeout: 20_000 });
    await target.scrollIntoViewIfNeeded();
    const b = (await target.boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }

  /** Glide to a thing and click it. */
  async click(target: Locator) {
    const at = await this.centre(target);
    await this.glide(at.x, at.y);
    await this.page.waitForTimeout(120);
    await this.page.mouse.down();
    await this.page.waitForTimeout(70);
    await this.page.mouse.up();
  }

  /** Glide to a point and drag to another (page pixels), slowly enough to read. */
  async drag(from: { x: number; y: number }, to: { x: number; y: number }, seconds = 0.8) {
    await this.glide(from.x, from.y);
    await this.page.mouse.down();
    await this.glide(to.x, to.y, seconds);
    await this.page.waitForTimeout(80);
    await this.page.mouse.up();
  }

  /** Click a field and type over what is in it, at a human pace. */
  async type(target: Locator, text: string, perKey = 0.045) {
    await this.click(target);
    await this.page.keyboard.press('ControlOrMeta+a');
    await this.page.keyboard.type(text, { delay: perKey * 1000 });
  }

  /**
   * A cue for whoever is in the room, said aloud: true when cues are on
   * (`--cue`) and the shot should wait for it, false to go on without.
   */
  prompt(text: string): boolean {
    if (!this.options.cues) return false;
    console.log(`  cue: ${text}`);
    spawn('say', [text], { stdio: 'ignore' });
    return true;
  }

  /** Wait for the app (a thing shown, a run done), up to `timeout` seconds. */
  async cue(target: Locator, timeout = 30) {
    await target.waitFor({ state: 'visible', timeout: timeout * 1000 });
  }

  /**
   * Wait for an AI task's steps dialog to finish, then close it with its Done
   * (a clean finish may close itself first). Throws with the reason if it failed.
   */
  async task(title: string | RegExp, { timeout = 60, close = true } = {}) {
    const dialog = this.page.getByRole('dialog', { name: title });
    await dialog.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const end = Date.now() + timeout * 1000;
    while ((await dialog.count()) && (await dialog.getAttribute('aria-busy')) === 'true') {
      if (Date.now() > end)
        throw new Error(`The AI task "${title}" is still running after ${timeout} s`);
      await this.page.waitForTimeout(100);
    }
    if ((await dialog.count()) && (await dialog.evaluate((el) => el.classList.contains('failed'))))
      throw new Error(`The AI task "${title}" failed: ${await dialog.innerText()}`);
    if (!close || !(await dialog.count())) return;
    await this.click(dialog.getByRole('button', { name: /^(Done|Close)$/ }).last()).catch(
      async (e: unknown) => {
        if (await dialog.count()) throw e;
      },
    );
    await dialog.waitFor({ state: 'detached', timeout: 5000 });
  }

  // ---- Places in the lab ----

  /** A row or button of the scene outline (left). */
  outline(name: string | RegExp) {
    return this.page
      .getByRole('complementary', { name: 'Scene outline' })
      .getByRole('button', { name, exact: typeof name === 'string' });
  }
  inspector() {
    return this.page.getByRole('complementary', { name: 'Inspector' });
  }
  iso() {
    return this.page.getByRole('img', { name: /Isometric/ });
  }
  button(name: string | RegExp) {
    return this.page.getByRole('button', { name, exact: typeof name === 'string' });
  }
}
