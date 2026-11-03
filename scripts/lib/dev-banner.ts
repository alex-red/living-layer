/**
 * What `bun run dev` says once both servers answer: which address is the lab,
 * and that the API server's own page is the last build, not the code on disk.
 * Both servers serve a page, and opening the API's one shows old code.
 */
export function devBanner({
  webPort,
  apiPort,
  builtAt,
}: {
  webPort: number;
  apiPort: number;
  /** When `apps/web/dist` was last built, or null when it never was. */
  builtAt: Date | null;
}): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const built = builtAt
    ? `the last build's, from ${builtAt.getFullYear()}-${two(builtAt.getMonth() + 1)}-${two(builtAt.getDate())} ${two(builtAt.getHours())}:${two(builtAt.getMinutes())}`
    : 'none: nothing is built';
  return [
    '',
    `  Open the lab:  http://127.0.0.1:${webPort}   this code, as you edit it`,
    `  API server:    http://127.0.0.1:${apiPort}/api   the lab talks to it through the page`,
    `                 its own page at :${apiPort} is ${built}`,
    '',
  ].join('\n');
}
