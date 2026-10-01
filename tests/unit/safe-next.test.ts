import { describe, expect, it } from 'vitest';
import { safeNext } from '@/lib/safe-next';

const ORIGIN = 'https://do.dsul.app';

describe('safeNext', () => {
  it('keeps a path on the origin, query and hash included', () => {
    expect(safeNext('/', ORIGIN)).toBe('/');
    expect(safeNext('/goal/abc', ORIGIN)).toBe('/goal/abc');
    expect(safeNext('/connect?code=x', ORIGIN)).toBe('/connect?code=x');
    expect(safeNext('/settings#keys', ORIGIN)).toBe('/settings#keys');
  });

  it('falls back to / when there is nothing to keep', () => {
    expect(safeNext(null, ORIGIN)).toBe('/');
    expect(safeNext(undefined, ORIGIN)).toBe('/');
    expect(safeNext('', ORIGIN)).toBe('/');
  });

  it.each([
    '@evil.com',
    '.evil.com/x',
    '//evil.com',
    '/\\evil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    'https://evil.com',
    'javascript:alert(1)',
    'goal/abc',
    '/..//evil.com',
  ])('drops %j, which does not stay on the origin', (raw) => {
    expect(safeNext(raw, ORIGIN)).toBe('/');
  });

  it('never yields a redirect whose host differs once the callback prefixes the origin', () => {
    for (const raw of ['@evil.com', '/\t/evil.com', '//evil.com', '/%2F%2Fevil.com', '/..//evil.com']) {
      const landed = new URL(`${ORIGIN}${safeNext(raw, ORIGIN)}`);
      expect(landed.host).toBe('do.dsul.app');
    }
  });
});
