import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';

/**
 * The AI's two dock lines (components/notices/ai-notice.tsx).
 *
 * FAILING: a connected model whose key stopped working. With nothing else to
 * answer, every AI surface hides the moment the gate sees `failing`, so without
 * this line the AI would simply vanish with no word as to why. With OpenClaw
 * set up, the gate answers with OpenClaw instead, and the line names the model's
 * provider rather than claiming the AI paused. It waits on a decision only the user can make
 * (fix or replace the key), hence rank `decision`, and its "Hide for now" lasts
 * the session for THAT failure only: a later failure (a new `checkedAt`) or a
 * different account shows again.
 *
 * LEGACY: a browser that held a key from before keys moved server-side, with
 * nothing at all able to answer now. Its dismissal is the persisted flag in
 * dsul-ai-settings, so it lasts across reloads.
 */

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  })),
}));

import { useAINotice, __resetAINoticeForTests } from '@/components/notices/ai-notice';
import { DockNotices } from '@/components/sidebar/dock-notices';
import { NOTICE_RANK } from '@/lib/dock-notices';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import {
  seedAI,
  CONNECTED_MODEL,
  NOTHING_CONNECTED,
  OPENCLAW_PLUGIN,
  type SeedAI,
} from './helpers/ai-fixtures';

const FAILING: SeedAI = {
  ...CONNECTED_MODEL,
  model: { provider: 'openai', model: 'gpt-4o-mini', status: 'failing', problem: 'key_rejected' },
};

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

let unseed: () => void = () => {};
const seed = (o?: SeedAI) => {
  unseed();
  unseed = seedAI(o);
};

beforeEach(() => {
  push.mockClear();
  __resetAINoticeForTests();
});

afterEach(() => {
  cleanup();
  unseed();
  unseed = () => {};
});

describe('the failing-key notice', () => {
  it('shows at rank decision when the connected model is failing', () => {
    seed(FAILING);
    const { result } = renderHook(() => useAINotice());

    expect(result.current?.id).toBe('ai-failing');
    expect(result.current?.rank).toBe(NOTICE_RANK.decision);
    expect(result.current?.actionLabel).toBe('Fix');
    expect(result.current?.dismissLabel).toBe('Hide for now');
    expect(result.current?.testId).toBe('notice-ai-failing');
    // No anchor: the surfaces it would sit on are the ones the gate hid.
    expect(result.current?.anchor).toBeUndefined();
  });

  it('says nothing for a working model, nothing connected, or an unknown gate', () => {
    for (const s of [CONNECTED_MODEL, NOTHING_CONNECTED, OPENCLAW_PLUGIN, undefined]) {
      seed(s);
      const { result, unmount } = renderHook(() => useAINotice());
      expect(result.current).toBeNull();
      unmount();
    }
  });

  it('sends Fix to Settings → AI', () => {
    seed(FAILING);
    const { result } = renderHook(() => useAINotice());
    act(() => result.current?.onSelect?.());
    expect(push).toHaveBeenCalledWith('/settings/beacon');
  });

  it('hides for the rest of the session once dismissed, for that failure only', () => {
    seed(FAILING);
    const first = renderHook(() => useAINotice());
    act(() => first.result.current?.onDismiss?.());
    expect(first.result.current).toBeNull();
    first.unmount();

    // A remount in the same session (the dock re-rendering, a route change)
    // still remembers it.
    const again = renderHook(() => useAINotice());
    expect(again.result.current).toBeNull();
    again.unmount();

    // A NEW failure (a later check) is a new thing to say.
    seed({ ...FAILING, model: { ...FAILING.model, checkedAt: '2026-10-02T09:00:00.000Z' } });
    const later = renderHook(() => useAINotice());
    expect(later.result.current?.id).toBe('ai-failing');
    later.unmount();
  });

  it('keys the dismissal on the account as well', () => {
    seed(FAILING);
    const first = renderHook(() => useAINotice());
    act(() => first.result.current?.onDismiss?.());
    first.unmount();

    // Same failure timestamp, a different signed-in account.
    useAIConnectionStore.setState({ hydratedUserId: 'someone-else' });
    const other = renderHook(() => useAINotice());
    expect(other.result.current?.id).toBe('ai-failing');
  });

  it('renders on the dock, and its row opens Settings', () => {
    seed(FAILING);
    render(<DockNotices />);

    const row = screen.getByTestId('notice-ai-failing');
    expect(row).toHaveTextContent('AI paused: your key stopped working');
    fireEvent.click(screen.getByText('Fix'));
    expect(push).toHaveBeenCalledWith('/settings/beacon');
  });
});

