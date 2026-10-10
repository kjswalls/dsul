import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, render } from '@testing-library/react';

/**
 * The first-run toasts as the shell mounts them (components/shell/app-shell.tsx
 * FirstRunNudges). tests/unit/nudges.test.ts pins both gates' truth tables;
 * this pins that the shell feeds them the real stores and the tour's answer, so
 * a new account's first frame, the tour, and a habit-less account get no streak
 * toast, the streak toast comes once the tour is over and a habit exists, the
 * rituals one takes its turn after it (or alone, with no habit), and a toast
 * already up never sits over the tour or outlives its account. The rituals
 * intro also waits out what the tour's last card can leave on screen: AI setup
 * (the desktop's column, the phone's setup page), the "It works." a connect
 * there ends on, and an undo row such as No AI's. Those cases mount closed and
 * then open, as AppShell does (`tourAnsweredFor` null at mount): the phone's
 * width is measured in an effect, so a mount with every gate open would read
 * the desktop's rule on its first frame and fire before the phone's could hold.
 */

const sonner = vi.hoisted(() => ({ toast: vi.fn(), dismiss: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(sonner.toast, { error: vi.fn(), dismiss: sonner.dismiss }),
}));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));
vi.mock('@/lib/nudges/service', () => ({
  loadDismissedNudges: vi.fn(async () => []),
  saveDismissedNudges: vi.fn(async () => {}),
  resetDismissedNudges: vi.fn(async () => {}),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { FirstRunNudges } from '@/components/shell/app-shell';
import { usePlannerStore } from '@/lib/planner-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useNudgeStore } from '@/lib/nudge-store';
import { useMorningStore } from '@/lib/morning-store';
import { saveDismissedNudges } from '@/lib/nudges/service';
import { EXT_STREAKS } from '@/lib/extension-registry';
import { disableExtensions, enableExtensions } from './support/extensions';
import { railModeNow, useRailStore } from '@/lib/rail-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { useUndoStripStore } from '@/lib/undo-strip-store';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { CONNECTED_MODEL, NOTHING_CONNECTED, seedAI } from './helpers/ai-fixtures';

const USER = 'user-1';
const HABIT = { id: 'h1', type: 'habit', title: 'Stretch' } as never;
const TASK = { id: 't1', type: 'task', title: 'Call the dentist' } as never;

function seed({ habits }: { habits: unknown[] }) {
  usePlannerStore.setState({ userId: USER, habits: habits as never });
  useExtensionsStore.setState({ configsLoaded: true });
  useNudgeStore.setState({ dismissed: [], hydratedUserId: USER });
}

const width = window.innerWidth;
function setWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: px });
}
let cleanupAI: (() => void) | null = null;

beforeEach(() => {
  // Streaks ship off, so the toast that says they are on is for someone who
  // switched them on; these tests are about when it speaks.
  enableExtensions(EXT_STREAKS);
  sonner.toast.mockClear();
  sonner.dismiss.mockClear();
  vi.mocked(saveDismissedNudges).mockClear();
});

afterEach(() => {
  cleanup();
  usePlannerStore.setState({ userId: null, habits: [], tasks: [] });
  useMorningStore.setState({ settingsHydratedUserId: null });
  useExtensionsStore.setState({ configsLoaded: false, enabled: {} });
  useNudgeStore.getState().reset();
  cleanupAI?.();
  cleanupAI = null;
  useAIConnectionStore.getState().reset();
  useRailStore.setState({ summoned: false });
  useMobileNavStore.setState({ activeTab: 'today' });
  useUndoStripStore.setState({ entry: null });
  setWidth(width);
});

const titles = () => sonner.toast.mock.calls.map((c: unknown[]) => c[0]);
const RITUALS = 'Two quiet rituals, if you want them';

/** An account the rituals intro is ready for: something planned, no habit, both rituals off. */
function seedRitualsReady() {
  seed({ habits: [] });
  usePlannerStore.setState({ tasks: [TASK] });
  useMorningStore.setState({ settingsHydratedUserId: USER });
}

/** Mounted as AppShell mounts it: no answer yet, then the tour's answer with no tour to show. */
function mountThenAnswer() {
  const view = render(<FirstRunNudges tourAnsweredFor={null} tourShowing={false} />);
  view.rerender(<FirstRunNudges tourAnsweredFor={USER} tourShowing={false} />);
  return view;
}

