import { useEffect } from 'react';
import type { DesktopNodeView, Mode } from '@livinglayer/domain';
import { api } from '../../api';
import { createStore, useStore } from './store';

/**
 * The desktop nodes the server sees, by mode, as `/api/nodes/list` last said.
 * A store, not lab state: it is asked for again every few seconds while the
 * Desktops panel is open, and only what shows nodes renders for it.
 */
const nodesStore = createStore<Partial<Record<Mode, DesktopNodeView[]>>>({});

/** Keep what the server just said about a mode's nodes. */
export function keepNodes(mode: Mode, nodes: DesktopNodeView[]) {
  nodesStore.set((current) => ({ ...current, [mode]: nodes }));
}

let loads = 0;
/** Ask the server again; a newer ask wins over an older one still on its way. */
async function loadNodes(mode: Mode) {
  const mine = ++loads;
  const { nodes } = await api('nodes/list', { mode });
  if (mine === loads) keepNodes(mode, nodes);
}

const NONE: DesktopNodeView[] = [];

/** A mode's nodes, loaded once on use, and again every `pollMs` while it is given. */
export function useDesktopNodes(mode: Mode, pollMs?: number): DesktopNodeView[] {
  useEffect(() => {
    const load = () => void loadNodes(mode).catch(() => {});
    load();
    if (!pollMs) return;
    const timer = setInterval(load, pollMs);
    return () => clearInterval(timer);
  }, [mode, pollMs]);
  return useStore(nodesStore, (s) => s[mode] ?? NONE);
}

/** The node whose display an entity is, if it is one. */
export function nodeOfEntity(nodes: DesktopNodeView[], entity: string | null | undefined) {
  return entity ? (nodes.find((n) => n.entityId === entity) ?? null) : null;
}
