import { Suspense, type ReactNode } from 'react';

/** A quiet placeholder for a part of the page that loads on first use. */
export function Later({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <span className="micro" role="status">
          Loading…
        </span>
      }
    >
      {children}
    </Suspense>
  );
}
