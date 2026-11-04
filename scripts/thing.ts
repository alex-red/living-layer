/**
 * Things in the running app, from the shell: what they are, and their models,
 * states and stats changed through the API, as the lab changes them. Things
 * are found by id or name, as `bun run model fixture:<name>` finds them.
 *
 *   bun run thing list                                  every thing, its state and states
 *   bun run thing show "cat tower"                      its size, states and stats
 *   bun run thing set "cat tower" .data/models/tower.ts                 its own model
 *   bun run thing set "cat tower" .data/models/sleeping.ts --state sleeping --activate
 *   bun run thing state "cat tower" sleeping            show that state (`none` for its own)
 *   bun run thing stat "cat tower" +occupied            switch a stat on (-occupied off)
 *
 * A model is any source `bun run model` reads, checked before it is sent
 * (`buildModel`); its height follows the model (`stateSizeFor`) unless
 * --size w,d,h is given. A set draws the thing before and after, as the room
 * does, to out/thing/<name>.png. --mode live|demo (live); --api <url> or
 * PORT (43431). It waits for the API while the dev server restarts.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import {
  buildModel,
  fixtureInput,
  fixtureSize,
  occupantOf,
  stateSizeFor,
  STAT_KEYS,
  type DeskMemory,
  type Fixture,
  type IsoItem,
  type Mode,
  type StatKey,
} from '@livinglayer/domain';
import { flag, has, parseArgs } from './lib/args.js';
import { pictureGrid } from './lib/image.js';
import { fixtureIn, loadModel, spritePng } from './lib/models.js';

const args = parseArgs();
const mode = (flag(args, 'mode') ?? 'live') as Mode;
const api = flag(args, 'api') ?? `http://127.0.0.1:${process.env.PORT ?? 43431}/api`;
/** How long to wait for the API to come back, ms: the dev server restarts on a commit. */
const WAIT_MS = 30_000;

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const until = Date.now() + WAIT_MS;
  for (let told = false; ;) {
    try {
      const res = await fetch(`${api}/${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`);
      return JSON.parse(text) as T;
    } catch (err) {
      const down = err instanceof TypeError || /ECONNREFUSED|Unable to connect/.test(String(err));
      if (!down || Date.now() > until) throw err;
      if (!told) console.log(`waiting for the API at ${api}…`);
      told = true;
      await Bun.sleep(1000);
    }
  }
}
const memory = () => call<DeskMemory>('GET', `desk/${mode}`);
const find = async (ref: string) => fixtureIn(await memory(), ref);

function summary(f: Fixture): string {
  const states = Object.keys(f.states ?? {});
  return `${f.label}  ${f.id.slice(0, 8)}  ${f.state ? `· ${f.state}` : ''}${states.length ? `  states: ${states.join(', ')}` : ''}`;
}

