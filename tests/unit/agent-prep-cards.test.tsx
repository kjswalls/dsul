import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';


import { AgentPill } from '@/components/primitives/pills';
import { usePrepPacksStore } from '@/lib/prep-packs-store';

/**
 * An agent's card (dsul_save_prep) reaches the page: the packs are read again
 * (use-agent-freshness, on a finish), and the row itself says nothing about
 * it: what is ready is counted in the dock (components/notices/ai-work-notice.tsx).
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
  it('says nothing once the agent got the item ready: the dock counts it', () => {
    const { container } = render(<AgentPill item={done('a', '2026-10-21T08:00:00Z')} />);
    expect(container.textContent).toBe('');
  });

  it('is only the invisible working mark during a live run, so the title alone shimmers', () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const { getByTestId, container } = render(
      <AgentPill item={{ assignee: 'openclaw', aiStatus: 'working', aiStatusAt: at, status: 'pending' }} />
    );
    expect(getByTestId('ai-working').className).toContain('sr-only');
    expect(container.querySelector('[data-ai-relay]')).toBeNull();
  });
});
