import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { testApp } from './lib/app.js';

describe('whether a desk changed, for the open lab', () => {
  async function tagged() {
    const s = await testApp();
    const first = await s.get('desk/live');
    const tag = first.headers.etag as string;
    const ask = (t: string) =>
      s.app.inject({ method: 'GET', url: '/api/desk/live', headers: { 'if-none-match': t } });
    return { s, tag, ask };
  }

  it('answers 304 with no body while nothing was saved', async () => {
    const { tag, ask } = await tagged();
    expect(tag).toBeTruthy();
    const again = await ask(tag);
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('answers the new desk once something is saved', async () => {
    const { s, tag, ask } = await tagged();
    await s.post('desk/reset', { mode: 'live' });
    const after = await ask(tag);
    expect(after.statusCode).toBe(200);
    expect(after.headers.etag).not.toBe(tag);
  });

  it('sees a desk another process wrote to the database', async () => {
    const { s, tag, ask } = await tagged();
    const db = new Database(join(s.dataDir, 'livinglayer.sqlite'));
    db.run(`INSERT INTO desk_memory VALUES ('live', '{"mode":"live","lastDecision":null}')
      ON CONFLICT(mode) DO UPDATE SET payload = excluded.payload`);
    db.close();
    expect((await ask(tag)).statusCode).toBe(200);
  });
});
