import type { Project } from './planner-types';

/**
 * A project's repeating time block, in the two forms the panes need — one
 * predicate and one label, so the chip and the week row cannot disagree.
 *
 * `hasTimeBlock` is lib/day-items.ts's own rule: a block renders only when
 * startTime, timeBucket AND repeatFrequency all hold. A legacy row missing the
 * repeat draws nowhere, so it must not read "Every day" anywhere either.
 */
export function hasTimeBlock(p: Pick<Project, 'startTime' | 'timeBucket' | 'repeatFrequency'>): boolean {
  return !!p.startTime && !!p.timeBucket && !!p.repeatFrequency;
}

/** "18:30" → minutes after midnight. */
export function minutesOfClock(time: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** Minutes after midnight → "6:30pm", wrapping past midnight. */
export function clockLabel(mins: number): string {
  const t = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60);
  const m = t % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

/** "6pm–7pm" — the block's hours, the end wrapping past midnight ("11pm–1am"). */
export function blockWhen(p: Pick<Project, 'startTime' | 'duration'>): string {
  const start = minutesOfClock(p.startTime ?? '00:00');
  return `${clockLabel(start)}–${clockLabel(start + (p.duration ?? 60))}`;
}
