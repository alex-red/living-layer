import { describe, expect, it } from 'bun:test';
import { starterTemplateModel, type DeskMemory } from '@livinglayer/domain';
import { emptyDesk, thingsChanged } from '../apps/web/src/session';
import { fixture } from './lib/fixture-scan.js';

describe('a desk saved elsewhere, for the named save in use', () => {
  const tower = fixture({ label: 'Gray cat tower', model: starterTemplateModel('cat-tree') });
  const desk = (patch: Partial<DeskMemory> = {}): DeskMemory => ({
    ...emptyDesk('live'),
    fixtures: [tower],
    ...patch,
  });

  it('counts a thing changed elsewhere as an edit to keep', () => {
    const sleeping = { ...tower, state: 'sleeping' };
    expect(thingsChanged(desk(), desk({ fixtures: [sleeping] }))).toBe(true);
  });

  it("doesn't count what the watcher decides", () => {
    const decided = desk({ rules: [], lastDecision: null });
    expect(thingsChanged(desk(), { ...decided, lastDecision: desk().lastDecision })).toBe(false);
    expect(thingsChanged(desk({ rules: undefined }), decided)).toBe(false);
  });
});
