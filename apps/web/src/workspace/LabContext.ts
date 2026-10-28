import { createContext, useContext } from 'react';
import type { Lab } from './useLabState';

export const LabContext = createContext<Lab | null>(null);
/** The lab's state and actions, for any part of the workspace. */
export function useLab(): Lab {
  const lab = useContext(LabContext);
  if (!lab) throw new Error('useLab must be used inside the lab workspace.');
  return lab;
}
