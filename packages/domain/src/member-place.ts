import type { Fixture } from './fixture.js';

/** Where a person or pet is, as the room's things say it: home or out, sitting, asleep. */
export interface MemberPlace {
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
