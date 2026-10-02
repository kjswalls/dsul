import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ASK_OPEN_DEFAULT, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, useSidebarStore } from '@/lib/sidebar-store';

/**
 * sidebar-store v3 (AI step 2a): the left-dock chat is gone, and `askOpen`
 * ("Ask rests open in the right rail") replaces `chatExpanded`. It is a NEW
 * surface, so an old record's chat flag is not carried onto it: everyone
 * starts at ASK_OPEN_DEFAULT, which is CLOSED (Kirby, 2026-10-02: Ask starts
 * closed, with an Ask button to open it). One constant decides both the
 * default and the migration, so flipping it is the whole change; the tests
 * below read it rather than a literal, except the one that pins its value.
 */

const KEY = 'dsul-sidebar-settings';

async function rehydrateFrom(record: unknown) {
  localStorage.setItem(KEY, JSON.stringify(record));
  await useSidebarStore.persist.rehydrate();
  return useSidebarStore.getState();
}

beforeEach(() => {
  localStorage.removeItem(KEY);
  useSidebarStore.setState({
    leftSidebarOpen: true,
    askOpen: ASK_OPEN_DEFAULT,
    leftSidebarHoverEnabled: false,
    leftSidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  });
});

describe('the default', () => {
  it('is closed: Ask starts closed, and the Ask button opens it', () => {
    expect(ASK_OPEN_DEFAULT).toBe(false);
  });

  it("is the store's own initial value, before anything is stored", async () => {
    vi.resetModules();
    localStorage.removeItem(KEY);
    const fresh = await import('@/lib/sidebar-store');
    expect(fresh.useSidebarStore.getState().askOpen).toBe(fresh.ASK_OPEN_DEFAULT);
  });
});

describe('the v3 shape', () => {
  it('setAskOpen is the only way to change it, either way', () => {
    const s = useSidebarStore.getState();
    expect(s.askOpen).toBe(ASK_OPEN_DEFAULT);
    s.setAskOpen(!ASK_OPEN_DEFAULT);
    expect(useSidebarStore.getState().askOpen).toBe(!ASK_OPEN_DEFAULT);
    s.setAskOpen(false);
    expect(useSidebarStore.getState().askOpen).toBe(false);
    // The left-dock chat's API is gone, not aliased.
    expect('chatExpanded' in useSidebarStore.getState()).toBe(false);
    expect('setChatExpanded' in useSidebarStore.getState()).toBe(false);
    expect('toggleChat' in useSidebarStore.getState()).toBe(false);
  });

  it('persists askOpen beside the other chrome, at version 3', () => {
    useSidebarStore.getState().setAskOpen(false);
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.version).toBe(3);
    expect(Object.keys(stored.state).sort()).toEqual(
      ['askOpen', 'leftSidebarHoverEnabled', 'leftSidebarOpen', 'leftSidebarWidth'].sort()
    );
    expect(stored.state.askOpen).toBe(false);
  });

  it('a closed Ask stays closed across a reload', async () => {
    const s = await rehydrateFrom({ version: 3, state: { leftSidebarOpen: true, askOpen: false, leftSidebarHoverEnabled: false, leftSidebarWidth: 500 } });
    expect(s.askOpen).toBe(false);
    expect(s.leftSidebarWidth).toBe(500);
  });

  it('an Ask the user opened stays open across a reload, whatever the default', async () => {
    const s = await rehydrateFrom({ version: 3, state: { leftSidebarOpen: true, askOpen: true, leftSidebarHoverEnabled: false, leftSidebarWidth: 500 } });
    expect(s.askOpen).toBe(true);
  });
});

describe('the migration', () => {
  it('v2: chatExpanded is dropped, Ask starts at the default, and the rest is carried', async () => {
    for (const chatExpanded of [true, false]) {
      useSidebarStore.setState({ askOpen: !ASK_OPEN_DEFAULT });
      const s = await rehydrateFrom({
        version: 2,
        state: { leftSidebarOpen: false, chatExpanded, leftSidebarHoverEnabled: true, leftSidebarWidth: 512 },
      });
      expect(s.askOpen).toBe(ASK_OPEN_DEFAULT);
      expect(s.leftSidebarOpen).toBe(false);
      expect(s.leftSidebarHoverEnabled).toBe(true);
      expect(s.leftSidebarWidth).toBe(512);
      expect('chatExpanded' in s).toBe(false);
    }
  });

  it("v1: the old right sidebar's flag is not Ask's either", async () => {
    for (const rightSidebarOpen of [true, false]) {
      useSidebarStore.setState({ askOpen: !ASK_OPEN_DEFAULT });
      const v1 = await rehydrateFrom({ version: 1, state: { leftSidebarOpen: true, rightSidebarOpen } });
      expect(v1.askOpen).toBe(ASK_OPEN_DEFAULT);
    }
    const s = useSidebarStore.getState();
    expect(s.leftSidebarOpen).toBe(true);
    expect(s.leftSidebarHoverEnabled).toBe(false);
    expect(s.leftSidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("a stored width still comes back through the clamp", async () => {
    const s = await rehydrateFrom({ version: 2, state: { leftSidebarOpen: true, chatExpanded: false, leftSidebarWidth: 99999 } });
    expect(s.leftSidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('a missing or empty record migrates to the defaults', () => {
    const migrate = useSidebarStore.persist.getOptions().migrate!;
    expect(migrate(undefined, 2)).toEqual({
      leftSidebarOpen: true,
      askOpen: ASK_OPEN_DEFAULT,
      leftSidebarHoverEnabled: false,
      leftSidebarWidth: undefined,
    });
  });
});
