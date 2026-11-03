import { describe, expect, it } from 'bun:test';
import type { StoredSave } from '@livinglayer/domain';
import {
  emptyDesk,
  mergeSaves,
  type NamedSave,
  type SessionSave,
} from '../apps/web/src/session.js';
import { testApp } from './lib/app.js';

const file = (savedAt: string): SessionSave => ({
  app: 'livinglayer',
  version: 1,
  savedAt,
  prefs: { mode: 'demo' },
  desks: { demo: emptyDesk('demo') },
});
const entry = (id: string, name: string, savedAt: string, onServer?: boolean): NamedSave => ({
  id,
  name,
  save: { ...file(savedAt), name },
  ...(onServer ? { onServer } : {}),
});

describe('named saves on the server', () => {
  async function server() {
    const { app } = await testApp({ name: 'saves' });
    const call = async <T>(url: string, payload?: object) => {
      const res = await app.inject({ method: payload ? 'POST' : 'GET', url, payload });
      return { status: res.statusCode, body: res.json<T>() };
    };
    return call;
  }
  it('keeps saves for every browser, newest first, and deletes them', async () => {
    const call = await server();
    await call('/api/saves/save', { id: 'a', name: 'Office', save: file('2026-11-01T00:00:00Z') });
    await call('/api/saves/save', { id: 'b', name: 'Desk', save: file('2026-11-02T00:00:00Z') });
    const { body } = await call<StoredSave[]>('/api/saves');
    expect(body.map((s) => s.id)).toEqual(['b', 'a']);
    expect(body[0]!.save.name).toBe('Desk');
    const after = await call<StoredSave[]>('/api/saves/delete', { id: 'b' });
    expect(after.body.map((s) => s.id)).toEqual(['a']);
  });
  it('puts a save under a name already kept in that one’s place', async () => {
    const call = await server();
    await call('/api/saves/save', { id: 'a', name: 'Office', save: file('2026-11-01T00:00:00Z') });
    const { body } = await call<{ save: StoredSave; saves: StoredSave[] }>('/api/saves/save', {
      id: 'other',
      name: 'office',
      save: file('2026-11-02T00:00:00Z'),
    });
    expect(body.save.id).toBe('a');
    expect(body.saves).toHaveLength(1);
    expect(body.saves[0]!.save.savedAt).toBe('2026-11-02T00:00:00Z');
  });
  it('keeps the newer copy when an older one is synced', async () => {
    const call = await server();
    await call('/api/saves/save', { id: 'a', name: 'Office', save: file('2026-11-02T00:00:00Z') });
    const { body } = await call<{ save: StoredSave }>('/api/saves/save', {
      id: 'a',
      name: 'Office',
      save: file('2026-11-01T00:00:00Z'),
    });
    expect(body.save.save.savedAt).toBe('2026-11-02T00:00:00Z');
  });
  it('renames, refusing a name another save has', async () => {
    const call = await server();
    await call('/api/saves/save', { id: 'a', name: 'Office', save: file('2026-11-01T00:00:00Z') });
    await call('/api/saves/save', { id: 'b', name: 'Desk', save: file('2026-11-02T00:00:00Z') });
    expect((await call('/api/saves/rename', { id: 'a', name: 'desk' })).status).toBe(409);
    expect((await call('/api/saves/rename', { id: 'zzz', name: 'New' })).status).toBe(404);
    const { body } = await call<StoredSave[]>('/api/saves/rename', { id: 'a', name: 'Study' });
    expect(body.find((s) => s.id === 'a')?.save.name).toBe('Study');
  });
  it('refuses what is not a save', async () => {
    const call = await server();
    const res = await call('/api/saves/save', { id: 'a', name: 'X', save: { app: 'other' } });
    expect(res.status).toBe(400);
  });
});

describe('syncing a browser’s saves with the server', () => {
  it('sends saves made only here, and takes the server’s others', () => {
    const local = [entry('mine', 'Mine', '2026-11-03T00:00:00Z')];
    const server = [entry('theirs', 'Theirs', '2026-11-01T00:00:00Z')];
    const { saves, upload } = mergeSaves(local, server);
    expect(saves.map((s) => s.id)).toEqual(['mine', 'theirs']);
    expect(saves.find((s) => s.id === 'theirs')?.onServer).toBe(true);
    expect(upload.map((s) => s.id)).toEqual(['mine']);
  });
  it('drops a save the server had and no longer has: deleted elsewhere', () => {
    const local = [entry('gone', 'Gone', '2026-11-01T00:00:00Z', true)];
    expect(mergeSaves(local, [])).toEqual({ saves: [], upload: [] });
  });
  it('keeps the newer of two copies, and sends this one when it is newer', () => {
    const older = entry('a', 'Office', '2026-11-01T00:00:00Z', true);
    const newer = entry('a', 'Office', '2026-11-02T00:00:00Z', true);
    expect(mergeSaves([newer], [older]).upload).toEqual([newer]);
    const pulled = mergeSaves([older], [newer]);
    expect(pulled.saves[0]!.save.savedAt).toBe('2026-11-02T00:00:00Z');
    expect(pulled.upload).toEqual([]);
  });
});
