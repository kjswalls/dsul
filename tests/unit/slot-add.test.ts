import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * lib/slot-add.ts: what a click, a sweep or an add row on the planner canvas
 * makes. The geometry snaps to quarter hours inside the grid, and the payload
 * follows the placement rules in addAt's comment: a grid slot carries its
 * time's own bucket (never 'anytime'), a row carries its bucket and no time,
 * and only a date-anchored type takes the date.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItemType: vi.fn(async () => {}),
  updateItemType: vi.fn(async () => {}),
  deleteItemType: vi.fn(async () => {}),
  createItem: vi.fn(async () => {}),
  createItems: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  createRoutine: vi.fn(async () => {}),
  updateRoutine: vi.fn(async () => {}),
  deleteRoutine: vi.fn(async () => {}),
  restoreRoutine: vi.fn(async () => {}),
  fetchSeasons: vi.fn(async () => []),
  createSeason: vi.fn(async () => {}),
  updateSeason: vi.fn(async () => {}),
  deleteSeason: vi.fn(async () => {}),
  restoreSeason: vi.fn(async () => {}),
  fetchGoals: vi.fn(async () => []),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));


import { usePlannerStore } from '@/lib/planner-store';
import { addAt, hhmm, minAtY, slotStart, sweepRange, type SlotTarget } from '@/lib/slot-add';

const DAY = '2026-10-08';
const grid = (startMin: number, duration = 30, extra: Partial<SlotTarget> = {}): SlotTarget =>
  ({ kind: 'grid', scope: `grid:${DAY}`, dateStr: DAY, startMin, duration, ...extra }) as SlotTarget;
const row: SlotTarget = { kind: 'row', scope: `row:anytime:${DAY}`, dateStr: DAY, bucket: 'anytime' };

describe('slot geometry', () => {
  it('formats minutes as the stored HH:mm', () => {
    expect(hhmm(0)).toBe('00:00');
    expect(hhmm(9 * 60 + 5)).toBe('09:05');
    expect(hhmm(24 * 60)).toBe('23:59');
  });

  it('reads a y offset as minutes from the grid top', () => {
    expect(minAtY(0, 6, 64)).toBe(360);
    expect(minAtY(96, 6, 64)).toBe(450);
  });

  it('floors a press to its quarter hour and keeps it inside the grid', () => {
    expect(slotStart(9 * 60 + 14, 6, 22)).toBe(9 * 60);
    expect(slotStart(9 * 60 + 15, 6, 22)).toBe(9 * 60 + 15);
    expect(slotStart(5 * 60, 6, 22)).toBe(6 * 60);
    expect(slotStart(22 * 60 - 1, 6, 22)).toBe(22 * 60 - 15);
  });

  it('sweeps whole quarters in either direction, at least one long', () => {
    expect(sweepRange(9 * 60 + 5, 10 * 60 + 20, 6, 22)).toEqual({ startMin: 9 * 60, duration: 90 });
    expect(sweepRange(10 * 60 + 20, 9 * 60 + 5, 6, 22)).toEqual({ startMin: 9 * 60, duration: 90 });
    expect(sweepRange(9 * 60, 9 * 60, 6, 22)).toEqual({ startMin: 9 * 60, duration: 15 });
    expect(sweepRange(21 * 60, 23 * 60, 6, 22)).toEqual({ startMin: 21 * 60, duration: 60 });
  });
});

describe('addAt', () => {
  const addTask = vi.fn((fields: Record<string, unknown>) => (fields ? 'task-id' : undefined));
  const addHabit = vi.fn((fields: Record<string, unknown>) => (fields ? 'habit-id' : undefined));
  const addItem = vi.fn((type: string, fields: Record<string, unknown>) => (type && fields ? 'item-id' : undefined));

  beforeEach(() => {
    addTask.mockClear();
    addHabit.mockClear();
    addItem.mockClear();
    usePlannerStore.setState({ addTask, addHabit, addItem } as never);
  });

  it('makes nothing from an empty title', () => {
    expect(addAt(grid(600), 'task', '   ')).toBeUndefined();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('puts a grid task at its time, in that time\'s bucket, on the day', () => {
    expect(addAt(grid(14 * 60 + 30, 60), 'task', ' Call the bank ')).toBe('task-id');
    const fields = addTask.mock.calls[0][0];
    expect(fields).toMatchObject({ title: 'Call the bank', startTime: '14:30', duration: 60, startDate: DAY });
    expect(fields.timeBucket).not.toBe('anytime');
    expect(fields.timeBucket).toBe('afternoon');
  });

  it('puts a row task in its bucket with no time', () => {
    addAt(row, 'task', 'Groceries');
    const fields = addTask.mock.calls[0][0];
    expect(fields).toMatchObject({ title: 'Groceries', timeBucket: 'anytime', startDate: DAY });
    expect(fields.startTime).toBeUndefined();
  });

  it('seeds the project a lane names', () => {
    addAt(grid(600, 30, { project: 'Work' }), 'task', 'Standup');
    expect(addTask.mock.calls[0][0]).toMatchObject({ project: 'Work' });
  });

  it('makes a habit that repeats, with no date', () => {
    expect(addAt(grid(7 * 60), 'habit', 'Stretch')).toBe('habit-id');
    const fields = addHabit.mock.calls[0][0];
    expect(fields).toMatchObject({ title: 'Stretch', startTime: '07:00', timesPerDay: 1 });
    expect(fields.startDate).toBeUndefined();
    expect(addTask).not.toHaveBeenCalled();
  });
});
