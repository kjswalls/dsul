import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The store writes through lib/db; nothing here may reach a network.
vi.mock('@/lib/db', async (orig) => ({
  ...(await orig<typeof import('@/lib/db')>()),
  createAwayPeriod: vi.fn(async () => {}),
  updateAwayPeriod: vi.fn(async () => {}),
  deleteAwayPeriod: vi.fn(async () => {}),
}));

import { findCommand, matchCommands, type CommandContext } from '@/lib/commands';
import { useAwayStore } from '@/lib/away-store';
import { usePlannerStore } from '@/lib/planner-store';
import type { Item } from '@/lib/planner-types';

const ctx: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'u',
  isMobile: false,
};

const habit = (id: string, title: string, completedDates: string[] = []): Item =>
  ({
    type: 'habit', id, title, streak: 3, status: 'pending', completedDates, skippedDates: [],
    dailyCounts: {}, repeatFrequency: 'daily',
  }) as unknown as Item;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T15:00:00Z'));
  usePlannerStore.setState({ items: [habit('h1', 'Morning pages'), habit('h2', 'Gym')], routines: [], userTimezone: 'UTC' });
  useAwayStore.setState({ periods: [], loaded: true, available: true, userId: 'u' });
});

afterEach(() => {
  vi.useRealTimers();
  useAwayStore.getState().reset();
});

describe('the ⌘K line', () => {
  it('reads "vacation until tue" as one row that previews the trip', () => {
    const row = matchCommands('vacation until tue', ctx)[0];
    expect(row.command.id).toBe('app.vacation');
    expect(row.inlineArg).toBe('until tue');
    const arg = row.command.argument;
    expect(arg?.kind === 'text' && arg.preview?.('until tue', ctx)).toEqual({
      label: 'Vacation mode until Tue, Oct 13',
      detail: 'Everything rests.',
    });
  });

  it('is found by its other words, and says how to fix a day it cannot read', () => {
    for (const q of ['away', 'holiday', 'trip']) {
      expect(matchCommands(q, ctx).map((r) => r.command.id)).toContain('app.vacation');
    }
    const arg = findCommand('app.vacation', ctx)?.argument;
    expect(arg?.kind === 'text' && arg.validate?.('soon')).toBe('Try a day like tue, oct 20 or 2 weeks');
  });

  it('starts the trip from today on Enter, and turns into the card and "I\'m back" while on it', () => {
    findCommand('app.vacation', ctx)!.run(ctx, 'tue');
    const [trip] = useAwayStore.getState().periods;
    expect(trip).toMatchObject({ startsOn: '2026-10-11', endsOn: '2026-10-13' });
    const ids = matchCommands('vacation', ctx).map((r) => r.command.id);
    expect(ids).toContain('app.vacation-open');
    expect(ids).not.toContain('app.vacation');
    expect(matchCommands('back', ctx).map((r) => r.command.id)).toContain('app.vacation-end');
  });

  it('stays hidden while trips are unavailable', () => {
    useAwayStore.setState({ available: false });
    expect(matchCommands('vacation', ctx).map((r) => r.command.id)).not.toContain('app.vacation');
  });
});
