import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELETION_NOTICE_KEY,
  fetchAccountFacts,
  rememberDeletion,
  requestAccountDeletion,
  takeDeletionNotice,
} from '@/lib/account-client';
import { ACCOUNT_COPY } from '@/lib/account-copy';

/**
 * lib/account-client.ts: the web dialog's two calls, in the dialog's words,
 * and the note that carries a deletion's outcome to /login.
 */

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const FACTS = {
  userId: USER,
  email: 'kirby@example.com',
  appleIds: ['001234.dsul.0001'],
  appleRevocable: true,
  beeminder: true,
  ledger: true,
  openclaw: false,
  keyServices: ['Beeminder', 'Twilio'],
  modelProviderName: 'OpenAI',
};

const fetchMock = vi.fn<typeof fetch>();

function answer(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(status === 204 ? null : text, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('fetchAccountFacts', () => {
  it('GETs /api/account, same origin, uncached, and reads the facts', async () => {
    fetchMock.mockResolvedValue(answer(200, FACTS));
    await expect(fetchAccountFacts()).resolves.toEqual({ ok: true, facts: FACTS });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/account', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });

  it.each([
    [401, 'signed_out'],
    [409, 'changed'],
    [410, 'gone'],
    [503, 'unreachable'],
    [500, 'failed'],
    [400, 'failed'],
    [403, 'failed'],
    [404, 'failed'],
  ] as const)('%i is %s', async (status, error) => {
    fetchMock.mockResolvedValue(answer(status, { error: 'x' }));
    await expect(fetchAccountFacts()).resolves.toEqual({ ok: false, error });
  });

  it('a fetch that throws is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fetchAccountFacts()).resolves.toEqual({ ok: false, error: 'unreachable' });
  });

  it.each([
    ['no userId', { ...FACTS, userId: undefined }],
    ['a userId that is not a UUID', { ...FACTS, userId: 'kirby' }],
    ['a body that is not an object', [FACTS]],
    ['a body that is not JSON', 'not json'],
  ])('a 200 with %s is failed', async (_name, body) => {
    fetchMock.mockResolvedValue(answer(200, body));
    await expect(fetchAccountFacts()).resolves.toEqual({ ok: false, error: 'failed' });
  });
});

describe('requestAccountDeletion', () => {
  it('POSTs exactly {"account","confirm":"DELETE"} as JSON, whatever was typed', async () => {
    fetchMock.mockResolvedValue(answer(200, { deleted: true, apple: 'none' }));
    await expect(requestAccountDeletion(USER)).resolves.toEqual({ ok: true, apple: 'none' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/account/delete');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(init?.body).toBe(`{"account":"${USER}","confirm":"DELETE"}`);
  });

  it.each(['revoked', 'not_revoked', 'none', 'unknown'] as const)('reads apple %s', async (apple) => {
    fetchMock.mockResolvedValue(answer(200, { deleted: true, apple }));
    await expect(requestAccountDeletion(USER)).resolves.toEqual({ ok: true, apple });
  });

  it.each([
    ['an unknown apple word', { deleted: true, apple: 'maybe' }],
    ['no apple', { deleted: true }],
    ['an empty body', ''],
    ['a body that is not JSON', '<html>'],
  ])('any 200 is a deletion: %s reads unknown', async (_name, body) => {
    fetchMock.mockResolvedValue(answer(200, body));
    await expect(requestAccountDeletion(USER)).resolves.toEqual({ ok: true, apple: 'unknown' });
  });

  it.each([
    [401, 'signed_out'],
    [409, 'changed'],
    [410, 'gone'],
    [503, 'unreachable'],
    [500, 'failed'],
    [400, 'failed'],
    [403, 'failed'],
    [413, 'failed'],
    [415, 'failed'],
  ] as const)('%i is %s', async (status, error) => {
    fetchMock.mockResolvedValue(answer(status, { error: 'x' }));
    await expect(requestAccountDeletion(USER)).resolves.toEqual({ ok: false, error });
  });

  it('a fetch that throws is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(requestAccountDeletion(USER)).resolves.toEqual({ ok: false, error: 'unreachable' });
  });
});

describe('the note for /login', () => {
  it('stores the Apple outcome and nothing about the account', () => {
    rememberDeletion('not_revoked', true);
    expect(JSON.parse(window.sessionStorage.getItem(DELETION_NOTICE_KEY)!)).toEqual({
      apple: 'not_revoked',
      hadApple: true,
    });
  });

  it("gives the web's done line once, then null", () => {
    rememberDeletion('revoked', true);
    expect(takeDeletionNotice()).toBe(ACCOUNT_COPY.deleted);
    expect(takeDeletionNotice()).toBeNull();
    expect(window.sessionStorage.getItem(DELETION_NOTICE_KEY)).toBeNull();
  });

  it("gives the web's Apple-left line, never the phone's", () => {
    rememberDeletion('unknown', true);
    expect(takeDeletionNotice()).toBe(ACCOUNT_COPY.appleLeftWeb);
    rememberDeletion('not_revoked', false);
    expect(takeDeletionNotice()).toBe(ACCOUNT_COPY.appleLeftWeb);
    rememberDeletion('unknown', false);
    expect(takeDeletionNotice()).toBe(ACCOUNT_COPY.deleted);
  });

  it('is null with no note', () => {
    expect(takeDeletionNotice()).toBeNull();
  });

  it.each([
    ['not JSON', '{'],
    ['not an object', '"revoked"'],
    ['null', 'null'],
    ['an unknown apple word', '{"apple":"maybe","hadApple":true}'],
    ['no hadApple', '{"apple":"revoked"}'],
    ['a hadApple that is not a boolean', '{"apple":"revoked","hadApple":"yes"}'],
  ])('a malformed note (%s) gives null and is removed', (_name, raw) => {
    window.sessionStorage.setItem(DELETION_NOTICE_KEY, raw);
    expect(takeDeletionNotice()).toBeNull();
    expect(window.sessionStorage.getItem(DELETION_NOTICE_KEY)).toBeNull();
  });

  it('storage that throws never throws here', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() => rememberDeletion('revoked', false)).not.toThrow();
    expect(takeDeletionNotice()).toBeNull();
  });

  it('a note that cannot be removed gives null, so it can never show twice', () => {
    rememberDeletion('none', false);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(takeDeletionNotice()).toBeNull();
  });
});
