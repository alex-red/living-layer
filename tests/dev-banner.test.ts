import { describe, expect, it } from 'bun:test';
import { devBanner } from '../scripts/lib/dev-banner.js';

describe('the dev script’s banner', () => {
  it('points at the dev page, and calls the API server’s page the last build', () => {
    const text = devBanner({
      webPort: 43430,
      apiPort: 43431,
      builtAt: new Date(2026, 10, 3, 15, 47),
    });
    expect(text).toContain('Open the lab:  http://127.0.0.1:43430');
    expect(text).toContain("its own page at :43431 is the last build's, from 2026-11-03 15:47");
  });
  it('names the network address when there is one', () => {
    const text = devBanner({ webPort: 43430, apiPort: 43431, builtAt: null, lan: '192.168.1.20' });
    expect(text).toContain('http://192.168.1.20:43430');
  });
  it('says when nothing is built', () => {
    const text = devBanner({ webPort: 43430, apiPort: 43431, builtAt: null });
    expect(text).toContain('none: nothing is built');
  });
});
