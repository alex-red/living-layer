import { useEffect, useState } from 'react';

/**
 * The time now, updated every `intervalMs`. Call it in the component that shows
 * a time-dependent label, so the tick re-renders that component alone.
 */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
