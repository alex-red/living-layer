/**
 * Record the web app as a clean video: a Chrome window with no address bar
 * or tabs, its page captured frame by frame over the DevTools screencast at
 * device resolution and encoded to an H.264 MP4. You drive the window; a
 * soft dot shows the pointer and rings on clicks. It needs a running dev
 * server (it doesn't start one) and ffmpeg.
 *
 *   bun run record                       the lab at 1440x900, 2x → out/recordings/<time>.mp4
 *   bun run record --size 1280x720 --scale 1 --fps 60
 *   bun run record --url http://127.0.0.1:43430/?demo --seconds 30 --out out/demo.mp4
 *   bun run record --no-cursor           no pointer dot (e.g. for a scripted take)
 *   bun run record --chromium            Playwright's Chromium instead of installed Chrome
 *
 * Stop with Ctrl+C, by closing the window, or after --seconds. Only the
 * first tab is recorded; links that open new tabs aren't.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { flag, has, parseArgs } from './lib/args.js';
import { installPointerMarks } from '../apps/web/src/pointer-marks.js';
import { ffmpegArgs, framesDue, parseSize, recordingName } from './lib/record.js';

const args = parseArgs();
const url = flag(args, 'url') ?? args.positional[0] ?? 'http://127.0.0.1:43430/';
const size = parseSize(flag(args, 'size') ?? '1440x900');
const scale = Number(flag(args, 'scale') ?? 2);
const fps = Number(flag(args, 'fps') ?? 30);
const seconds = flag(args, 'seconds') ? Number(flag(args, 'seconds')) : undefined;
const root = resolve(import.meta.dir, '..');
const out = resolve(
  flag(args, 'out') ?? resolve(root, 'out', 'recordings', recordingName(new Date())),
);

if (!(scale > 0) || !(fps > 0 && fps <= 60)) throw new Error('--scale > 0 and --fps 1–60');
if (!Bun.which('ffmpeg')) throw new Error('Needs ffmpeg on the PATH (brew install ffmpeg).');
try {
  await fetch(url, { signal: AbortSignal.timeout(3000) });
} catch {
  throw new Error(`Nothing answers at ${url}. Start the dev server (bun run dev) or pass --url.`);
}
mkdirSync(dirname(out), { recursive: true });

// A throwaway profile, so a take never starts with yesterday's tabs, logins or lab state.
const profile = mkdtempSync(join(tmpdir(), 'lab-record-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  ...(has(args, 'chromium') ? {} : { channel: 'chrome' }),
  viewport: size,
  deviceScaleFactor: scale,
  // An app window: the page alone, no address bar or tabs; and no "controlled by automated
  // software" bar.
  args: [
    '--app=about:blank',
    `--window-size=${size.width},${size.height + 40}`,
    '--hide-scrollbars',
  ],
  ignoreDefaultArgs: ['--enable-automation'],
});
// The same pointer dot and click rings as recording from the app's menu.
if (!has(args, 'no-cursor'))
  await context.addInitScript(
    `(() => { const marks = ${installPointerMarks.toString()}; if (document.documentElement) marks(); else addEventListener('DOMContentLoaded', marks); })()`,
  );
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url);
await page.bringToFront();

const ffmpeg = spawn('ffmpeg', ffmpegArgs(out, fps), { stdio: ['pipe', 'inherit', 'inherit'] });
const encoded = new Promise<number | null>((done) => ffmpeg.on('close', done));

let latest: Buffer | undefined;
let written = 0;
let started = 0;
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', (frame) => {
  latest = Buffer.from(frame.data, 'base64');
  if (!started) started = performance.now();
  void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 95,
  maxWidth: Math.round(size.width * scale),
  maxHeight: Math.round(size.height * scale),
  everyNthFrame: 1,
});

// The screencast sends frames only when the page changes; write the latest one at a steady rate.
const tick = setInterval(
  () => {
    if (!latest || !started) return;
    for (let n = framesDue(performance.now() - started, written, fps); n > 0; n--) {
      ffmpeg.stdin.write(latest);
      written++;
    }
  },
  1000 / fps / 2,
);

console.log(
  `Recording ${url} at ${size.width}x${size.height} ×${scale}, ${fps} fps → ${relative(root, out)}`,
);
console.log(seconds ? `Stops after ${seconds} s.` : 'Ctrl+C or close the window to stop.');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(tick);
  await cdp.send('Page.stopScreencast').catch(() => {});
  ffmpeg.stdin.end();
  const code = await encoded;
  await context.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
  if (code !== 0 || !written) {
    console.error(`ffmpeg exited ${code}; ${written} frames written.`);
    process.exit(1);
  }
  console.log(`→ ${relative(root, out)} (${(written / fps).toFixed(1)} s, ${written} frames)`);
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
page.on('close', stop);
context.on('close', stop);
if (seconds) setTimeout(stop, seconds * 1000);
