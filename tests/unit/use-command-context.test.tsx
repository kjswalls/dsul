import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * The command context's identity is what every palette list is memoised on
 * (components/sidebar/omnibar.tsx), and the AI rows decide `hidden` and
 * `availableWhen` off the store, not off the context. So the context has to
 * re-form whenever the gate's answer moves, or a list keeps showing the rows
 * from before it. canChat alone is not enough: unknown to invited, invited to
 * No AI and a key turning down all keep it false while "Set up AI" and "Fix
 * AI" come and go.
 *
 * The router is held still here, as Next's is, so the only thing that can
 * give the context a new identity is what the test moves.
 */

const router = vi.hoisted(() => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { useCommandContext } from '@/hooks/use-command-context';
import { matchCommands } from '@/lib/commands';
import { AI_HIDDEN, KEY_TURNED_DOWN, NOTHING_CONNECTED, seedAI, type SeedAI } from './helpers/ai-fixtures';

let unseed: () => void = () => {};
const seed = (o?: SeedAI) => {
  unseed();
  unseed = seedAI(o);
};

afterEach(() => {
  unseed();
  unseed = () => {};
});

describe('useCommandContext', () => {
  it('holds still while nothing moves', () => {
    seed(NOTHING_CONNECTED);
    const { result, rerender } = renderHook(() => useCommandContext());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('re-forms on every answer of the gate, with canChat false throughout', () => {
    seed(undefined);
    const { result } = renderHook(() => useCommandContext());
    const doors = () =>
      matchCommands('', result.current)
        .map((r) => r.command.id)
        .filter((id) => id === 'ai.setup' || id === 'ai.fix');
    const seen = [result.current];
    expect(doors()).toEqual([]);

    for (const [state, expected] of [
      [NOTHING_CONNECTED, ['ai.setup']],
      [KEY_TURNED_DOWN, ['ai.fix']],
      [AI_HIDDEN, []],
      [NOTHING_CONNECTED, ['ai.setup']],
    ] as const) {
      act(() => seed(state));
      expect(seen).not.toContain(result.current);
      seen.push(result.current);
      expect(doors()).toEqual(expected);
    }
  });
});
