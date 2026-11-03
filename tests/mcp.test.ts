import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { catItem } from '@livinglayer/domain';

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

      const saved = await s.call('demo_api', {
        method: 'POST',
        path: '/api/fixtures/save',
        body: {
          fixture: {
            label: 'Cat',
            scene: 'office',
            surfaceId: 'desk:top',
            at: { x: 4.4, y: 2.2 },
            turns: 0,
            size: { w: 0.93, d: 0.87, h: 0.6 },
            model: { label: 'Cat', parts: catItem('Cat', 'sleeping').parts },
            reference: null,
            control: { kind: 'none' },
          },
        },
      });
      expect(saved.json.status).toBe(200);
      const room = (await s.call('room_describe', {})).json;
      const cat = room.fixtures.find((f: { label: string }) => f.label === 'Cat');
      expect(cat.standsOn).toEqual(['Desk (prop desk)']);

      const run = await s.call('brush_run', {
        select: { around: cat.ref },
        prompt: "let's make a variant of the desk that's occupied",
        save: true,
      });
      expect(run.isError).toBeUndefined();
      expect(run.json.turns[0].variant).toMatchObject({ group: 'desk', state: 'occupied' });
      expect(run.json.saved).toBe('desk');
      expect(run.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
      // Saved in the same lab, so the next call sees it.
      const desk = (await s.call('room_describe', {})).json.groups.find(
        (g: { ref: string }) => g.ref === 'prop:desk',
      );
      expect(desk).toMatchObject({ variants: ['base', 'occupied'], showing: 'base' });

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
