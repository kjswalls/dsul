import type { APIRequestContext, Page } from '@playwright/test';
import { cleanupTestData, createTestHabit, createTestTask } from '../e2e/helpers/api';
import { getTodayStr } from '../e2e/helpers/dates';

/**
 * The invented planner the demos film: plausible titles, no `e2e_` prefix
 * (it would show on camera). Every row is deleted by id when the beat ends, and
 * the local database is reset by every `local-setup.sh` run anyway.
 */

export const BRAINDUMP = [
  'Reply to Sam about Saturday',
  'Renew passport',
  'Cancel the gym trial before it bills',
  'Book a dentist cleaning',
  'Return the wrong-size shoes',
  'Water the plants',
  'Draft the video script outline',
  'Look into cheaper phone plans',
  'Back up the laptop',
];

export const DAY = [
  { title: 'Morning pages', timeBucket: 'morning', startTime: '08:00', duration: 20 },
  { title: 'Ship the layouts PR', timeBucket: 'morning', startTime: '09:30', duration: 90 },
  { title: 'Lunch with Priya', timeBucket: 'afternoon', startTime: '12:30', duration: 60 },
  { title: 'Record the intro take', timeBucket: 'afternoon', startTime: '15:00', duration: 45 },
  { title: 'Groceries', timeBucket: 'evening', startTime: '18:00', duration: 30 },
];

export const HABITS = ['Stretch', 'Read 10 pages'];

export interface Cast {
  taskIds: string[];
  habitIds: string[];
}

export async function seedBraindump(page: Page, cast: Cast): Promise<void> {
  for (const [i, title] of BRAINDUMP.entries()) {
    cast.taskIds.push(await createTestTask(page, { title, isScheduled: false, order: i }));
  }
}

export async function seedDay(page: Page, cast: Cast): Promise<void> {
  const startDate = getTodayStr();
  for (const [i, row] of DAY.entries()) {
    cast.taskIds.push(await createTestTask(page, { ...row, startDate, isScheduled: true, order: i }));
  }
  for (const title of HABITS) {
    cast.habitIds.push(await createTestHabit(page, { title, timeBucket: 'morning' }));
  }
}

export async function strike(page: Page | APIRequestContext, cast: Cast): Promise<void> {
  await cleanupTestData(page, cast.taskIds, cast.habitIds);
  cast.taskIds.length = 0;
  cast.habitIds.length = 0;
}
