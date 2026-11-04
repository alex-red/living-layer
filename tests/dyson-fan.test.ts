import { describe, expect, it } from 'bun:test';
import { starterFixtureDraft, STARTER_TEMPLATES, topOf } from '@livinglayer/domain';

describe('the Dyson Fan starter', () => {
  it('is offered among the starters as Dyson Fan', () => {
    expect(STARTER_TEMPLATES).toContain('dyson-fan');
    expect(starterFixtureDraft('dyson-fan').label).toBe('Dyson Fan');
  });

  it('stands as tall against its width as its real 28 × 102 cm box', () => {
    const { model, size } = starterFixtureDraft('dyson-fan');
    const left = Math.min(...model.parts.map((p) => p.at.x));
    const right = Math.max(...model.parts.map((p) => p.at.x + p.size.w));
    expect(size.h / size.w).toBeCloseTo(102 / 28, 1);
    expect(topOf(model.parts) / (right - left)).toBeCloseTo(size.h / size.w, 0);
  });

  it('paints its loop in the first colour and its base in the second', () => {
    const { model } = starterFixtureDraft('dyson-fan', { colors: ['#223344', '#998877'] });
    const color = (id: string) => model.parts.find((p) => p.id === id)?.color;
    expect(color('side-right')).toBe('#223344');
    expect(color('body')).toBe('#998877');
  });
});
