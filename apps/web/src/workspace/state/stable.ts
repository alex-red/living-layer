import { useRef } from 'react';

type Keys<T> = readonly (keyof T)[];

function sameFields(a: Record<PropertyKey, unknown>, b: Record<PropertyKey, unknown>) {
  const keys = Reflect.ownKeys(b);
  if (Reflect.ownKeys(a).length !== keys.length) return false;
  return keys.every((key) => Object.is(a[key], b[key]));
}

/**
 * A slice that keeps its identity until a value in it changes, so the panes
 * reading it render for a change they can see and not for every render of the
 * lab.
 *
 * Each function in the slice is replaced by one fixed function that calls the
 * newest version, so a handler made in an earlier render never goes stale and
 * its identity never counts as a change. A function a pane calls while it
 * renders (a getter that reads state) is the exception: list it in `getters`
 * and make it with `useCallback`, so it changes when what it reads changes.
 */
export function useStableSlice<T extends object>(value: T, getters: Keys<T> = []): T {
  const latest = useRef(value);
  latest.current = value;
  const calls = useRef(new Map<PropertyKey, unknown>());
  const previous = useRef<T | null>(null);
  const fields: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const field = (value as Record<PropertyKey, unknown>)[key];
    if (typeof field !== 'function' || getters.includes(key as keyof T)) {
      fields[key] = field;
      continue;
    }
    let call = calls.current.get(key);
    if (!call) {
      call = (...args: unknown[]) =>
        ((latest.current as Record<PropertyKey, unknown>)[key] as (...a: unknown[]) => unknown)(
          ...args,
        );
      calls.current.set(key, call);
    }
    fields[key] = call;
  }
  const before = previous.current;
  if (before && sameFields(before as Record<PropertyKey, unknown>, fields)) return before;
  previous.current = fields as T;
  return fields as T;
}