describe('the first-run toasts in the shell', () => {
  it('stays quiet while the tour shows, and speaks once it is over', () => {
    seed({ habits: [HABIT] });
    const { rerender } = render(<FirstRunNudges tourAnsweredFor={USER} tourShowing />);
    expect(sonner.toast).not.toHaveBeenCalled();
    rerender(<FirstRunNudges tourAnsweredFor={USER} tourShowing={false} />);
    expect(sonner.toast).toHaveBeenCalledTimes(1);
    expect(sonner.toast.mock.calls[0][0]).toBe('Streaks are on');
  });

  it("waits for the tour's answer before speaking", () => {
    seed({ habits: [HABIT] });
    const { rerender } = render(<FirstRunNudges tourAnsweredFor={null} tourShowing={false} />);
    expect(sonner.toast).not.toHaveBeenCalled();
    rerender(<FirstRunNudges tourAnsweredFor={USER} tourShowing={false} />);
    expect(sonner.toast).toHaveBeenCalledTimes(1);
  });

  it("never speaks for one account on another account's tour answer", () => {
    seed({ habits: [HABIT] });
    usePlannerStore.setState({ userId: 'user-2' });
    useNudgeStore.setState({ hydratedUserId: 'user-2' });
    const { rerender } = render(<FirstRunNudges tourAnsweredFor={USER} tourShowing={false} />);
    expect(sonner.toast).not.toHaveBeenCalled();
    rerender(<FirstRunNudges tourAnsweredFor="user-2" tourShowing={false} />);
    expect(sonner.toast).toHaveBeenCalledTimes(1);
  });

  it('says nothing to an account with no habit, until it has one', () => {
    seed({ habits: [] });
    render(<FirstRunNudges tourAnsweredFor={USER} tourShowing={false} />);
    expect(sonner.toast).not.toHaveBeenCalled();
    act(() => usePlannerStore.setState({ habits: [HABIT] }));
    expect(sonner.toast).toHaveBeenCalledTimes(1);
  });

  it('waits for the extensions store to answer', () => {
    seed({ habits: [HABIT] });
    useExtensionsStore.setState({ configsLoaded: false });
    render(<FirstRunNudges tourAnsweredFor={USER} tourShowing={false} />);
    expect(sonner.toast).not.toHaveBeenCalled();
    act(() => useExtensionsStore.setState({ configsLoaded: true }));
    expect(sonner.toast).toHaveBeenCalledTimes(1);
  });

  it('says nothing while streaks are off', () => {
    seed({ habits: [HABIT] });
    disableExtensions(EXT_STREAKS);
    render(<FirstRunNudges tourAnsweredFor={USER} tourShowing={false} />);
    expect(sonner.toast).not.toHaveBeenCalled();
    act(() => enableExtensions(EXT_STREAKS));
    expect(sonner.toast).toHaveBeenCalledTimes(1);
  });

  it('takes a toast already up down while the tour shows, recording nothing', () => {
    // A Replay tour brings the shell back with the last mount's toast still up.
    seed({ habits: [HABIT] });
    render(<FirstRunNudges tourAnsweredFor={USER} tourShowing />);
    expect(sonner.dismiss).toHaveBeenCalledWith('streaks-on');
    expect(sonner.dismiss).toHaveBeenCalledWith('rituals-intro');
    expect(useNudgeStore.getState().dismissed).toEqual([]);
    expect(saveDismissedNudges).not.toHaveBeenCalled();
  });

  it("takes one account's toast down when the account changes, recording nothing", () => {
    seed({ habits: [HABIT] });
    render(<FirstRunNudges tourAnsweredFor={USER} tourShowing={false} />);
    expect(sonner.toast).toHaveBeenCalledTimes(1);
    // A bare switch: the next account's planner arrives empty.
    act(() => usePlannerStore.setState({ userId: 'user-2', habits: [] }));
    expect(sonner.dismiss).toHaveBeenCalledWith('streaks-on');
    expect(saveDismissedNudges).not.toHaveBeenCalled();
  });

  it('lets the rituals intro go first for an account with no habit', () => {
    // No habit means no streak toast to wait behind.
    seed({ habits: [] });
    usePlannerStore.setState({ tasks: [TASK] });
    useMorningStore.setState({ settingsHydratedUserId: USER });
    render(<FirstRunNudges tourAnsweredFor={USER} tourShowing={false} />);
    expect(titles()).toEqual(['Two quiet rituals, if you want them']);
  });

  it('with a habit, the streak toast goes first and the rituals one waits its turn', () => {
    seed({ habits: [HABIT] });
    usePlannerStore.setState({ tasks: [TASK] });
    useMorningStore.setState({ settingsHydratedUserId: USER });
    render(<FirstRunNudges tourAnsweredFor={USER} tourShowing={false} />);
    expect(titles()).toEqual(['Streaks are on']);
    act(() => useNudgeStore.setState({ dismissed: ['streaks-on'] }));
    expect(titles()).toEqual(['Streaks are on', 'Two quiet rituals, if you want them']);
  });

  it('is what AppShell mounts, fed the tour answer from the onboarding read', () => {
    // AppShell itself is too wide to render here, so its two lines of wiring
    // are pinned the way tests/unit/rail-store.test.ts pins the tour's props.
    const shell = readFileSync(path.resolve(__dirname, '../../components/shell/app-shell.tsx'), 'utf8');
    expect(shell).toMatch(/onResult: \(uid, needed\) => \{\s*setTourAnsweredFor\(uid\);/);
    expect(shell).toMatch(/<FirstRunNudges tourAnsweredFor=\{tourAnsweredFor\} tourShowing=\{showTour\} \/>/);
    // The only mounts of either toast are FirstRunNudges' own, fed its gates.
    expect(shell.match(/<OneTimeNudge /g)).toHaveLength(2);
    expect(shell).toMatch(/<OneTimeNudge id=\{NUDGE_STREAKS_ON\} enabled=\{streakNudgeOn\} \/>/);
  });
});

describe('the rituals intro waits out what the tour leaves on screen', () => {
  it('holds while the setup column shows on the desktop, and comes once it parks', () => {
    // The tour's Set up AI summons setup for this session only.
    setWidth(1280);
    cleanupAI = seedAI(NOTHING_CONNECTED);
    seedRitualsReady();
    act(() => useRailStore.getState().summon({ persist: false }));
    expect(railModeNow()).toBe('setup');
    mountThenAnswer();
    expect(titles()).not.toContain(RITUALS);
    act(() => useRailStore.getState().park());
    expect(titles()).toEqual([RITUALS]);
  });

  it('holds through the "It works." a connect ends on, until Ask closes', () => {
    setWidth(1280);
    cleanupAI = seedAI(NOTHING_CONNECTED);
    seedRitualsReady();
    act(() => useRailStore.getState().summon({ persist: false }));
    mountThenAnswer();
    // A key that works: the same summon turns setup into Ask home, saying "It works.".
    act(() => {
      cleanupAI = seedAI(CONNECTED_MODEL);
      useAIConnectionStore
        .getState()
        .setJustConnected({ provider: 'openai', model: 'gpt-4o-mini', freeTier: false, at: Date.now() });
    });
    expect(railModeNow()).toBe('ask');
    expect(titles()).not.toContain(RITUALS);
    // Ask closing spends "It works." (lib/rail-store.ts spendJustConnected).
    act(() => useRailStore.getState().park());
    expect(useAIConnectionStore.getState().justConnected).toBeNull();
    expect(titles()).toEqual([RITUALS]);
  });

  it("holds while the phone's Ask tab shows the setup page, and comes once it is left", () => {
    setWidth(390);
    cleanupAI = seedAI(NOTHING_CONNECTED);
    seedRitualsReady();
    useMobileNavStore.setState({ activeTab: 'chat' });
    mountThenAnswer();
    expect(titles()).not.toContain(RITUALS);
    act(() => useMobileNavStore.setState({ activeTab: 'today' }));
    expect(titles()).toEqual([RITUALS]);
  });

  it("never holds a desktop on a `chat` tab the phone's store kept", () => {
    // The tab is the phone's: a desktop's setup is the column, not summoned here.
    setWidth(1280);
    cleanupAI = seedAI(NOTHING_CONNECTED);
    seedRitualsReady();
    useMobileNavStore.setState({ activeTab: 'chat' });
    mountThenAnswer();
    expect(titles()).toEqual([RITUALS]);
  });

  it("holds while an undo row is up, so it never covers No AI's Undo", () => {
    seedRitualsReady();
    useUndoStripStore.getState().show({
      id: 'ai-off-1',
      label: 'AI is off. dsul won’t bring it up again.',
      durationMs: 5000,
      face: 'ui',
    });
    mountThenAnswer();
    expect(titles()).not.toContain(RITUALS);
    act(() => useUndoStripStore.getState().dismiss('ai-off-1'));
    expect(titles()).toEqual([RITUALS]);
  });
});
