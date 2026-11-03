import { describe, expect, it } from 'bun:test';
import { fromSculpt, isoItemSchema, mugItem, toSculpt, type Sculpt } from '@livinglayer/domain';

const part = (over: Partial<Sculpt['parts'][number]> = {}): Sculpt['parts'][number] => ({
  id: 'body',
  shape: 'rbox',
  at: { x: 0, y: 0, z: 0 },
  size: { w: 1, d: 0.5, h: 0.4 },
  color: '#202020',
  material: 'matte',
  profile: null,
  path: null,
  outline: null,
  radius: 0.1,
  rough: null,
  wall: null,
  inside: null,
  bands: null,
  ...over,
});

describe('a model Spark writes in our parts', () => {
  it('becomes a valid model, numbers kept in range and nulls left out', () => {
    const item = fromSculpt('Monitor', {
      note: '',
      parts: [
        part({ size: { w: 9, d: 0.1, h: -1 }, at: { x: -3, y: 0.2, z: 0 } }),
        part({
          id: 'stand',
          shape: 'lathe',
          profile: [
            { r: 0.5, z: 1 },
            { r: 1, z: 0 },
          ],
          bands: [{ from: 0, to: 0.2, color: '#ffffff' }],
          radius: null,
        }),
      ],
    })!;
    expect(isoItemSchema.safeParse(item).success).toBe(true);
    expect(item.parts[0]!.size).toEqual({ w: 3, d: 0.1, h: 0.02 });
    expect(item.parts[0]!.at.x).toBe(-0.5);
    expect('profile' in item.parts[0]!).toBe(false);
    // A profile runs bottom to top, and bands become paint.
    const turnedPart = item.parts[1]!;
    if (turnedPart.shape !== 'lathe') throw new Error('not a lathe');
    expect(turnedPart.profile.map((p) => p.z)).toEqual([0, 1]);
    expect(turnedPart.paint).toEqual([{ kind: 'band', from: 0, to: 0.2, color: '#ffffff' }]);
  });
  it('drops parts that still aren’t valid, and gives same ids their own', () => {
    const item = fromSculpt('Plant', {
      note: '',
      parts: [part({ shape: 'lathe', profile: null }), part(), part()],
    })!;
    expect(item.parts.map((p) => p.id)).toEqual(['body', 'body-2']);
    expect(fromSculpt('Nothing', { note: '', parts: [part({ shape: 'tube', path: null })] })).toBe(
      null,
    );
  });
  it('writes our model out in the same form it reads back, an open top and its coffee too', () => {
    const mug = mugItem();
    const back = fromSculpt(mug.label, { note: '', parts: toSculpt(mug) })!;
    expect(back.parts.length).toBe(mug.parts.length);
    expect(back.parts.map((p) => p.id)).toEqual(mug.parts.map((p) => p.id));
    const coffee = { wall: '#f2ede1', liquid: '#1a1410', level: 0.85 };
    const open = fromSculpt('Mug', {
      note: '',
      parts: [
        part({
          shape: 'lathe',
          radius: null,
          profile: [
            { r: 1, z: 0 },
            { r: 1, z: 1 },
          ],
          wall: 0.1,
          inside: coffee,
        }),
      ],
    })!;
    expect(toSculpt(open)[0]).toMatchObject({ wall: 0.1, inside: coffee });
  });
  it('opens a closed mug with a dark disc inside it, the disc becoming its inside, empty', () => {
    const lathe = {
      shape: 'lathe' as const,
      radius: null,
      profile: [
        { r: 1, z: 0 },
        { r: 1, z: 1 },
      ],
    };
    const item = fromSculpt('Mug', {
      note: '',
      parts: [
        part({
          ...lathe,
          id: 'body',
          color: '#f2ede1',
          size: { w: 0.72, d: 0.72, h: 1 },
          at: { x: 0, y: 0.14, z: 0 },
        }),
        part({
          ...lathe,
          id: 'coffee',
          color: '#122029',
          size: { w: 0.6, d: 0.6, h: 0.04 },
          at: { x: 0.06, y: 0.2, z: 0.88 },
        }),
        part({ id: 'base', size: { w: 0.5, d: 0.5, h: 0.04 }, at: { x: 0.1, y: 0.2, z: 0 } }),
      ],
    })!;
    expect(item.parts.map((p) => p.id)).toEqual(['body', 'base']);
    const body = item.parts[0]!;
    expect(body.shape === 'lathe' && body.wall).toBeCloseTo(1 - 0.6 / 0.72, 6);
    // Its opening shows the disc's colour as its inside, and nothing in it.
    expect(body).toMatchObject({ inside: { wall: '#122029', liquid: null, level: 0 } });
    expect(isoItemSchema.safeParse(item).success).toBe(true);
  });
  it('keeps an open top only on a lathe, and its inside only when it is open', () => {
    const coffee = { wall: '#f2ede1', liquid: '#1a1410', level: 0.85 };
    const item = fromSculpt('Mug', {
      note: '',
      parts: [
        part({
          shape: 'lathe',
          radius: null,
          profile: [
            { r: 1, z: 0 },
            { r: 1, z: 1 },
          ],
          wall: 0.1,
          inside: coffee,
        }),
        part({
          id: 'closed',
          shape: 'lathe',
          radius: null,
          profile: [
            { r: 1, z: 0 },
            { r: 1, z: 1 },
          ],
          inside: coffee,
        }),
        part({ id: 'box', wall: 0.1, inside: coffee }),
      ],
    })!;
    expect(isoItemSchema.safeParse(item).success).toBe(true);
    expect(item.parts[0]).toMatchObject({ wall: 0.1, inside: coffee });
    expect(item.parts[1]).not.toHaveProperty('inside');
    expect(item.parts[2]).not.toHaveProperty('wall');
  });
});

