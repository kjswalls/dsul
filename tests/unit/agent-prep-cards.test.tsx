import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';


import { AgentPill } from '@/components/primitives/pills';
import { usePrepPacksStore } from '@/lib/prep-packs-store';

/**
 * An agent's card (dsul_save_prep) reaches the page: the packs are read again
 * (use-agent-freshness, on a finish), and the row says ready once, not twice.
 */

const done = (id: string, at: string) => ({ id, title: id, assignee: 'openclaw', aiMode: 'prepare', aiStatus: 'done', aiStatusAt: at, status: 'pending' });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('refresh', () => {
  it('reads the packs again, the server copy winning, except where this page is preparing', async () => {
    const pack = (id: string, items: string[]) => ({ itemId: id, pack: { kind: 'list', items }, madeFor: id, updatedAt: 'x' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ packs: [pack('a', ['new']), pack('b', ['server'])] }))));
    usePrepPacksStore.setState({
      userId: 'u1',
      loaded: true,
      available: true,
      packs: { a: pack('a', ['old']) as never, b: pack('b', ['mine']) as never },
      preparing: { b: true },
    });
    await usePrepPacksStore.getState().refresh('u1');
    expect(usePrepPacksStore.getState().packs.a?.pack).toEqual({ kind: 'list', items: ['new'] });
    expect(usePrepPacksStore.getState().packs.b?.pack).toEqual({ kind: 'list', items: ['mine'] });
  });
});

describe('the pill', () => {
  it("drops its ready when the row's pack chip already says it", () => {
    const { queryByText, rerender } = render(<AgentPill item={done('a', '2026-10-21T08:00:00Z')} />);
    expect(queryByText('ready')).not.toBeNull();
    rerender(<AgentPill item={done('a', '2026-10-21T08:00:00Z')} hideReady />);
    expect(queryByText('ready')).toBeNull();
  });
});