describe('the failing-key notice while OpenClaw answers', () => {
  // A paired gateway: OpenClaw chats AND proposes, so nothing about the AI
  // stopped, only the model did.
  const BOTH: SeedAI = {
    ...FAILING,
    openclaw: { gateway: true, agent: true, agentId: 'kirby-1' },
  };

  it.each([
    ['OpenClaw is the choice', { ...BOTH, choice: 'openclaw' } as SeedAI],
    // The model is the choice, but it is failing, so the gate falls back.
    ['the model is the choice', { ...BOTH, choice: 'model' } as SeedAI],
  ])('names the provider instead of pausing the AI (%s)', (_label, state) => {
    seed(state);
    render(<DockNotices />);

    const row = screen.getByTestId('notice-ai-failing');
    expect(row).toHaveTextContent('Your OpenAI key stopped working');
    expect(row.textContent).not.toMatch(/AI paused/);
    // Still the user's decision to make, and still one tap from fixing it.
    fireEvent.click(screen.getByText('Fix'));
    expect(push).toHaveBeenCalledWith('/settings/beacon');
  });

  it('says the same on the plugin path, which chats without proposing', () => {
    seed({ ...FAILING, openclaw: { pluginChat: true, agent: true, agentId: 'kirby-1' } });
    const { result } = renderHook(() => useAINotice());
    expect(result.current?.id).toBe('ai-failing');
    render(<>{result.current?.label}</>);
    expect(screen.getByText('Your OpenAI key stopped working')).toBeInTheDocument();
  });

  it('does not call a custom endpoint "Other"', () => {
    seed({
      ...BOTH,
      model: { ...FAILING.model, provider: 'custom', baseUrl: 'https://llm.example.com/v1' },
    });
    const { result } = renderHook(() => useAINotice());
    render(<>{result.current?.label}</>);
    expect(screen.getByText('Your model’s key stopped working')).toBeInTheDocument();
  });

  it('still says the AI paused when nothing else can answer', () => {
    seed(FAILING);
    const { result } = renderHook(() => useAINotice());
    render(<>{result.current?.label}</>);
    expect(screen.getByText('AI paused: your key stopped working')).toBeInTheDocument();
  });
});

describe('the legacy notice', () => {
  it('shows only when nothing is connected, nothing can answer, and the flag is up', () => {
    seed({ ...NOTHING_CONNECTED, legacyNotice: true });
    const { result } = renderHook(() => useAINotice());

    expect(result.current?.id).toBe('ai-moved');
    expect(result.current?.rank).toBe(NOTICE_RANK.statement);
    expect(result.current?.actionLabel).toBe('Connect');
    expect(result.current?.testId).toBe('notice-ai-moved');
    act(() => result.current?.onSelect?.());
    expect(push).toHaveBeenCalledWith('/settings/beacon');
  });

  it('stays quiet whenever something else explains itself', () => {
    const cases: SeedAI[] = [
      // A model is connected: the panel and the failing notice speak for it.
      { ...CONNECTED_MODEL, legacyNotice: true },
      { ...FAILING, legacyNotice: true },
      // OpenClaw answers: AI did not go quiet.
      { ...OPENCLAW_PLUGIN, legacyNotice: true },
      // The gate has not answered: never claim anything before it does.
      { legacyNotice: true },
      { phase: 'error', legacyNotice: true },
      // No flag: this browser never held a key.
      NOTHING_CONNECTED,
    ];
    for (const c of cases) {
      seed(c);
      const { result, unmount } = renderHook(() => useAINotice());
      expect(result.current?.id === 'ai-moved').toBe(false);
      unmount();
    }
  });

  it('dismisses through the persisted flag, so it lasts across reloads', () => {
    seed({ ...NOTHING_CONNECTED, legacyNotice: true });
    const { result } = renderHook(() => useAINotice());
    act(() => result.current?.onDismiss?.());

    expect(useAISettingsStore.getState().legacyNotice).toBe(false);
    expect(result.current).toBeNull();
    const disk = JSON.parse(localStorage.getItem('dsul-ai-settings') ?? '{}');
    expect(disk.state?.legacyNotice).toBe(false);
  });
});

describe('"No AI, thanks"', () => {
  it('silences both lines, though the key is still failing', () => {
    for (const s of [
      { ...FAILING, aiHidden: true },
      { ...NOTHING_CONNECTED, legacyNotice: true, aiHidden: true },
    ]) {
      seed(s);
      const { result, unmount } = renderHook(() => useAINotice());
      expect(result.current).toBeNull();
      unmount();
    }
  });

  it('hides nothing while the account cannot say (060 not applied)', () => {
    seed({ ...FAILING, aiHidden: null });
    const { result } = renderHook(() => useAINotice());
    expect(result.current?.id).toBe('ai-failing');
  });
});
