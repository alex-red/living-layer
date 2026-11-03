import { describe, expect, test } from 'bun:test';
import { dragRect } from '../apps/web/src/RectGrab';

const r = { x: 0.2, y: 0.3, width: 0.4, height: 0.2 };
const close = (a: object, b: object) =>
  Object.entries(b).forEach(([k, v]) => expect((a as Record<string, number>)[k]).toBeCloseTo(v));

describe('dragging a zone being drawn', () => {
  test('a press off it draws a new one', () => {
    close(dragRect(r, 'draw', { x: 0.9, y: 0.9 }, { x: 0.7, y: 0.8 }), {
      x: 0.7,
      y: 0.8,
      width: 0.2,
      height: 0.1,
    });
  });
  test('its body moves it, kept inside', () => {
    close(dragRect(r, 'move', { x: 0.3, y: 0.4 }, { x: 0.4, y: 0.35 }), { ...r, x: 0.3, y: 0.25 });
    close(dragRect(r, 'move', { x: 0.3, y: 0.4 }, { x: 0.9, y: 1 }), { ...r, x: 0.6, y: 0.8 });
  });
  test('one already partly outside moves without jumping in', () => {
    const out = { ...r, x: -0.1 };
    close(dragRect(out, 'move', { x: 0, y: 0.4 }, { x: 0.05, y: 0.4 }), { ...out, x: -0.05 });
    close(dragRect(out, 'move', { x: 0, y: 0.4 }, { x: -0.2, y: 0.4 }), out);
  });
  test('a side stretches only its own edge', () => {
    close(dragRect(r, 'e', { x: 0.6, y: 0.4 }, { x: 0.7, y: 0.9 }), { ...r, width: 0.5 });
    close(dragRect(r, 'n', { x: 0.4, y: 0.3 }, { x: 0.1, y: 0.2 }), { ...r, y: 0.2, height: 0.3 });
  });
  test('a corner stretches both, and turns over past the far side', () => {
    close(dragRect(r, 'se', { x: 0.6, y: 0.5 }, { x: 0.7, y: 0.6 }), {
      ...r,
      width: 0.5,
      height: 0.3,
    });
    close(dragRect(r, 'w', { x: 0.2, y: 0.4 }, { x: 0.8, y: 0.4 }), { ...r, x: 0.6, width: 0.2 });
  });
});
