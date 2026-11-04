import { describe, expect, it } from 'bun:test';
import { keepsSaveInUse } from '../apps/web/src/session';

describe('the autosave into the named save in use', () => {
  const at = { ready: true, inUse: true, edits: 3, savedEdits: 2 };

  it('saves an edit made since it was saved or loaded', () => {
    expect(keepsSaveInUse(at)).toBe(true);
  });

  it('leaves it alone with nothing new', () => {
    expect(keepsSaveInUse({ ...at, savedEdits: 3 })).toBe(false);
  });

  it('waits for the desks to load, so an empty first render never overwrites it', () => {
    expect(keepsSaveInUse({ ...at, ready: false })).toBe(false);
  });

  it('has nothing to keep with no save in use', () => {
    expect(keepsSaveInUse({ ...at, inUse: false })).toBe(false);
  });
});
