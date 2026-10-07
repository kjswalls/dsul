import { describe, expect, it } from 'vitest';
import { DEFAULT_LOGIN_HEADLINE, loginHeadlinesFor, pickLoginHeadline } from '@/lib/login-headlines';

// 2026-10-05 is a Monday, 2026-10-07 a Wednesday.
const at = (iso: string) => new Date(iso);

describe('the sign-in headline', () => {
  it('offers morning lines in the morning and late lines late', () => {
    expect(loginHeadlinesFor(at('2026-10-07T08:00:00'))).toContain('coffee first, then stuff?');
    expect(loginHeadlinesFor(at('2026-10-07T08:00:00'))).not.toContain('up late? we can plan that.');
    expect(loginHeadlinesFor(at('2026-10-07T02:00:00'))).toContain('up late? we can plan that.');
  });

  it('adds a day line on the days that have one', () => {
    expect(loginHeadlinesFor(at('2026-10-05T10:00:00'))).toContain('monday again. what stuff this week?');
    expect(loginHeadlinesFor(at('2026-10-07T10:00:00'))).not.toContain('monday again. what stuff this week?');
  });

  it('always keeps the default in the pool', () => {
    for (let h = 0; h < 24; h++) {
      expect(loginHeadlinesFor(at(`2026-10-07T${String(h).padStart(2, '0')}:00:00`))).toContain(DEFAULT_LOGIN_HEADLINE);
    }
  });

  it('picks from the pool, edges included', () => {
    const now = at('2026-10-07T15:00:00');
    const pool = loginHeadlinesFor(now);
    expect(pickLoginHeadline(now, () => 0)).toBe(pool[0]);
    expect(pickLoginHeadline(now, () => 0.9999)).toBe(pool[pool.length - 1]);
  });

  it('keeps every line short enough for two lines in the column', () => {
    const all = new Set<string>();
    for (let d = 4; d <= 10; d++) for (let h = 0; h < 24; h++) {
      loginHeadlinesFor(at(`2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00`)).forEach((l) => all.add(l));
    }
    for (const line of all) expect(line.length).toBeLessThanOrEqual(40);
  });
});