describe('a provider timeout', () => {
  it('is reported as a timeout, though the SDK’s error is named Error', async () => {
    const { APIConnectionTimeoutError } = await import('openai');
    const { safeError } = await import('../apps/server/src/errors.js');
    expect(safeError(new APIConnectionTimeoutError(), 'fixture').code).toBe('timeout');
  });
});

describe('a job the page follows', () => {
  it('shows the step that failed, with why, and keeps the rest waiting', async () => {
    const { Jobs } = await import('../apps/server/src/jobs.js');
    const jobs = new Jobs();
    const id = crypto.randomUUID();
    const t = jobs.start(id, [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ]);
    await t.done('a', 'fine');
    t.run('b');
    t.fail('The request timed out.');
    const job = jobs.get(id)!;
    expect(job.done).toBe(true);
    expect(job.steps.map((s) => [s.state, s.detail ?? null])).toEqual([
      ['done', 'fine'],
      ['failed', 'The request timed out.'],
      ['waiting', null],
    ]);
    // Without an id, nothing is kept to read.
    jobs.start(undefined, [{ id: 'a', label: 'A' }]).run('a');
    expect(jobs.get('')).toBeNull();
  });

  it('counts as running, for `bun run dev` to wait on, until its steps end however they end', async () => {
    const { Jobs, following, runningJobs } = await import('../apps/server/src/jobs.js');
    const jobs = new Jobs();
    let finish = () => {};
    const done = following(
      jobs.start(undefined, [{ id: 'a', label: 'A' }], { title: 'Drawing the room' }),
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const failed = following(jobs.start(undefined, [{ id: 'a', label: 'A' }]), async () => {
      throw new Error('no');
    }).catch(() => {});
    expect(runningJobs()).toContain('Drawing the room');
    await failed;
    expect(runningJobs()).not.toContain('An AI task');
    finish();
    await done;
    expect(runningJobs()).not.toContain('Drawing the room');
  });
});

describe('how fixtures show on the room picture', () => {
  it('is kept with the session, and anything else falls back to the picture', async () => {
    const { prefsOf } = await import('../apps/web/src/session.js');
    expect(prefsOf({ fixtureLook: 'model' }).fixtureLook).toBe('model');
    expect(prefsOf({ fixtureLook: 'sketch' as never }).fixtureLook).toBe('picture');
    expect(prefsOf(undefined).fixtureLook).toBe('picture');
  });
});
