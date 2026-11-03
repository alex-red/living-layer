import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import { LabError, safeError } from '../apps/server/src/errors.js';

describe('safeError', () => {
  let log: ReturnType<typeof spyOn>;
  beforeEach(() => {
    log = spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it('reports our own bugs as internal, with a generic message and a logged stack', () => {
    const error = safeError(new TypeError('secret-key-sk-123 is undefined'), 'scan');
    expect([error.code, error.statusCode]).toEqual(['internal', 500]);
    expect(error.message).not.toContain('secret-key');
    expect(String(log.mock.calls[0]![0])).toContain('secret-key-sk-123');
  });

  it('keeps SDK, network and timeout failures as upstream ones', () => {
    expect(safeError(new APIConnectionError({ message: 'down' })).code).toBe('upstream_failure');
    expect(safeError(new APIConnectionTimeoutError()).code).toBe('timeout');
    expect(safeError(APIError.generate(429, {}, 'slow', new Headers())).code).toBe('rate_limit');
    const refused = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    expect(safeError(refused).code).toBe('upstream_failure');
  });

  it('passes a LabError through without logging it', () => {
    const own = new LabError('nope', 'No.');
    expect(safeError(own)).toBe(own);
    expect(log).not.toHaveBeenCalled();
  });
});
