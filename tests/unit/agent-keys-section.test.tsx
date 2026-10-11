import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgentKeysSection } from '@/components/settings/agent-keys';

/**
 * Settings → AI → Agent keys: a key is shown once, in the component's state,
 * and is gone from the page when dismissed; the list never carries it.
 */

const KEY = `dsul_ak_${'A'.repeat(43)}`;

function serve(initial: unknown[] | null) {
  let keys = initial ?? [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (initial === null) return new Response('{}', { status: 503 });
    if (url === '/api/agent-keys' && init?.method === 'POST') {
      const { name, scope } = JSON.parse(String(init.body));
      const agentKey = { id: 'k1', name, scope, createdAt: '2026-10-11T00:00:00Z', lastUsedAt: null };
      keys = [agentKey];
      return new Response(JSON.stringify({ key: KEY, agentKey }), { status: 201 });
    }
    if (url === '/api/agent-keys/k1' && init?.method === 'DELETE') {
      keys = [];
      return new Response('{"ok":true}');
    }
    return new Response(JSON.stringify({ keys }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Agent keys', () => {
  it('makes a read-only key by default, shows it once, and forgets it on Done', async () => {
    const fetchMock = serve([]);
    render(<AgentKeysSection />);
    fireEvent.click(await screen.findByTestId('agent-key-new'));
    fireEvent.change(screen.getByTestId('agent-key-name'), { target: { value: 'Home server' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-key-create'));
    });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post![1]!.body))).toEqual({ name: 'Home server', scope: 'planner:read' });
    expect(screen.getByTestId('agent-key-value')).toHaveTextContent(KEY);
    expect(screen.getByTestId('agent-key')).toHaveTextContent('Home server');
    expect(screen.getByTestId('agent-key')).not.toHaveTextContent(KEY);
    fireEvent.click(screen.getByTestId('agent-key-done'));
    expect(document.body).not.toHaveTextContent(KEY);
  });

  it('makes a read-and-change key when chosen', async () => {
    const fetchMock = serve([]);
    render(<AgentKeysSection />);
    fireEvent.click(await screen.findByTestId('agent-key-new'));
    fireEvent.change(screen.getByTestId('agent-key-name'), { target: { value: 'Script' } });
    fireEvent.click(screen.getByTestId('agent-key-scope-write'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-key-create'));
    });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post![1]!.body)).scope).toBe('planner');
  });

  it('revokes after a confirm', async () => {
    const fetchMock = serve([{ id: 'k1', name: 'Old', scope: 'planner', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null }]);
    render(<AgentKeysSection />);
    fireEvent.click(await screen.findByTestId('agent-key-revoke'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-key-confirm'));
    });
    expect(fetchMock.mock.calls.some(([u, init]) => u === '/api/agent-keys/k1' && init?.method === 'DELETE')).toBe(true);
    expect(screen.queryByTestId('agent-key')).toBeNull();
  });

  it('shows nothing before the table exists', async () => {
    serve(null);
    const { container } = render(<AgentKeysSection />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });
});
