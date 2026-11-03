import { useEffect, useState } from 'react';

/**
 * Whether this page is showing. A page holds its event streams only while it
 * is: a browser opens at most six connections to one host, and each tab's
 * streams stay open, so a few tabs left in the background would hold them all
 * and every other request, the save the page loads first among them, would
 * wait for good.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  return visible;
}
