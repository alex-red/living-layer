import { describe, expect, it } from 'bun:test';
import {
  emptyDesk,
  parseSave,
  parseSaves,
  saveName,
  withSave,
  type NamedSave,
  type SessionSave,
} from '../apps/web/src/session.js';

const save = (savedAt: string, name?: string): SessionSave => ({
  app: 'livinglayer',
  version: 1,
  savedAt,
  ...(name ? { name } : {}),
  prefs: { mode: 'demo' },
  desks: { demo: emptyDesk('demo') },
});

describe('named saves', () => {
  it('tidies a name to one trimmed line', () => {
    expect(saveName('  My \n office   ')).toBe('My office');
    expect(saveName('   ')).toBe('');
    expect(saveName('x'.repeat(200))).toHaveLength(60);
  });
  it('reads back newest first, dropping entries that are not saves', () => {
    const list = parseSaves(
      JSON.stringify([
        { id: 'a', name: 'Older', save: save('2026-10-01T00:00:00.000Z') },
        { id: 'b', name: 'Newer', save: save('2026-11-01T00:00:00.000Z') },
        { id: 'c', name: 'Broken', save: { app: 'other' } },
        { id: 'd', name: '  ', save: save('2026-11-02T00:00:00.000Z') },
        { name: 'No id', save: save('2026-11-02T00:00:00.000Z') },
      ]),
    );
    expect(list.map((s) => s.id)).toEqual(['b', 'a']);
    expect(list[0]!.save.name).toBe('Newer');
    expect(list[0]!.save.desks.demo?.mode).toBe('demo');
  });
  it('starts empty from nothing or from text that is not a list', () => {
    expect(parseSaves(null)).toEqual([]);
    expect(parseSaves('{')).toEqual([]);
    expect(parseSaves('{"id":"a"}')).toEqual([]);
  });
  it('puts an updated save in place of the old one, at the front', () => {
    const a: NamedSave = { id: 'a', name: 'A', save: save('2026-10-01T00:00:00.000Z') };
    const b: NamedSave = { id: 'b', name: 'B', save: save('2026-10-02T00:00:00.000Z') };
    const list = withSave(withSave([], a), b);
    const updated = withSave(list, { ...a, save: save('2026-10-03T00:00:00.000Z') });
    expect(updated.map((s) => s.id)).toEqual(['a', 'b']);
    expect(updated[0]!.save.savedAt).toBe('2026-10-03T00:00:00.000Z');
  });
  it('keeps a save file’s name, and reads one without a name as before', () => {
    expect(parseSave(JSON.stringify(save('2026-10-01T00:00:00.000Z', ' Desk '))).name).toBe('Desk');
    expect('name' in parseSave(JSON.stringify(save('2026-10-01T00:00:00.000Z')))).toBe(false);
  });
});
