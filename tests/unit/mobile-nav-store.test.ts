import { describe, it, expect } from 'vitest';

/**
 * lib/mobile-nav-store.ts's one "offered" rule: the phone's third surface is
 * Ask while something answers, the setup page or the fix home while the gate
 * offers one, and nothing while the gate is unknown, failed or told No AI.
 * How the shell, the sheet and the dock read it is ai-gating-mobile-item's.
 */

import {
  chatOffered,
  mobileTabOrder,
  setupPageShown,
  showMobileSurface,
  shownMobileTab,
  useMobileNavStore,
} from '@/lib/mobile-nav-store';
import {
  AI_HIDDEN,
  CONNECTED_MODEL,
  KEY_TURNED_DOWN,
  NOTHING_CONNECTED,
  OPENCLAW_CHAT,
  capsFor,
  type SeedAI,
} from './helpers/ai-fixtures';

describe('the offered rule', () => {
  it.each<[string, SeedAI | undefined, boolean, boolean]>([
    ['connected', CONNECTED_MODEL, true, false],
    ['OpenClaw answering', OPENCLAW_CHAT, true, false],
    ['invited', NOTHING_CONNECTED, true, true],
    ['a key to fix', KEY_TURNED_DOWN, true, true],
    ['No AI', AI_HIDDEN, false, false],
    ['chat Off on this device', { ...NOTHING_CONNECTED, choice: 'none' }, false, false],
    ['an agent key only', { ...NOTHING_CONNECTED, openclaw: { agent: true } }, false, false],
    ['the gate failed', { ...NOTHING_CONNECTED, phase: 'error' }, false, false],
    ['the gate unknown', undefined, false, false],
  ])('%s: offered %s, the setup page %s', (_label, seed, offered, setupPage) => {
    const caps = capsFor(seed);
    expect(chatOffered(caps)).toBe(offered);
    expect(setupPageShown(caps)).toBe(setupPage);
    expect(mobileTabOrder(chatOffered(caps))).toEqual(offered ? ['today', 'chat'] : ['today']);
    expect(shownMobileTab('chat', chatOffered(caps))).toBe(offered ? 'chat' : 'today');
    expect(shownMobileTab('today', chatOffered(caps))).toBe('today');
  });
});

/**
 * Braindump is a sheet over Today, not a tab (mobile web round 3): opening it
 * lands on Today, any tab change closes it, and the dock unfolds on a tab
 * change.
 */
describe('the braindump sheet and the fold', () => {
  it('opens over Today and closes on a tab change', () => {
    useMobileNavStore.setState({ activeTab: 'chat', braindumpOpen: false, dockMinimized: true });
    showMobileSurface('braindump');
    expect(useMobileNavStore.getState()).toMatchObject({ activeTab: 'today', braindumpOpen: true });
    showMobileSurface('chat');
    expect(useMobileNavStore.getState()).toMatchObject({
      activeTab: 'chat',
      braindumpOpen: false,
      dockMinimized: false,
    });
    showMobileSurface('braindump');
    useMobileNavStore.getState().setBraindumpOpen(false);
    expect(useMobileNavStore.getState()).toMatchObject({ activeTab: 'today', braindumpOpen: false });
  });
});
