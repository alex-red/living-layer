/**
 * Put the running dev server's demo memory back to the preset, so a probe
 * starts from the room everyone knows rather than what an earlier check
 * left (a saved model, a moved pin). Live memory is never touched. Scripts
 * that run the demo in process (`bun run brush`) don't need it.
 *
 *   bun run reset demo
 */
import { parseArgs } from './lib/args.js';
import { LIVE_SERVER } from './lib/brush.js';

const what = parseArgs().positional[0];
if (what !== 'demo') {
  console.log('Usage: bun run reset demo   (only the demo can be reset)');
  process.exit(1);
}
const res = await fetch(`${LIVE_SERVER}/api/desk/demo/reset`, { method: 'POST' }).catch(
  (e: unknown) => {
    console.log(`No server at ${LIVE_SERVER}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
if (!res.ok) {
  console.log(`${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`The demo at ${LIVE_SERVER} is back to the preset, with its household at Home.`);
