import { describe, it, expect, vi } from 'vitest';
import {
  fireRoutine,
  fireText,
  readWake,
  ROUTINE_BETA,
  routineFireUrl,
  routineToken,
  wakeKey,
  wakesSet,
} from '@/lib/agent-wake';

/**
 * Waking a connected app (lib/agent-wake.ts): a Claude Code routine's /fire
 * URL and token. Pinned here: only a routine URL on api.anthropic.com is ever
 * accepted (dsul's server makes the request), what a stored wake must look
 * like to be used, what the run is told (ids, never titles), and that firing
 * never throws.
 */

const URL_OK = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire';
const TOKEN = 'sk-ant-oat01-abcdefghijklmnop';

describe('routineFireUrl', () => {
  it('accepts a routine /fire URL, trimmed', () => {
    expect(routineFireUrl(URL_OK)).toBe(URL_OK);
    expect(routineFireUrl(`  ${URL_OK}\n`)).toBe(URL_OK);
  });

  it('refuses any other host, scheme or path: the server makes this request', () => {
    for (const bad of [
      'http://api.anthropic.com/v1/claude_code/routines/trig_1/fire',
      'https://api.anthropic.com.evil.com/v1/claude_code/routines/trig_1/fire',
      'https://evil.com/v1/claude_code/routines/trig_1/fire',
      'https://api.anthropic.com/v1/messages',
      'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire?x=1',
      'https://api.anthropic.com/v1/claude_code/routines/../messages/fire',
      'https://user@api.anthropic.com/v1/claude_code/routines/trig_1/fire',
      '',
      42,
      null,
    ]) {
      expect(routineFireUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe('routineToken', () => {
  it('takes a token, trimmed, and refuses blank, spaced or absurd ones', () => {
    expect(routineToken(` ${TOKEN} `)).toBe(TOKEN);
    expect(routineToken('')).toBeNull();
    expect(routineToken('short')).toBeNull();
    expect(routineToken('has a space in it')).toBeNull();
    expect(routineToken('x'.repeat(513))).toBeNull();
    expect(routineToken(undefined)).toBeNull();
  });
});

describe('stored wakes', () => {
  it('keys by the assignee folded as names compare', () => {
    expect(wakeKey('  Claude ')).toBe('claude');
    expect(wakeKey('Claude   Code')).toBe('claude code');
  });

  it('uses only a well-formed entry', () => {
    expect(readWake({ url: URL_OK, token: TOKEN })).toEqual({ url: URL_OK, token: TOKEN });
    expect(readWake({ url: 'https://evil.com/fire', token: TOKEN })).toBeNull();
    expect(readWake({ url: URL_OK })).toBeNull();
    expect(readWake('nope')).toBeNull();
    expect(wakesSet({ claude: { url: URL_OK, token: TOKEN }, cursor: { url: 'x', token: TOKEN } })).toEqual([
      'claude',
    ]);
    expect(wakesSet(null)).toEqual([]);
  });
});

describe('fireText', () => {
  it('names the items by id and says where to look, never a title', () => {
    expect(fireText(['a'])).toBe('dsul handed an item to you. Item ids: a. Read your queue with dsul_my_work.');
    expect(fireText(['a', 'b'])).toMatch(/^dsul handed 2 items to you\. Item ids: a, b\./);
  });

  it('lists at most 50 ids, and still counts them all', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `id${i}`);
    const text = fireText(ids);
    expect(text).toMatch(/^dsul handed 60 items/);
    expect(text).toContain('id49');
    expect(text).not.toContain('id50');
  });
});

describe('fireRoutine', () => {
  it('POSTs the text with the bearer token and the beta header', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await fireRoutine({ url: URL_OK, token: TOKEN }, 'hello', fetchImpl as unknown as typeof fetch)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_OK);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'anthropic-beta': ROUTINE_BETA,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({ text: 'hello' });
  });

  it('answers false, never throws, on a refusal or a network failure', async () => {
    const refused = vi.fn(async () => new Response('{}', { status: 401 }));
    expect(await fireRoutine({ url: URL_OK, token: TOKEN }, 'x', refused as unknown as typeof fetch)).toBe(false);
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await fireRoutine({ url: URL_OK, token: TOKEN }, 'x', down as unknown as typeof fetch)).toBe(false);
  });
});
