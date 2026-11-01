/**
 * Why a browser test failed, on one screen, from its trace (`lib/trace.ts`):
 * the failing step and locator, the steps, `/api` requests, console errors
 * and dialogs before it, and the page around the locator.
 *
 *   bun run trace                 every failure of the latest run
 *   bun run trace brush           the latest failure whose test name or folder matches
 *   bun run trace <results folder>
 *
 * It reads `out/browser/test-results` (`bun run browser`) and
 * `test-results` (`bun run test:browser`).
 */
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { browserOut } from './lib/browser.js';
import { failureFolders, testName, traceSummary } from './lib/trace.js';
import { repoRoot } from './lib/worktree.js';

const query = process.argv[2];
let folders: string[];
if (query && existsSync(join(query, 'error-context.md'))) folders = [query];
else {
  const all = failureFolders([join(browserOut(), 'test-results'), join(repoRoot, 'test-results')]);
  if (query) {
    const q = query.toLowerCase();
    folders = all
      .filter((f) => f.toLowerCase().includes(q) || testName(f).toLowerCase().includes(q))
      .slice(0, 1);
  } else {
    // The latest run is the results root of the newest failure.
    const latest = all[0] && dirname(all[0]);
    folders = all.filter((f) => dirname(f) === latest);
  }
}
if (!folders.length) {
  console.log(
    query
      ? `No failed test matching "${query}" in out/browser/test-results or test-results.`
      : 'No failed tests in out/browser/test-results or test-results.',
  );
  process.exit(1);
}
for (const folder of folders) {
  console.log(`✗ ${testName(folder)}\n  ${relative(repoRoot, folder)}\n`);
  console.log(
    traceSummary(folder)
      .map((l) => `  ${l}`)
      .join('\n'),
  );
  console.log();
}
