/**
 * The AI brush for agents, as an MCP server on stdio
 * ([plan](../docs/plans/brush-relations.md#tools-and-mcp)): the same calls
 * `bun run brush` makes, with the ops and their schemas read from the same
 * registries Spark's prompt is built from, so a new op shows up here by itself.
 *
 *   bun run mcp          (Claude Code reads it from .mcp.json)
 *
 * The demo runs in process on a throwaway data folder kept for the server's
 * life, so a variant saved by one call is in the room for the next, and the
 * dev server's demo memory is never touched. `mode: "live"` sends brush
 * requests to the running server and its camera, billed.
 */
import { z } from 'zod';
import {
  DEMO_CALIBRATION,
  INTENT_KINDS,
  opCatalog,
  RECIPE_OPS,
  sparkIntentSchema,
  thingRef,
  type DeskMemory,
} from '@livinglayer/domain';
import { selectionRoom } from '../apps/server/src/select.js';
import { DEMO_GAPS } from './lib/intent-cases.js';
import { brushOverlay, demoApp, LIVE_SERVER, runBrush, targetName } from './lib/brush.js';

// stdout carries the protocol: anything else printed goes to stderr.
console.log = console.error;

let demo: Awaited<ReturnType<typeof demoApp>> | null = null;
const demoLab = async () => (demo ??= await demoApp());

async function memoryOf(mode: 'demo' | 'live'): Promise<DeskMemory> {
  if (mode === 'demo') return (await (await demoLab()).app.inject('/api/desk/demo')).json();
  const res = await fetch(`${LIVE_SERVER}/api/desk/live`);
  if (!res.ok) throw new Error(`The running server answered ${res.status}: is it running?`);
  return (await res.json()) as DeskMemory;
}

const mode = z.enum(['demo', 'live']).default('demo');
const select = z
  .object({
    around: z
      .string()
      .min(1)
      .optional()
      .describe(
        'A group (`desk`) or a fixture (`fixture:<id>`): a box around how the camera draws it.',
      ),
    pad: z.number().min(-0.4).max(1).optional().describe('Share of its size added on each side.'),
    box: z
      .object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() })
      .optional()
      .describe('A box in thousandths of the frame.'),
  })
  .refine((s) => Boolean(s.around) !== Boolean(s.box), { message: 'Give around or box.' });

