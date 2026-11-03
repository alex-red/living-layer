import { describe, expect, it } from 'bun:test';
import { clampFiniteOrLow, quantileAt } from '../packages/domain/src/math.js';

describe('clampFiniteOrLow', () => {
  it('clamps finite values into the range', () => {
    expect(clampFiniteOrLow(5, 0, 1)).toBe(1);
    expect(clampFiniteOrLow(-5, 0, 1)).toBe(0);
    expect(clampFiniteOrLow(0.5, 0, 1)).toBe(0.5);
  });
  it('gives the low bound for NaN and infinities', () => {
    expect(clampFiniteOrLow(NaN, 0.02, 3)).toBe(0.02);
    expect(clampFiniteOrLow(Infinity, 0.02, 3)).toBe(0.02);
    expect(clampFiniteOrLow(-Infinity, 0.02, 3)).toBe(0.02);
  });
});

describe('quantileAt', () => {
  const v = [1, 2, 3, 4, 5];
  it('is 0 for no values', () => {
    expect(quantileAt([], 0.5)).toBe(0);
  });
  it('indexes by q·(n−1): q=0 first, q=1 last', () => {
    expect(quantileAt(v, 0)).toBe(1);
    expect(quantileAt(v, 1)).toBe(5);
    expect(quantileAt(v, 0.5)).toBe(3);
    expect(quantileAt(v, 0.99)).toBe(4);
  });
  it('keeps a lone value for every q', () => {
    expect(quantileAt([7], 0)).toBe(7);
    expect(quantileAt([7], 1)).toBe(7);
  });
});
