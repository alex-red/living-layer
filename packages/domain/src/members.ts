import { catItem } from './iso-archetypes.js';
import type { IsoItem } from './iso-item.js';
import {
  DOG_CM,
  DOG_LYING_CM,
  PERSON_CM,
  dogItem,
  personItem,
  type PersonLook,
  type PetLook,
} from './member-models.js';

/**
 * The household ([plan](../../../docs/plans/people-and-pets.md)): people and
 * pets are Things of a member type, added by name alone. Each gets one of
 * its kind's looks, picked from its name so two people don't come out the
 * same, and kept on it (`look`), so renaming keeps it. A person sits by
 * being drawn into their seat's model (`seating.ts`).
 */
const MEMBER_TYPES = ['person', 'cat', 'dog'] as const;
export type MemberType = (typeof MEMBER_TYPES)[number];
export const isMemberType = (t: unknown): t is MemberType =>
  (MEMBER_TYPES as readonly unknown[]).includes(t);
/** Whether a thing is one of the household. */
export const isMember = (f: { type?: string | undefined }) => isMemberType(f.type);

const PERSON_LOOKS: Record<string, PersonLook> = {
  'person-blue': {
    skin: '#e8b894',
    hair: '#3b2a20',
    hairStyle: 'short',
    top: '#4f7bb5',
    bottom: '#3a3f4b',
    shoes: '#2a2a2e',
  },
  'person-coral': {
    skin: '#b07a55',
    hair: '#1d1a1a',
    hairStyle: 'long',
    top: '#c9604d',
    bottom: '#4a5468',
    shoes: '#efe9df',
  },
  'person-mustard': {
    skin: '#7a5038',
    hair: '#141010',
    hairStyle: 'bun',
    top: '#e3b54b',
    bottom: '#2f3a33',
    shoes: '#3b2f28',
  },
  'person-sage': {
    skin: '#f0c9a8',
    hair: '#b5793d',
    hairStyle: 'long',
    top: '#5d8a6b',
    bottom: '#6b5b4b',
    shoes: '#2a2a2e',
  },
};
const CAT_LOOKS: Record<string, PetLook> = {
  'cat-ginger': { body: '#d88b4b', accent: '#f2e6d8', ear: '#d88b4b' },
  'cat-grey': { body: '#8f939b', accent: '#e8e5df', ear: '#8f939b' },
  // No black coats: the rooms' floors are dark, and a black cat on one is a hole.
  'cat-cream': { body: '#e6d3b3', accent: '#fbf6ee', ear: '#e6d3b3' },
};
const DOG_LOOKS: Record<string, PetLook> = {
  'dog-golden': { body: '#d9a55b', accent: '#f3e2c0', ear: '#a86f35' },
  'dog-brown': { body: '#7a4e2d', accent: '#d8b48a', ear: '#4f3220' },
  'dog-white': { body: '#ece6dc', accent: '#c9b9a4', ear: '#b89a7a' },
};
const LOOKS = { person: PERSON_LOOKS, cat: CAT_LOOKS, dog: DOG_LOOKS } as const;

/** The look a new member of this name gets: the same name always picks the same one. */
export function lookFor(type: MemberType, name: string): string {
  const keys = Object.keys(LOOKS[type]);
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return keys[h % keys.length]!;
}
/** A member's look by its key, else the one its name picks. */
function lookOf<T extends MemberType>(type: T, key: string | undefined, name: string) {
  const looks = LOOKS[type] as Record<string, (typeof LOOKS)[T][string]>;
  return looks[key ?? ''] ?? looks[lookFor(type, name)]!;
}
export const personLook = (key: string | undefined, name: string) => lookOf('person', key, name);

/** Each member's poses: its first is how it is added. */
export const MEMBER_POSES: Record<MemberType, readonly string[]> = {
  person: ['standing'],
  cat: ['idle', 'sleeping'],
  dog: ['standing', 'lying'],
};
/** Each member's real size in a pose, cm. */
export function memberSizeCm(type: MemberType, pose?: string): { w: number; d: number; h: number } {
  if (type === 'person') return PERSON_CM;
  if (type === 'dog') return pose === 'lying' ? DOG_LYING_CM : DOG_CM;
  return pose === 'sleeping' ? { w: 28, d: 26, h: 18 } : { w: 26, d: 28, h: 32 };
}

/** A member's model in a pose (its first when none is given), in its look. */
export function memberItem(
  type: MemberType,
  label: string,
  look?: string,
  pose: string = MEMBER_POSES[type][0]!,
): IsoItem {
  if (type === 'person') return personItem(label, lookOf('person', look, label));
  if (type === 'dog')
    return dogItem(label, lookOf('dog', look, label), pose === 'lying' ? 'lying' : 'standing');
  const cat = lookOf('cat', look, label);
  return catItem(label, pose === 'sleeping' ? 'sleeping' : 'idle', [cat.body, cat.accent]);
}
/** A member's colours, main first, as a model's swatches keep them. */
export function memberColors(type: MemberType, label: string, look?: string): string[] {
  if (type === 'person') {
    const p = lookOf('person', look, label);
    return [p.top, p.bottom, p.skin, p.hair];
  }
  const p = lookOf(type, look, label);
  return [p.body, p.accent];
}
