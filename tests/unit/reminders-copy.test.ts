import { describe, it, expect } from 'vitest';
import { formatCueTime, streakPhrase, reminderCopy, lastCallCopy } from '@/lib/reminders/copy';
import type { ReminderCandidate } from '@/lib/reminders/due';
import type { Item } from '@dsul/types';
import { assertContract } from './support/copy-contract';

const habit = (over: Partial<Item> = {}): Item => ({
  type: 'habit', id: 'h', title: 'Vitamins', project: 'G', streak: 0, status: 'pending',
  completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily',
  ...over,
} as Item);

const candidate = (over: Partial<ReminderCandidate> = {}): ReminderCandidate => ({
  item: habit(), at: '07:30', snoozed: false, ...over,
});

describe('formatCueTime', () => {
  it('reads 12-hour by default', () => {
    expect(formatCueTime('07:30')).toBe('7:30 am');
    expect(formatCueTime('19:05')).toBe('7:05 pm');
  });

  it('honours the 24-hour preference verbatim', () => {
    expect(formatCueTime('07:30', '24h')).toBe('07:30');
    expect(formatCueTime('19:05', '24h')).toBe('19:05');
  });

  // The two times a naive `hour % 12` gets wrong.
  it('gets noon and midnight right', () => {
    expect(formatCueTime('12:00')).toBe('12:00 pm');
    expect(formatCueTime('00:15')).toBe('12:15 am');
  });
});

describe('streakPhrase', () => {
  it('singularises one day', () => {
    expect(streakPhrase(1)).toBe('1 day');
    expect(streakPhrase(12)).toBe('12 days');
  });
});

describe('reminderCopy', () => {
  // Rule 1 of the copy contract: name the behavior, never the failure. The
  // title is what the user has to DO and what a lock screen truncates to.
  it('titles the notification with the item alone', () => {
    expect(reminderCopy(candidate()).title).toBe('Vitamins');
  });

  // The anchor is the whole reason the field exists — an event you already do
  // is a stronger cue than a clock, so it leads and the time is the fallback.
  it('leads with the implementation intention when there is one', () => {
    expect(reminderCopy(candidate({ anchor: 'you pour your coffee' })).body).toBe(
      'you pour your coffee',
    );
  });

  it('falls back to the stated time when there is no anchor', () => {
    expect(reminderCopy(candidate()).body).toBe('7:30 am');
    expect(reminderCopy(candidate(), '24h').body).toBe('07:30');
  });

  // Rule 2: a stake is stated as a fact the user earned, never as a threat.
  it('appends the streak as a plain number', () => {
    const body = reminderCopy(candidate({ item: habit({ streak: 12 }) })).body;
    expect(body).toBe('7:30 am · 12 days');
    assertContract(body);
  });

  it('says nothing about a streak of zero', () => {
    expect(reminderCopy(candidate()).body).not.toMatch(/day/);
  });
});

describe('lastCallCopy', () => {
  // "All done!" is a notification nobody asked for and cannot act on.
  it('is null when nothing is open', () => {
    expect(lastCallCopy([])).toBeNull();
  });

  it('names a single item without counting', () => {
    const copy = lastCallCopy([habit({ title: 'Reading' })]);
    expect(copy?.title).toBe('Still open today');
    expect(copy?.body).toBe('Reading');
  });

  it('counts in the title once there is more than one', () => {
    const copy = lastCallCopy([habit({ id: 'a', title: 'Reading' }), habit({ id: 'b', title: 'Stretch' })]);
    expect(copy?.title).toBe('2 still open');
    expect(copy?.body).toBe('Reading and Stretch');
  });

  it('states the top streak as the stake', () => {
    const copy = lastCallCopy([
      habit({ id: 'a', title: 'Reading', streak: 12 }),
      habit({ id: 'b', title: 'Stretch' }),
    ]);
    expect(copy?.body).toBe('Reading and Stretch · 12 days riding on it');
  });

  it('stops naming after three and counts the rest', () => {
    const items = ['A', 'B', 'C', 'D', 'E'].map((t, i) => habit({ id: `h${i}`, title: t }));
    expect(lastCallCopy(items)?.body).toBe('A, B, C and 2 more');
  });

  it('never scolds', () => {
    assertContract(lastCallCopy([habit({ title: 'Reading', streak: 3 })]));
  });
});