const TOOLS = {
  room_describe: {
    description:
      'The room the brush works on: its layout (furniture groups, which never keep stats or variants until made things), its Things with their states, and what stands on what, with the refs a request names them by.',
    input: z.object({ mode }),
    run: async ({ mode }: { mode: 'demo' | 'live' }) => {
      const memory = await memoryOf(mode);
      const room = selectionRoom(memory);
      const layout = [...new Set(room.scene.props.map((p) => p.group))].map((g) => {
        const main =
          room.scene.props.find((p) => p.id === g) ?? room.scene.props.find((p) => p.group === g)!;
        const target = { kind: 'prop' as const, id: g, label: main.label };
        return {
          ref: thingRef(target),
          label: main.label,
          model: main.recipe ? 'recipe' : (main.form ?? 'box'),
          onIt: room.related(target).map((r) => targetName(r.target)),
        };
      });
      const things = (memory.fixtures ?? []).map((f) => {
        const target = {
          kind: f.place === 'sightings' ? ('object' as const) : ('fixture' as const),
          id: f.id,
          label: f.label,
        };
        const related = room.related(target);
        return {
          ref: thingRef(target),
          label: f.label,
          ...(f.type ? { type: f.type } : {}),
          placed: f.place === 'sightings' ? 'by its sightings' : 'by hand',
          states: Object.keys(f.states ?? {}),
          showing: f.state ?? null,
          stats: (memory.thingStats?.[f.id] ?? []).map((x) => x.key),
          standsOn: related.filter((r) => r.relation === 'holds').map((r) => targetName(r.target)),
          onIt: related.filter((r) => r.relation === 'on').map((r) => targetName(r.target)),
        };
      });
      return { scene: room.scene.label, layout, things };
    },
  },
  brush_ops: {
    description:
      'Every op a brush request can be read as, one line each, the JSON schema Spark answers in, and the ops the demo reader can’t produce (with why).',
    input: z.object({}),
    run: async () => ({
      ops: opCatalog(),
      recipeOps: Object.keys(RECIPE_OPS),
      intentOps: INTENT_KINDS,
      demoGaps: DEMO_GAPS,
      sparkSchema: z.toJSONSchema(sparkIntentSchema),
    }),
  },
  brush_run: {
    description:
      'One AI brush request as the panel sends it: a selection and a sentence, follow-ups on the same selection, and optionally save the last model (as furniture, or a variant beside it). Returns the target, what the request was read as, the model, and the frame with the selection and model drawn on it. Live is billed.',
    input: z.object({
      mode,
      select,
      prompt: z.string().min(1).max(400),
      follow: z.array(z.string().min(1).max(400)).max(4).optional(),
      save: z.boolean().optional(),
      picture: z.boolean().default(true).describe('Return the overlay PNG.'),
    }),
    run: async (input: {
      mode: 'demo' | 'live';
      select: z.infer<typeof select>;
      prompt: string;
      follow?: string[];
      save?: boolean;
      picture: boolean;
    }) => {
      const lab = input.mode === 'demo' ? await demoLab() : null;
      const result = await runBrush({
        mode: input.mode,
        select: input.select.around
          ? {
              around: input.select.around,
              ...(input.select.pad !== undefined ? { pad: input.select.pad } : {}),
            }
          : { box: input.select.box! },
        prompt: input.prompt,
        ...(input.follow ? { follow: input.follow } : {}),
        ...(input.save ? { save: true } : {}),
        ...(lab ? { app: lab.app, appDataDir: lab.dir } : {}),
      });
      const summary = {
        selected: targetName(result.resolve.target),
        related: result.resolve.related.map((r) => `${r.relation} ${targetName(r.target)}`),
        agrees: result.agrees,
        turns: result.turns.map((t) => {
          const d = t.run.output;
          return {
            prompt: t.prompt,
            run: t.run.id,
            ops: d.intent.ops,
            leftOut: d.intent.dropped,
            question: d.question,
            model: d.recipe
              ? {
                  label: d.recipe.label,
                  sizeCm: d.recipe.sizeCm,
                  parts: d.recipe.parts.map((p) => p.name),
                }
              : null,
            variant: d.variant ?? null,
            check: d.check ? { iou: d.check.iou, report: d.check.report } : null,
            steps: t.steps.map((s) => `${s.label}: ${s.state}${s.detail ? ` (${s.detail})` : ''}`),
          };
        }),
        failed: result.failed,
        saved: result.saved,
      };
      const png = input.picture && result.turns.length ? await brushOverlay(result) : null;
      return png ? { summary, png } : { summary };
    },
  },
  demo_api: {
    description:
      'Call the in-process demo lab’s API (never the running server): `GET /api/desk/demo`, `POST /api/fixtures/save` to put a fixture somewhere, `POST /api/desk/demo/reset` to start over. Bodies are JSON; mode defaults to demo.',
    input: z.object({
      method: z.enum(['GET', 'POST']),
      path: z.string().regex(/^\/api\//),
      body: z.record(z.string(), z.unknown()).optional(),
    }),
    run: async (input: {
      method: 'GET' | 'POST';
      path: string;
      body?: Record<string, unknown>;
    }) => {
      const res = await (
        await demoLab()
      ).app.inject({
        method: input.method,
        url: input.path,
        ...(input.method === 'POST' ? { payload: { mode: 'demo', ...input.body } } : {}),
      });
      return {
        status: res.statusCode,
        body: res.body.length > 20_000 ? `${res.body.slice(0, 20_000)}…` : safeJson(res.body),
      };
    },
  },
} as const;
const safeJson = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

type Message = {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
};
const send = (m: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);

async function handle(m: Message) {
  switch (m.method) {
    case 'initialize':
      return {
        protocolVersion: (m.params?.protocolVersion as string | undefined) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'livinglayer-brush', version: '1.0.0' },
        instructions: `The Living Layer lab's AI brush. Start with room_describe, then brush_run in demo mode (calibrated: ${DEMO_CALIBRATION.scene}). Refs name things in requests (prop:<group>, fixture:<id>).`,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.input, { io: 'input' }),
        })),
      };
    case 'tools/call': {
      const name = m.params?.name as keyof typeof TOOLS;
      const tool = TOOLS[name];
      if (!tool) throw Object.assign(new Error(`No tool ${String(name)}.`), { code: -32602 });
      const args = tool.input.safeParse(m.params?.arguments ?? {});
      if (!args.success)
        return { isError: true, content: [{ type: 'text', text: z.prettifyError(args.error) }] };
      try {
        const out = (await (tool.run as (a: unknown) => Promise<object>)(args.data)) as {
          png?: Buffer;
        };
        const { png, ...rest } = out;
        const body = 'summary' in rest ? rest.summary : rest;
        return {
          content: [
            { type: 'text', text: JSON.stringify(body, null, 2) },
            ...(png
              ? [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]
              : []),
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
        };
      }
    }
    default:
      throw Object.assign(new Error(`No method ${m.method}.`), { code: -32601 });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let m: Message;
    try {
      m = JSON.parse(line) as Message;
    } catch {
      send({ id: null, error: { code: -32700, message: 'Not JSON.' } });
      continue;
    }
    // Notifications (no id) get no answer.
    if (m.id === undefined) continue;
    handle(m).then(
      (result) => send({ id: m.id, result }),
      (e: Error & { code?: number }) =>
        send({ id: m.id, error: { code: e.code ?? -32603, message: e.message } }),
    );
  }
});
process.stdin.on('end', () => void demo?.close().finally(() => process.exit(0)));
