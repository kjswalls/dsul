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
 * already up never sits over the tour or outlives its account.
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

const USER = 'user-1';
const HABIT = { id: 'h1', type: 'habit', title: 'Stretch' } as never;
const TASK = { id: 't1', type: 'task', title: 'Call the dentist' } as never;

function seed({ habits }: { habits: unknown[] }) {
  usePlannerStore.setState({ userId: USER, habits: habits as never });
  useExtensionsStore.setState({ configsLoaded: true });
  useNudgeStore.setState({ dismissed: [], hydratedUserId: USER });
}

beforeEach(() => {
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
});

const titles = () => sonner.toast.mock.calls.map((c: unknown[]) => c[0]);

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
