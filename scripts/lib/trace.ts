/**
 * A failed browser test, explained on one screen, from what Playwright keeps
 * in its results folder: `trace.zip` and `error-context.md`
 * ([plan](../../docs/plans/agent-tooling.md#b-the-browser-suite-as-a-normal-check-blocks-2-3-9)).
 * It prints the failing step and its locator, the steps before it with their
 * timing, interleaved with the `/api` requests, console errors and warnings,
 * page errors and modal dialogs opening and closing, and the page snapshot
 * cut down to the region the locator points into (plus any open dialog).
 *
 * The zip is read with `unzip -p`. Its formats are Playwright's own: these
 * readers keep to the few fields they need and skip anything else.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

interface TraceEvent {
  type: string;
  callId?: string;
  parentId?: string;
  startTime?: number;
  endTime?: number;
  time?: number;
  title?: string;
  subtitle?: string;
  method?: string;
  class?: string;
  error?: { message?: string };
  stack?: { file: string; line: number; column: number }[];
  messageType?: string;
  text?: string;
  location?: { url?: string };
  params?: Record<string, unknown>;
  snapshot?: {
    callId?: string;
    timestamp?: number;
    html?: unknown;
    _monotonicTime?: number;
    time?: number;
    request?: { method: string; url: string };
    response?: { status: number; content?: { size?: number }; _failureText?: string };
  };
}

/** The trace's files of one kind (`.trace`, `.network`), as JSON lines. */
function entries(zip: string, suffix: string): TraceEvent[] {
  const list = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  if (list.status !== 0) return [];
  return list.stdout
    .split('\n')
    .filter((name) => name.endsWith(suffix) && !name.includes('/'))
    .flatMap((name) =>
      spawnSync('unzip', ['-p', zip, name], { encoding: 'utf8', maxBuffer: 1 << 30 })
        .stdout.split('\n')
        .flatMap((line) => {
          try {
            return line ? [JSON.parse(line) as TraceEvent] : [];
          } catch {
            return [];
          }
        }),
    );
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** One line of the timeline, at a time in ms on the trace's clock. */
interface Line {
  at: number;
  text: string;
}

/**
 * Modal dialogs opening and closing, from the DOM snapshots. Snapshots are
 * incremental, so a dialog shows up only in one where it changed: with
 * Playwright's open marker it is open (modal), without it closed.
 */
function dialogChanges(events: TraceEvent[]): Line[] {
  const out: Line[] = [];
  const state = new Map<string, boolean>();
  const titles = new Map<string, string>();
  const textOf = (node: unknown): string =>
    typeof node === 'string'
      ? node
      : Array.isArray(node) && typeof node[0] === 'string'
        ? node.slice(2).map(textOf).join('')
        : '';
  const walk = (node: unknown, at: number) => {
    if (!Array.isArray(node)) return;
    const [tag, attrs] = node as [unknown, Record<string, string> | undefined];
    if (typeof tag !== 'string') return node.forEach((n) => walk(n, at));
    if (attrs && typeof attrs === 'object' && attrs.id) {
      const text = textOf(node).trim();
      if (text) titles.set(attrs.id, text.slice(0, 60));
    }
    if (tag === 'DIALOG' && attrs && typeof attrs === 'object') {
      const key = attrs['aria-labelledby'] ?? attrs['aria-label'] ?? attrs.class ?? 'dialog';
      // Children first, so its title is known by the time it's named.
      node.slice(2).forEach((n) => walk(n, at));
      const open = '__playwright_dialog_open_' in attrs;
      const kind = attrs.__playwright_dialog_open_ === 'modal' ? 'modal ' : '';
      if (state.get(key) !== open) {
        state.set(key, open);
        const name = attrs['aria-label'] ?? titles.get(attrs['aria-labelledby'] ?? '') ?? key;
        const busy = attrs['aria-busy'] === 'true' ? ', busy' : '';
        out.push({
          at,
          text: open
            ? `▣ ${kind}dialog "${name}" open${busy}: the rest of the page is inert`
            : `▢ dialog "${name}" closed`,
        });
      }
      return;
    }
    node.slice(2).forEach((n) => walk(n, at));
  };
  for (const e of events)
    if (e.type === 'frame-snapshot' && e.snapshot?.timestamp !== undefined)
      walk(e.snapshot.html, e.snapshot.timestamp);
  return out;
}

/** The YAML subtree under the first line matching `match`, at most `max` lines. */
function subtree(yaml: string[], match: (line: string) => boolean, max: number): string[] {
  const i = yaml.findIndex(match);
  if (i < 0) return [];
  const indent = yaml[i]!.search(/\S/);
  const end = yaml.findIndex((l, j) => j > i && l.search(/\S/) <= indent && l.trim());
  const lines = yaml.slice(i, end < 0 ? undefined : end).map((l) => l.slice(indent));
  return lines.length > max
    ? [...lines.slice(0, max), `… ${lines.length - max} more lines`]
    : lines;
}

/** Where a locator points: the first role and name, or label, or text it starts from. */
function anchor(locator: string): ((line: string) => boolean) | null {
  const role = /getByRole\('([^']+)'(?:, \{ name: (?:'([^']*)'|\/([^/]*)\/))?/.exec(locator);
  if (role) {
    const [, r, name, pattern] = role;
    return (l) =>
      l.trimStart().startsWith(`- ${r}`) &&
      (name ? l.includes(`"${name}"`) : pattern ? new RegExp(pattern).test(l) : true);
  }
  const text = /getBy(?:Label|Text|Placeholder|AltText|Title)\('([^']+)'/.exec(locator);
  return text ? (l) => l.includes(text[1]!) : null;
}

