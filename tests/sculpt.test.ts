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
  it('writes our model out in the same form it reads back', () => {
    const mug = mugItem();
    const back = fromSculpt(mug.label, { note: '', parts: toSculpt(mug) })!;
    expect(back.parts.length).toBe(mug.parts.length);
    expect(back.parts.map((p) => p.id)).toEqual(mug.parts.map((p) => p.id));
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