/** The thing as the room draws it in a state, before and after, side by side. */
async function beforeAfter(before: Fixture, after: Fixture, state: string | null) {
  const draw = async (f: Fixture) => {
    const model = state ? (f.states?.[state]?.model ?? f.model) : f.model;
    const size = fixtureSize(f, state);
    return (await spritePng(model, { preset: 'room', scale: size.w, cell: 360 })).png;
  };
  const picture = await pictureGrid([[await draw(before), await draw(after)]], ['before', 'after']);
  const dir = resolve('out/thing');
  mkdirSync(dir, { recursive: true });
  const slug = `${after.label}${state ? `-${state}` : ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const file = resolve(dir, `${slug}.png`);
  await sharp(picture).toFile(file);
  return file;
}

function sizeFlag(): Fixture['size'] | undefined {
  const raw = flag(args, 'size');
  if (!raw) return undefined;
  const [w, d, h] = raw.split(',').map(Number);
  if (![w, d, h].every((n) => n! > 0)) throw new Error(`--size ${raw}: expected w,d,h in tiles`);
  return { w: w!, d: d!, h: h! };
}

async function setModel(ref: string, source: string) {
  const before = await find(ref);
  const loaded = await loadModel(source, { mode });
  const state = flag(args, 'state') ?? null;
  const model: IsoItem = buildModel(loaded.item.label, loaded.item.parts);
  let after: Fixture;
  if (state) {
    const given = sizeFlag();
    after = await saveState(before.id, {
      state: has(args, 'activate') ? state : (before.state ?? null),
      add: state,
      fixture: { model, ...(given ? { size: given } : {}) },
    });
  } else {
    // Its own model: as much taller as the model is, unless a size is given.
    const size = sizeFlag() ?? stateSizeFor(before, model) ?? before.size;
    const saved = await call<DeskMemory>('POST', 'fixtures/save', {
      mode,
      fixture: { ...fixtureInput(before), model, size },
    });
    after = saved.fixtures!.find((f) => f.id === before.id)!;
  }
  console.log(summary(after));
  console.log(
    `${model.parts.length} parts · ${state ?? 'its own model'} · ${JSON.stringify(fixtureSize(after, state))}`,
  );
  console.log(await beforeAfter(before, after, state));
}

/** A state's model saved, then the shown state set: the route does both when they are the same. */
async function saveState(
  fixtureId: string,
  { state, add, fixture }: { state: string | null; add: string; fixture: unknown },
): Promise<Fixture> {
  let saved = await call<DeskMemory>('POST', 'fixtures/state', {
    mode,
    fixtureId,
    state: add,
    fixture,
  });
  if (state !== add)
    saved = await call<DeskMemory>('POST', 'fixtures/state', { mode, fixtureId, state });
  return saved.fixtures!.find((f) => f.id === fixtureId)!;
}

async function setStat(ref: string, change: string) {
  const f = await find(ref);
  const on = change.startsWith('+');
  const key = change.replace(/^[+-]/, '') as StatKey;
  if (!STAT_KEYS.includes(key))
    throw new Error(`No stat "${key}"; there are ${STAT_KEYS.join(', ')}`);
  const m = await memory();
  const now = (m.thingStats?.[f.id] ?? []).filter((s) => s.key !== key);
  const stats = on
    ? [...now, { key, ...(key === 'occupied' ? { concept: occupantOf(f.label) } : {}) }]
    : now;
  await call('POST', 'things/stats', { mode, id: f.id, stats });
  console.log(`${f.label}: ${stats.map((s) => s.key).join(', ') || 'no stats'}`);
}

const [command, ...rest] = args.positional;
switch (command) {
  case 'list':
    for (const f of (await memory()).fixtures ?? []) console.log(summary(f));
    break;
  case 'show': {
    const f = await find(rest[0] ?? '');
    const m = await memory();
    console.log(summary(f));
    console.log(`size ${JSON.stringify(f.size)} · ${f.model.parts.length} parts`);
    for (const [name, s] of Object.entries(f.states ?? {}))
      console.log(
        `  ${name}: ${s.model.parts.length} parts${s.size ? ` · size ${JSON.stringify(s.size)}` : ''}`,
      );
    const stats = m.thingStats?.[f.id] ?? [];
    console.log(`stats: ${stats.map((s) => s.key).join(', ') || 'none'}`);
    break;
  }
  case 'set':
    if (rest.length < 2) throw new Error('usage: bun run thing set <thing> <source> [--state s]');
    await setModel(rest[0]!, rest[1]!);
    break;
  case 'state': {
    const f = await find(rest[0] ?? '');
    const state = rest[1] === 'none' ? null : (rest[1] ?? null);
    const saved = await call<DeskMemory>('POST', 'fixtures/state', {
      mode,
      fixtureId: f.id,
      state,
    });
    console.log(summary(saved.fixtures!.find((x) => x.id === f.id)!));
    break;
  }
  case 'stat':
    if (rest.length < 2) throw new Error('usage: bun run thing stat <thing> +occupied|-occupied');
    await setStat(rest[0]!, rest[1]!);
    break;
  default:
    console.log(
      'usage: bun run thing list | show <thing> | set <thing> <source> [--state s --activate] | state <thing> <state|none> | stat <thing> +<stat>|-<stat>',
    );
    process.exit(command ? 1 : 0);
}
