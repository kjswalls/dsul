import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { STATIC_COMMANDS, type Command, type CommandContext } from '@/lib/commands';
import { useUIStore } from '@/lib/ui-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { CONNECTED_MODEL, KEY_TURNED_DOWN, NOTHING_CONNECTED, seedAI } from './helpers/ai-fixtures';

/**
 * The three workspace bindings that drive the two omnibar shells. Their run()
 * side-effects ARE the seam between the docked capture bar and the summoned
 * launcher, so pin them:
 *   ⌘K  system_search  → open the launcher (desktop) / focus the dock (mobile)
 *   /   system_command → open the launcher already in command mode
 *   ⌘I  system_capture → focus the sidebar capture bar (reveal, then focus)
 */

const desktop: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'u',
  isMobile: false,
};
const mobile: CommandContext = { ...desktop, isMobile: true };

function cmd(id: string): Command {
  const command = STATIC_COMMANDS.find((c) => c.id === id);
  if (!command) throw new Error(`no such command: ${id}`);
  return command;
}

beforeEach(() => {
  useUIStore.setState({ activeDialog: null, omnibarFocusToken: 0 });
  useSidebarStore.setState({ leftSidebarOpen: false });
  useMobileNavStore.setState({ activeTab: 'today' });
});

describe('omnibar shell bindings', () => {
  it('⌘K opens the launcher on desktop', () => {
    cmd('workspace.focusOmnibar').run(desktop);
    expect(useUIStore.getState().activeDialog).toEqual({ type: 'launcher' });
  });

  it('⌘K on mobile focuses the docked omnibar rather than opening a launcher', () => {
    const before = useUIStore.getState().omnibarFocusToken;
    cmd('workspace.focusOmnibar').run(mobile);
    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(useUIStore.getState().omnibarFocusToken).toBe(before + 1);
  });

  it('⌘K on mobile leaves the Chat tab (which unmounts the omnibar)', () => {
    useMobileNavStore.setState({ activeTab: 'chat' });
    cmd('workspace.focusOmnibar').run(mobile);
    expect(useMobileNavStore.getState().activeTab).toBe('today');
  });

  it('/ opens the launcher already in command mode (seeds "/")', () => {
    cmd('workspace.openCommandLauncher').run(desktop);
    expect(useUIStore.getState().activeDialog).toEqual({ type: 'launcher', query: '/' });
  });

  it('⌘I reveals the sidebar and focuses the capture bar (not a dialog)', () => {
    const before = useUIStore.getState().omnibarFocusToken;
    cmd('workspace.focusCapture').run(desktop);
    expect(useSidebarStore.getState().leftSidebarOpen).toBe(true);
    expect(useUIStore.getState().omnibarFocusToken).toBe(before + 1);
    // Capture is the docked bar, never the launcher modal.
    expect(useUIStore.getState().activeDialog).toBeNull();
  });

  it('⌘I on mobile switches off the Chat tab, then focuses', () => {
    useMobileNavStore.setState({ activeTab: 'chat' });
    const before = useUIStore.getState().omnibarFocusToken;
    cmd('workspace.focusCapture').run(mobile);
    expect(useMobileNavStore.getState().activeTab).toBe('today');
    expect(useUIStore.getState().omnibarFocusToken).toBe(before + 1);
  });
});

/**
 * The phone's `chat` tab is Ask while something answers, and the setup page
 * (or the fix home) while the gate offers one instead. Ask's composer takes
 * the dock's omnibar away, so the three runs above leave the tab to reach it;
 * the setup page keeps the omnibar (F17), so from there they stay put and
 * only focus it. The unseeded cases above are the gate unknown, which offers
 * no setup page, so they still land on Today.
 */
describe('the phone runs on the setup page', () => {
  let unseed: () => void = () => {};
  afterEach(() => {
    unseed();
    unseed = () => {};
  });

  const RUNS = ['workspace.focusOmnibar', 'workspace.openCommandLauncher', 'workspace.focusCapture'];

  it.each([
    ['nothing connected (the setup page)', NOTHING_CONNECTED],
    ['a key turned down (the fix home)', KEY_TURNED_DOWN],
  ])('stay on the chat tab with %s, and focus the omnibar', (_label, seed) => {
    unseed = seedAI(seed);
    for (const id of RUNS) {
      useMobileNavStore.setState({ activeTab: 'chat' });
      const before = useUIStore.getState().omnibarFocusToken;
      cmd(id).run(mobile);
      expect(useMobileNavStore.getState().activeTab, id).toBe('chat');
      expect(useUIStore.getState().omnibarFocusToken, id).toBe(before + 1);
    }
  });

  it('leave Ask for Today when something answers, since its composer replaces the omnibar', () => {
    unseed = seedAI(CONNECTED_MODEL);
    for (const id of RUNS) {
      useMobileNavStore.setState({ activeTab: 'chat' });
      const before = useUIStore.getState().omnibarFocusToken;
      cmd(id).run(mobile);
      expect(useMobileNavStore.getState().activeTab, id).toBe('today');
      expect(useUIStore.getState().omnibarFocusToken, id).toBe(before + 1);
    }
  });
});
