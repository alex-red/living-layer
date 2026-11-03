import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import {
  catItem,
  DEMO_CAMERA,
  DEMO_FRAME,
  projectRoom,
  starterFixtureDraft,
} from '@livinglayer/domain';

/** The brush's MCP server as an agent runs it: one process, JSON-RPC lines on stdio. */
function mcp() {
  const proc = Bun.spawn(['bun', resolve(import.meta.dir, '../scripts/mcp.ts')], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let id = 0;
  const answers = new Map<number, (m: { result?: any; error?: any }) => void>();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value);
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const m = JSON.parse(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
        answers.get(m.id)?.(m);
      }
    }
  })();
  const ask = (method: string, params: object = {}) =>
    new Promise<{ result?: any; error?: any }>((done) => {
      answers.set(++id, done);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const call = async (name: string, args: object) => {
    const { result } = await ask('tools/call', { name, arguments: args });
    return { ...result, json: JSON.parse(result.content[0].text) };
  };
  return { ask, call, close: () => proc.kill() };
}

describe('the brush over MCP', () => {
  it('lists its tools and ops, and makes a variant of what the cat sleeps on', async () => {
    const s = mcp();
    try {
      const init = await s.ask('initialize', { protocolVersion: '2025-06-18' });
      expect(init.result.serverInfo.name).toBe('livinglayer-brush');
      const tools = (await s.ask('tools/list')).result.tools.map((t: { name: string }) => t.name);
      expect(tools).toEqual(['room_describe', 'brush_ops', 'brush_run', 'demo_api']);
      expect((await s.call('brush_ops', {})).json.ops).toContain('- add_state: ');

      // A cat tree Thing on the floor, and the camera seeing the cat asleep on its top.
      const tree = starterFixtureDraft('cat-tree').model;
      const saved = await s.call('demo_api', {
        method: 'POST',
        path: '/api/fixtures/save',
        body: {
          fixture: {
            label: 'Cat tree',
            scene: 'office',
            surfaceId: null,
            at: { x: 1, y: 4 },
            turns: 0,
            size: { w: 1.67, d: 1.67, h: 4 },
            model: { label: tree.label, parts: tree.parts },
            reference: null,
            control: { kind: 'none' },
          },
        },
      });
      expect(saved.json.status).toBe(200);
      const memory = saved.json.body;
      const foot = projectRoom(DEMO_CAMERA, { x: 1.835, y: 4.835, z: 4 })!;
      const box = { x: foot.x - 20, y: foot.y - 28, width: 40, height: 28 };
      const now = new Date().toISOString();
      const restored = await s.call('demo_api', {
        method: 'POST',
        path: '/api/desk/restore',
        body: {
          memory: {
            ...memory,
            fixtures: [
              ...memory.fixtures,
              {
                id: crypto.randomUUID(),
                label: 'Cat',
                scene: 'office',
                surfaceId: null,
                at: { x: 0, y: 0 },
                turns: 0,
                size: { w: 0.93, d: 0.87, h: 0.6 },
                model: {
                  ...catItem('Cat', 'sleeping'),
                  source: 'demo',
                  segmentRunId: null,
                  swatches: [],
                  updatedAt: now,
                },
                reference: null,
                control: { kind: 'none' },
                place: 'sightings',
                track: {
                  concept: 'cat',
                  observation: {
                    id: 'o1',
                    objectId: 'cat',
                    segmentRunId: 'r1',
                    detectionId: 'd1',
                    observedAt: now,
                    sourceKey: 'demo',
                    frame: { ...DEMO_FRAME },
                    box,
                    identity: 'manual',
                  },
                  history: [],
                  status: 'seen',
                },
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        },
      });
      expect(restored.json.status).toBe(200);
      const room = (await s.call('room_describe', {})).json;
      const cat = room.things.find((f: { label: string }) => f.label === 'Cat');
      expect(cat).toMatchObject({
        placed: 'by its sightings',
        standsOn: [expect.stringMatching(/^Cat tree/)],
      });

      const per = (v: number, of: number) => Math.round((v / of) * 1000);
      const run = await s.call('brush_run', {
        select: {
          box: {
            x1: per(box.x - 2, DEMO_FRAME.width),
            y1: per(box.y - 2, DEMO_FRAME.height),
            x2: per(box.x + box.width + 2, DEMO_FRAME.width),
            y2: per(box.y + box.height + 2, DEMO_FRAME.height),
          },
        },
        prompt: "let's make a variant of the tree that's occupied",
        save: true,
      });
      expect(run.isError).toBeUndefined();
      expect(run.json.turns[0].variant).toMatchObject({ state: 'occupied', promotes: false });
      // Saved in the same lab, so the next call sees it.
      const after = (await s.call('room_describe', {})).json.things.find(
        (f: { label: string }) => f.label === 'Cat tree',
      );
      expect(run.json.saved).toBe(after.ref.split(':')[1]);
      expect(after).toMatchObject({ states: ['occupied'], showing: null, stats: ['occupied'] });

      const bad = await s.ask('tools/call', {
        name: 'brush_run',
        arguments: { select: {}, prompt: 'x' },
      });
      expect(bad.result).toMatchObject({ isError: true });
      expect(bad.result.content[0].text).toMatch(/around or box/);
    } finally {
      s.close();
    }
  }, 30_000);
});
