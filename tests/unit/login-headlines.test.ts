import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LOGIN_HEADLINE, LOGIN_HEADLINES, pickLoginHeadline } from '@/lib/login-headlines';

describe('the sign-in headline', () => {
  it('keeps the default in the pool', () => {
    expect(LOGIN_HEADLINES).toContain(DEFAULT_LOGIN_HEADLINE);
  });

  it('picks from the pool, edges included', () => {
    expect(pickLoginHeadline(() => 0)).toBe(LOGIN_HEADLINES[0]);
    expect(pickLoginHeadline(() => 0.9999)).toBe(LOGIN_HEADLINES[LOGIN_HEADLINES.length - 1]);
  });

  it('keeps every line short enough for two lines in the column', () => {
    for (const line of LOGIN_HEADLINES) expect(line.length).toBeLessThanOrEqual(40);
  });

  it('never guesses the time or the day', () => {
    const guess = /\b(morning|afternoon|evening|night|late|tonight|tomorrow|weekend|(mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;
    for (const line of LOGIN_HEADLINES) expect(line).not.toMatch(guess);
  });

  it('has no em dashes', () => {
    for (const line of LOGIN_HEADLINES) expect(line).not.toContain('—');
  });

  it('matches the iPhone pool line for line (ios/DsulCore LoginHeadlines.swift)', () => {
    const swift = readFileSync(
      join(process.cwd(), 'ios/DsulCore/Sources/DsulCore/LoginHeadlines.swift'),
      'utf8',
    );
    const pool = swift.slice(swift.indexOf('// pool:start'), swift.indexOf('// pool:end'));
    const lines = [...pool.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    expect(lines).toEqual([...LOGIN_HEADLINES]);
    expect(swift).toContain(`defaultLine = "${DEFAULT_LOGIN_HEADLINE}"`);
  });
});
