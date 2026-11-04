import type { Fixture } from './fixture.js';
import { HOUSEHOLD, doing, householdAt } from './household-day.js';
import type { MemberType } from './members.js';

/** Where a person or pet is, as the room's things say it: home or out, sitting, asleep. */
interface MemberPlace {
  home: boolean;
  /** As words after their name: "is sitting in the chair", "is asleep", "is out". */
  text: string;
  /** In a word or two, for a card's line or Home Assistant's state: "Chair", "asleep", "home". */
  short: string;
  /** The seat they sit in. */
  seatId?: string;
}

/** Where a person or pet is now: out, in their seat, asleep or lying down, or simply home. */
export function memberPlace(
  f: Pick<Fixture, 'away' | 'seatedOn' | 'state'>,
  fixtures: readonly Pick<Fixture, 'id' | 'label'>[],
): MemberPlace {
  if (f.away) return { home: false, text: 'is out', short: 'out' };
  const seat = f.seatedOn ? fixtures.find((x) => x.id === f.seatedOn) : undefined;
  if (seat)
    return {
      home: true,
      text: `is sitting in the ${seat.label.toLowerCase()}`,
      short: `in the ${seat.label.toLowerCase()}`,
      seatId: seat.id,
    };
  if (f.state === 'sleeping') return { home: true, text: 'is asleep', short: 'asleep' };
  if (f.state === 'lying') return { home: true, text: 'is lying down', short: 'lying down' };
  return { home: true, text: 'is home', short: 'home' };
}

/** "is asleep by the plant" as a card says it: "Asleep by the plant". */
const capWords = (text: string) => {
  const s = text.replace(/^is /, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const KIND_WORDS: Record<MemberType, string> = { person: 'Lives here', cat: 'Cat', dog: 'Dog' };

/**
 * What a person's or pet's card in the room says: where they are and how,
 * and what they are, with since when while the day is replayed (the demo's
 * household follows its day then, `householdAt`).
 */
export function memberCard(
  f: Pick<Fixture, 'away' | 'seatedOn' | 'state' | 'label' | 'scene'> & { type: MemberType },
  fixtures: readonly Pick<Fixture, 'id' | 'label'>[],
  minute: number | null,
): { place: string; detail: string } {
  const named = HOUSEHOLD.find((h) => h.name === f.label && h.type === f.type);
  if (minute !== null && named && f.scene === 'home') {
    const span = householdAt(named.name, minute);
    return {
      place: capWords(doing(span)),
      detail: `${KIND_WORDS[f.type]} · since ${clock(span.since)}`,
    };
  }
  return { place: capWords(memberPlace(f, fixtures).text), detail: KIND_WORDS[f.type] };
}
const clock = (minute: number) =>
  `${Math.floor(minute / 60)}:${String(Math.floor(minute % 60)).padStart(2, '0')}`;
