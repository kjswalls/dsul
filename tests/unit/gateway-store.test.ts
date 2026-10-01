import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The gateway store's hydrate: one read per account however many times the
 * provider asks (the load's `.then` and the navigation flush both can), a late
 * answer for a switched-away account dropped, and a bare A→B switch that never
 * shows A's configuration as B's.
 */

vi.mock('@/lib/chat-store', () => ({
  useChatStore: { getState: () => ({ syncOpenclawInfo: vi.fn() }) },
}));

import { useGatewayStore } from '@/lib/gateway-store';

type Body = { gatewayUrl?: string; hasToken?: boolean; configured?: boolean; unavailable?: boolean };

/** A fetch the test answers by hand. */
function pending() {
  let resolve!: (body: Body) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = (body) => res({ ok: true, status: 200, json: async () => body } as Response);
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  useGatewayStore.getState().reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const A_ROW: Body = { gatewayUrl: 'https://a.example', hasToken: true, configured: true };

describe('gateway store hydrate', () => {
  it('two concurrent hydrates for one account fetch once', async () => {
    const p = pending();
    fetchMock.mockReturnValueOnce(p.promise);
    const one = useGatewayStore.getState().hydrate('user-a');
    const two = useGatewayStore.getState().hydrate('user-a');
    p.resolve(A_ROW);
    await Promise.all([one, two]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useGatewayStore.getState()).toMatchObject({
      gatewayUrl: 'https://a.example',
      hasToken: true,
      hydratedUserId: 'user-a',
    });
  });

  it("drops a switched-away account's late answer", async () => {
    const pA = pending();
    const pB = pending();
    fetchMock.mockReturnValueOnce(pA.promise).mockReturnValueOnce(pB.promise);
    const a = useGatewayStore.getState().hydrate('user-a');
    const b = useGatewayStore.getState().hydrate('user-b');
    pB.resolve({ gatewayUrl: '', hasToken: false, configured: false });
    await b;
    pA.resolve(A_ROW);
    await a;
    expect(useGatewayStore.getState()).toMatchObject({
      gatewayUrl: '',
      hasToken: false,
      hydratedUserId: 'user-b',
    });
  });

  it("drops a switched-away account's late FAILURE too", async () => {
    const pA = pending();
    const pB = pending();
    fetchMock.mockReturnValueOnce(pA.promise).mockReturnValueOnce(pB.promise);
    const a = useGatewayStore.getState().hydrate('user-a');
    const b = useGatewayStore.getState().hydrate('user-b');
    pB.resolve({ gatewayUrl: 'https://b.example', hasToken: true, configured: true });
    await b;
    pA.reject(new Error('offline'));
    await a;
    expect(useGatewayStore.getState()).toMatchObject({
      gatewayUrl: 'https://b.example',
      available: true,
      hydratedUserId: 'user-b',
    });
  });

  it('clears to the initial state synchronously on a bare account switch', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => A_ROW } as Response);
    await useGatewayStore.getState().hydrate('user-a');
    expect(useGatewayStore.getState().hasToken).toBe(true);

    const p = pending();
    fetchMock.mockReturnValueOnce(p.promise);
    const b = useGatewayStore.getState().hydrate('user-b');
    // Before B's answer: nothing of A's left on screen.
    expect(useGatewayStore.getState()).toMatchObject({
      gatewayUrl: '',
      hasToken: false,
      configured: false,
      hydratedUserId: null,
    });
    p.resolve({ gatewayUrl: '', hasToken: false, configured: false });
    await b;
    expect(useGatewayStore.getState().hydratedUserId).toBe('user-b');
  });

  it('reset drops the in-flight claim, so the next hydrate fetches again', async () => {
    const p = pending();
    fetchMock.mockReturnValueOnce(p.promise);
    const first = useGatewayStore.getState().hydrate('user-a');
    useGatewayStore.getState().reset();

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => A_ROW } as Response);
    await useGatewayStore.getState().hydrate('user-a');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The orphaned first answer is for the same account, which has re-claimed,
    // so it may land — the store reads as A's either way.
    p.resolve(A_ROW);
    await first;
    expect(useGatewayStore.getState().hydratedUserId).toBe('user-a');
  });

  it('a failed read still latches as not configured', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response);
    await useGatewayStore.getState().hydrate('user-a');
    expect(useGatewayStore.getState()).toMatchObject({
      available: false,
      configured: false,
      hydratedUserId: 'user-a',
    });
    await useGatewayStore.getState().hydrate('user-a');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