export interface TraceOptions {
  /** Paths in stacks are shown relative to this (the worktree the test ran in). */
  root?: string;
  /** How many steps before the failing one (default 12). */
  before?: number;
}

/** The lines that explain a failed test, from its results folder. */
export function traceSummary(folder: string, { root, before = 12 }: TraceOptions = {}): string[] {
  const zip = join(folder, 'trace.zip');
  const contextFile = join(folder, 'error-context.md');
  const context = existsSync(contextFile) ? readFileSync(contextFile, 'utf8') : '';
  if (!existsSync(zip)) {
    const details = /# Error details\s+```\n([\s\S]*?)```/.exec(context)?.[1];
    return [details ? plain(details).trim() : `no trace.zip in ${folder}`];
  }
  const test = entries(zip, 'test.trace');
  const library = entries(zip, '-trace.trace');
  const network = entries(zip, '.network');
  const where = (e: TraceEvent) => {
    const frame = e.stack?.find((s) => !s.file.includes('node_modules'));
    if (!frame) return '';
    // The worktree it ran in may be gone: from tests/ on reads the same anywhere.
    const file = root ? relative(root, frame.file) : frame.file.replace(/^.*?\/(?=tests\/)/, '');
    return `${file}:${frame.line}`;
  };

  // The spec's own steps: Playwright calls, expects and `test.step`s (a helper's wait, say),
  // not hooks, fixtures or what runs inside any of those.
  const ends = new Map(test.filter((e) => e.type === 'after').map((e) => [e.callId!, e]));
  const own = (e: TraceEvent) =>
    e.method === 'pw:api' || e.method === 'expect' || e.method === 'test.step';
  const steps = test
    .filter((e) => e.type === 'before' && own(e) && !e.parentId)
    .map((e) => ({ ...e, end: ends.get(e.callId!) }));
  const failed = steps.findLast((s) => s.end?.error) ?? steps.at(-1);
  const t0 = steps[0]?.startTime ?? 0;
  const secs = (t: number) => `${((t - t0) / 1000).toFixed(2).padStart(6)}s`;
  const error =
    test.find((e) => e.type === 'error')?.error?.message ??
    (test.find((e) => e.type === 'error') as { message?: string } | undefined)?.message ??
    failed?.end?.error?.message ??
    '';

  const out: string[] = [];
  const message = plain(error).split('\nCall log:')[0]!.trim().split('\n').slice(0, 6);
  out.push(...message);
  if (failed)
    out.push(
      '',
      `failing step  ${failed.title}${failed.subtitle ? `  ${failed.subtitle}` : ''}`,
      `              at ${where(failed)}, ${(((failed.end?.endTime ?? failed.startTime!) - failed.startTime!) / 1000).toFixed(1)}s`,
    );

  // The timeline from a few steps before the failure to its end.
  const shown = failed
    ? steps.slice(Math.max(0, steps.indexOf(failed) - before), steps.indexOf(failed) + 1)
    : [];
  const from = shown[0]?.startTime ?? t0;
  const to = failed?.end?.endTime ?? Infinity;
  const timeline: Line[] = shown.map((s) => ({
    at: s.startTime!,
    text: `${s === failed ? '✗' : '·'} ${s.title}${s.subtitle ? `  ${s.subtitle.slice(0, 110)}` : ''}  ${(((s.end?.endTime ?? s.startTime!) - s.startTime!) / 1000).toFixed(2)}s`,
  }));
  for (const e of network) {
    const s = e.snapshot;
    if (!s?.request || s._monotonicTime === undefined) continue;
    const url = new URL(s.request.url);
    if (!url.pathname.startsWith('/api/')) continue;
    // The page's event streams stay open all along: noise here.
    if (url.pathname.endsWith('/events') || url.pathname === '/api/streams') continue;
    const size = s.response?.content?.size;
    const status = s.response?._failureText ?? s.response?.status ?? '…';
    timeline.push({
      at: s._monotonicTime,
      text: `→ ${s.request.method} ${url.pathname}${url.search} ${status}${size !== undefined && size >= 0 ? ` ${size} B` : ''} ${((s.time ?? 0) / 1000).toFixed(2)}s`,
    });
  }
  for (const e of library) {
    if (e.type === 'console' && (e.messageType === 'error' || e.messageType === 'warning'))
      timeline.push({
        at: e.time!,
        text: `! console.${e.messageType === 'warning' ? 'warn' : 'error'}: ${e.text?.slice(0, 160)}${e.location?.url ? `  (${new URL(e.location.url).pathname})` : ''}`,
      });
    if (e.type === 'event' && e.method === 'pageError')
      timeline.push({
        at: e.time!,
        text: `! page error: ${String((e.params?.error as { error?: { message?: string } })?.error?.message ?? JSON.stringify(e.params)).slice(0, 160)}`,
      });
  }
  timeline.push(...dialogChanges(library));
  const window = timeline
    .filter((l) => l.at >= from - 1 && l.at <= to + 1)
    .sort((a, b) => a.at - b.at);
  if (window.length)
    out.push('', 'what happened', ...window.map((l) => `${secs(l.at)}  ${l.text}`));
  // The trap that cost the most: acting on the page while a modal dialog made it inert.
  let modal: string | null = null;
  const blind = new Set<string>();
  for (const l of window) {
    if (l.text.startsWith('▣ modal')) modal = /"([^"]*)"/.exec(l.text)?.[1] ?? 'dialog';
    else if (l.text.startsWith('▢')) modal = null;
    else if (modal && /^[·✗] (Fill|Press|Click|Type|Check)/.test(l.text)) blind.add(modal);
  }
  for (const name of blind)
    out.push(
      `  ! steps acted on the page while the modal "${name}" dialog was open: wait for it first (waitForAiTask in tests/browser/helpers.ts)`,
    );

  // The page as the failure left it, around what the locator points into.
  const yaml = /# Page snapshot\s+```yaml\n([\s\S]*?)```/.exec(context)?.[1]?.split('\n') ?? [];
  if (yaml.length) {
    const dialog = subtree(yaml, (l) => /^\s*- dialog\b/.test(l), 14);
    if (dialog.length) out.push('', 'open dialog at the failure', ...dialog.map((l) => `  ${l}`));
    const match = failed?.subtitle ? anchor(failed.subtitle) : null;
    const region = match ? subtree(yaml, match, 24) : [];
    out.push(
      '',
      region.length
        ? `page at the failure, where the locator points`
        : `page at the failure${match ? ' (the locator’s start isn’t in it)' : ''}`,
      ...(region.length ? region : yaml.slice(0, 16)).map((l) => `  ${l}`),
    );
  }
  return out;
}

/** Results folders with a failure in them, newest first: from `bun run browser` and plain `playwright test`. */
export function failureFolders(roots: string[]): string[] {
  const found: { dir: string; at: number }[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const r = spawnSync('find', [root, '-maxdepth', '2', '-name', 'error-context.md'], {
      encoding: 'utf8',
    });
    for (const file of r.stdout.split('\n').filter(Boolean)) {
      const dir = join(file, '..');
      found.push({ dir, at: Bun.file(file).lastModified });
    }
  }
  return found.sort((a, b) => b.at - a.at).map((f) => f.dir);
}

/** The test's name, from its error context. */
export const testName = (folder: string) => {
  const file = join(folder, 'error-context.md');
  return existsSync(file)
    ? (/- Name: (.*)/.exec(readFileSync(file, 'utf8'))?.[1]?.trim() ?? folder)
    : folder;
};
