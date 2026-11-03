import type { ExposedState } from '@livinglayer/domain';

/** A state as the outline and inspector show it. */
export function stateLabel(s: ExposedState | undefined): string {
  if (!s) return 'waiting';
  if (!s.available) return 'unavailable';
  if (s.kind === 'button') return 'button';
  if (s.kind === 'event') return s.state ? `last: ${s.state}` : 'no events yet';
  return s.kind === 'binary_sensor' ? (s.state === 'ON' ? 'on' : 'off') : (s.state ?? '');
}
