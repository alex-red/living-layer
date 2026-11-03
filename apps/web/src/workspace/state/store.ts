import { useSyncExternalStore } from 'react';

/**
 * A small value kept outside React's tree, read with `useSyncExternalStore`
 * (as `activity.ts` does). Only the components that call `useStore` on it
 * render when it changes, however often that is.
 */
interface Store<T> {
  get(): T;
  /** Replace the value, or compute the next from the current one. */
  set(next: T | ((current: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === 'function' ? (next as (current: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The store's value, re-rendering the caller when it changes. */
export function useStore<T>(store: Store<T>): T;
/** Part of the store's value; the caller renders only when that part changes (by `Object.is`). */
export function useStore<T, S>(store: Store<T>, select: (value: T) => S): S;
export function useStore<T, S>(store: Store<T>, select?: (value: T) => S): T | S {
  return useSyncExternalStore(store.subscribe, () => (select ? select(store.get()) : store.get()));
}
