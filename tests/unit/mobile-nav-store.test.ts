import { describe, it, expect } from 'vitest';

/**
 * lib/mobile-nav-store.ts's one "offered" rule: the phone's third surface is
 * Ask while something answers, the setup page or the fix home while the gate
 * offers one, and nothing while the gate is unknown, failed or told No AI.
 * How the shell, the sheet and the dock read it is ai-gating-mobile-item's.
 */

import { chatOffered, mobileTabOrder, setupPageShown, shownMobileTab } from '@/lib/mobile-nav-store';
import {
  AI_HIDDEN,
  CONNECTED_MODEL,
  KEY_TURNED_DOWN,
  NOTHING_CONNECTED,
  OPENCLAW_PLUGIN,
  capsFor,
  type SeedAI,
} from './helpers/ai-fixtures';

describe('the offered rule', () => {
  it.each<[string, SeedAI | undefined, boolean, boolean]>([
    ['connected', CONNECTED_MODEL, true, false],
    ['OpenClaw answering', OPENCLAW_PLUGIN, true, false],
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
    expect(mobileTabOrder(chatOffered(caps))).toEqual(offered ? ['braindump', 'today', 'chat'] : ['braindump', 'today']);
    expect(shownMobileTab('chat', chatOffered(caps))).toBe(offered ? 'chat' : 'today');
    expect(shownMobileTab('braindump', chatOffered(caps))).toBe('braindump');
  });
});
