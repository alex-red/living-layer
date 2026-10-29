import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../apps/server/src/store.js';
import { parseSave } from '../apps/web/src/session.js';

describe('the offline mode renamed from fixture to demo', () => {
  it('moves stored desk memory and runs over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'livinglayer-rename-'));
    try {
      new EvidenceStore(dir).close();
      const db = new Database(join(dir, 'livinglayer.sqlite'));
      const rule = { id: 'r', lightId: 'light.fixture_shelf' };
      db.run('INSERT INTO desk_memory VALUES (?, ?)', [
        'fixture',
        JSON.stringify({ mode: 'fixture', object: null, rules: [rule] }),
      ]);
      db.run('INSERT INTO evidence VALUES (?, ?, ?)', [
        'run-1',
        '2026-10-28T00:00:00.000Z',
        JSON.stringify({ id: 'run-1', kind: 'lamp', mode: 'fixture' }),
      ]);
      db.close();
      const store = new EvidenceStore(dir);
      const memory = store.memory('demo');
      expect(memory.mode).toBe('demo');
      expect(memory.rules?.[0]?.entityId).toBe('light.demo_shelf');
      expect(store.getRun('run-1')?.mode).toBe('demo');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('reads a browser save from before the rename', () => {
    const save = parseSave(
      JSON.stringify({
        app: 'livinglayer',
        version: 1,
        savedAt: '2026-10-28T00:00:00.000Z',
        prefs: { mode: 'fixture', logMode: 'fixture', fixturePosition: 'right' },
        desks: {
          fixture: { mode: 'fixture', object: null, rules: [{ lightId: 'light.fixture_desk' }] },
        },
      }),
    );
    expect(save.prefs).toMatchObject({ mode: 'demo', logMode: 'demo', demoPosition: 'right' });
    expect('fixturePosition' in save.prefs).toBe(false);
    expect(save.desks.demo?.mode).toBe('demo');
    expect(save.desks.demo?.rules?.[0]?.entityId).toBe('light.demo_desk');
  });
});
