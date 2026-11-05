import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRequire } from 'node:module';
import { HelpMenu } from '@/components/shell/help-menu';
import { MARKETING_CHANGELOG_URL, MARKETING_URL } from '@/lib/marketing-site';

// The desktop shell's own policy, so the claim below is about the code that
// decides, not a copy of it.
const require = createRequire(import.meta.url);
const policy = require('../../electron/lib/policy.cjs') as {
  isAppUrl: (raw: string) => boolean;
  externalAllowed: (raw: string) => boolean;
};

afterEach(cleanup);

describe('links from the app to dsul.app', () => {
  it('point at the apex, which the desktop shell opens in the browser rather than over the planner', () => {
    expect(MARKETING_URL).toBe('https://dsul.app');
    expect(MARKETING_CHANGELOG_URL).toBe('https://dsul.app/#changelog');
    for (const url of [MARKETING_URL, MARKETING_CHANGELOG_URL]) {
      expect(policy.isAppUrl(url), url).toBe(false);
      expect(policy.externalAllowed(url), url).toBe(true);
    }
    // The preview path on the app's own host would load inside the window.
    expect(policy.isAppUrl('https://do.dsul.app/welcome')).toBe(true);
  });

  it("the help menu's What's new opens the changelog in a new tab", async () => {
    render(<HelpMenu />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Help' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    });
    const row = await screen.findByRole('menuitem', { name: /What’s new/ });
    expect(row.tagName).toBe('A');
    expect(row.getAttribute('href')).toBe(MARKETING_CHANGELOG_URL);
    expect(row.getAttribute('target')).toBe('_blank');
    expect(row.getAttribute('rel')).toContain('noopener');
    // The two dialog rows are still there.
    expect(screen.getByRole('menuitem', { name: /Keyboard shortcuts/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Send feedback/ })).toBeTruthy();
  });
});
