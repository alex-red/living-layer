import { describe, expect, it } from 'bun:test';
import {
  ASK_EXAMPLES,
  DEMO_DAY,
  askRoom,
  clock,
  dayAt,
  dayNudges,
  span,
} from '../apps/web/src/workspace/demoDay.js';

// The sample day the replay, "Ask your room" and the nudges read.

describe('the sample day', () => {
  it('is in order', () => {
    const times = DEMO_DAY.map((e) => e.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('stands the mug and switches the lamp as of a minute', () => {
    expect(dayAt(400)).toMatchObject({ mug: 'away', lamp: false, uses: 0 });
    expect(dayAt(470)).toMatchObject({ mug: 'coaster', lamp: true, lastUsed: 462 });
    expect(dayAt(560)).toMatchObject({ mug: 'keyboard', lamp: false });
  });
});

describe('dayNudges', () => {
  const nudges = dayNudges();

  it('sends the food that goes off first in the morning', () => {
    const food = nudges.find((n) => n.id === 'food')!;
    expect(food.at).toBe(480);
    expect(food.body).toBe('Leftover chicken goes off today · Milk goes off tomorrow');
  });

  it('reminds to drink three hours after the mug was last used, only while it is on the desk', () => {
    const drinks = nudges.filter((n) => n.id.startsWith('drink'));
    expect(drinks.map((n) => n.at)).toEqual([765 + 180]);
    expect(drinks[0]!.cites.map((e) => e.at)).toEqual([765]);
  });

  it('says the lamp was left on half an hour with the desk empty', () => {
    const lamp = nudges.filter((n) => n.id.startsWith('lamp'));
    expect(lamp.map((n) => n.at)).toEqual([1140 + 30]);
    expect(lamp[0]!.body).toBe('It has been on 30 min with nothing at the desk.');
  });
});

describe('askRoom', () => {
  it('answers when the mug was last used, from the day so far', () => {
    const a = askRoom('When did I last drink from my mug?', 600);
    expect(a.text).toStartWith('At 9:35, 25 min ago. You’ve used it 4 times today, first at 7:42.');
    expect(a.cites.at(-1)!.at).toBe(575);
  });

  it('lists the food by when it goes off', () => {
    expect(askRoom('What should I eat first?', 800).text).toStartWith(
      'Eat the leftover chicken first: it goes off today.',
    );
  });

  it('adds up how long the lamp was on', () => {
    expect(askRoom('How long was the lamp on today?', 700).text).toBe(
      'The desk lamp was on 2 h 48 min today, switched on 2 times. It is on now.',
    );
  });

  it('answers every example', () => {
    for (const q of ASK_EXAMPLES) expect(askRoom(q, 1000).text).not.toStartWith('In this demo');
  });

  it('says what it can answer otherwise', () => {
    expect(askRoom('What is the weather?', 1000).cites).toEqual([]);
  });
});

it('writes times and spans', () => {
  expect(clock(845)).toBe('14:05');
  expect(span(130)).toBe('2 h 10 min');
  expect(span(60)).toBe('1 h');
});
