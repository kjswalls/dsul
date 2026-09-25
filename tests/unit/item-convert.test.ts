import { describe, it, expect } from 'vitest';
import {
  conversionBlock,
  conversionHint,
  convertItem,
  summarizeConversion,
} from '@/lib/item-convert';
import type { HabitItem, Item, TaskItem } from '@/lib/planner-types';

const habit = (over: Partial<HabitItem> = {}): HabitItem => ({
  type: 'habit',
  id: 'h1',
  title: 'Plan a date for next week',
  project: 'Relationship',
  projectId: 'p-rel',
  streak: 3,
  status: 'pending',
  completedDates: ['2026-09-11', '2026-09-18'],
  skippedDates: [],
  dailyCounts: {},
  repeatFrequency: 'custom',
  repeatDays: [4],
  timeBucket: 'anytime',
  duration: 30,
  ...over,
});

const task = (over: Partial<TaskItem> = {}): TaskItem => ({
  type: 'task',
  id: 't1',
  title: 'Renew passport',
  status: 'pending',
  isScheduled: true,
  order: 4,
  startDate: '2026-09-25',
  timeBucket: 'morning',
  startTime: '10:00',
  completedDates: [],
  ...over,
});

const ctx = (items: Item[] = [], milestones: string[] = []) => ({
  items,
  milestoneIds: new Set(milestones),
});

const opts = { todayStr: '2026-09-25' };

describe('convertItem', () => {
  it('habit → task keeps the repeat, project and history, anchored at the first check-off', () => {
    const out = convertItem(habit(), 'task', { ...opts, nextOrder: 9 });
    expect(out).toMatchObject({
      type: 'task',
      id: 'h1',
      title: 'Plan a date for next week',
      project: 'Relationship',
      projectId: 'p-rel',
      repeatFrequency: 'custom',
      repeatDays: [4],
      completedDates: ['2026-09-11', '2026-09-18'],
      startDate: '2026-09-11',
      isScheduled: true,
      timeBucket: 'anytime',
      order: 9,
      status: 'pending',
    });
    expect(out).not.toHaveProperty('streak');
  });

  it('habit → task anchors at today when it has no history, in anytime when unbucketed', () => {
    const out = convertItem(habit({ completedDates: [], timeBucket: undefined }), 'task', opts);
    expect(out).toMatchObject({ startDate: '2026-09-25', timeBucket: 'anytime' });
  });

  it('task → habit resets the streak, takes the given repeat, and fills a missing project', () => {
    const out = convertItem(task({ project: undefined }), 'habit', {
      ...opts,
      repeat: 'weekdays',
      projectIdFor: (n) => (n === 'Personal' ? 'p-personal' : undefined),
    });
    expect(out).toMatchObject({
      type: 'habit',
      streak: 0,
      dailyCounts: {},
      repeatFrequency: 'weekdays',
      project: 'Personal',
      projectId: 'p-personal',
      startTime: '10:00',
    });
    expect(out).not.toHaveProperty('startDate');
    expect(out).not.toHaveProperty('isScheduled');
  });

  it('never carries a stale scalar status into a recurring item', () => {
    // A habit ticked today holds 'done'; as a task that would read 'completed'
    // for the whole series. Both directions through a habit start at pending.
    expect(convertItem(habit({ status: 'done' }), 'task', opts).status).toBe('pending');
    expect(convertItem(habit({ status: 'skipped' }), 'task', opts).status).toBe('pending');
    expect(convertItem(task({ status: 'completed' }), 'habit', opts).status).toBe('pending');
    // Task-like to task-like shares one vocabulary, so a finished one-off stays finished.
    expect(convertItem(task({ status: 'completed' }), 'errand', opts).status).toBe('completed');
  });

  it('task ↔ custom type is a rename of the envelope, with no stray slug left behind', () => {
    const custom = convertItem(task(), 'errand', opts);
    expect(custom).toMatchObject({ type: 'custom', customType: 'errand', startDate: '2026-09-25', order: 4 });
    const back = convertItem(custom, 'task', opts);
    expect(back.type).toBe('task');
    expect(back).not.toHaveProperty('customType');
  });
});

describe('conversionBlock', () => {
  it('refuses to make a parent or a subtask into a habit', () => {
    const parent = task();
    const child = task({ id: 't2', parentItemId: 't1' });
    expect(conversionBlock(parent, 'habit', ctx([parent, child]))).toMatch(/subtasks/);
    expect(conversionBlock(child, 'habit', ctx([parent, child]))).toMatch(/subtask/);
    expect(conversionBlock(parent, 'errand', ctx([parent, child]))).toBeNull();
  });

  it('refuses milestones, project-block tasks and Beacon assignments for habits', () => {
    expect(conversionBlock(task(), 'habit', ctx([], ['t1']))).toMatch(/milestone/);
    expect(conversionBlock(task({ inProjectBlock: true }), 'habit', ctx())).toMatch(/project block/);
    expect(conversionBlock(task({ assignee: 'beacon' }), 'habit', ctx())).toMatch(/Beacon/);
    expect(conversionBlock(task(), 'habit', ctx())).toBeNull();
  });

  it('lets any habit become a task', () => {
    expect(conversionBlock(habit(), 'task', ctx())).toBeNull();
  });
});

describe('summarizeConversion / conversionHint', () => {
  it('habit → task names the streak it drops', () => {
    const s = summarizeConversion(habit(), 'task');
    expect(s.drops).toEqual(['The 3 day streak']);
    expect(s.needsRepeat).toBe(false);
    expect(conversionHint(habit(), 'task')).toBe('Drops the 3 day streak');
  });

  it('a one-off task → habit asks for a repeat', () => {
    const s = summarizeConversion(task(), 'habit');
    expect(s.needsRepeat).toBe(true);
    expect(s.changes[0]).toMatch(/follows its repeat/);
  });

  it('task → custom type costs nothing, so it switches without a confirm', () => {
    const s = summarizeConversion(task({ project: 'Errands' }), 'errand');
    expect(s).toEqual({ drops: [], changes: [], needsRepeat: false });
    expect(conversionHint(task(), 'errand')).toBe('Keeps everything');
  });
});
