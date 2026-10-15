import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

/**
 * Settings → AI → OpenClaw → Chat in Ask: the setup dialog says what an
 * approved browser can do BEFORE it asks for the token, and the set-up state
 * says it again beside Forget this browser.
 */

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

import { OpenClawBrowserChat } from '@/components/settings/openclaw-browser-chat';
import { useOpenClawBrowserStore } from '@/lib/openclaw-browser-store';
import { BROWSER_CAN, BROWSER_CANNOT } from '@/lib/openclaw-browser-copy';

beforeEach(() => {
  useOpenClawBrowserStore.getState().reset();
});

describe('OpenClawBrowserChat', () => {
  it('walks to the token step only after showing what the browser can do', async () => {
    await act(() => useOpenClawBrowserStore.getState().hydrate('u1'));
    render(<OpenClawBrowserChat />);
    fireEvent.click(screen.getByTestId('openclaw-browser-setup'));

    const risk = screen.getByTestId('openclaw-browser-risk');
    for (const line of [...BROWSER_CAN, ...BROWSER_CANNOT]) expect(risk.textContent).toContain(line);
    expect(risk.textContent).toContain('If dsul were ever compromised');
    expect(screen.getByTestId('openclaw-browser-origin-command').textContent).toContain(
      `allowedOrigins '["${window.location.origin}"]'`
    );
    expect(screen.queryByTestId('openclaw-browser-token')).toBeNull();

    fireEvent.click(screen.getByTestId('openclaw-browser-next'));
    expect(screen.getByTestId('openclaw-browser-token')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('openclaw-browser-connect')).toBeDisabled();
  });

  it('shows a refusal in words', async () => {
    await act(() => useOpenClawBrowserStore.getState().hydrate('u1'));
    render(<OpenClawBrowserChat />);
    fireEvent.click(screen.getByTestId('openclaw-browser-setup'));
    fireEvent.click(screen.getByTestId('openclaw-browser-next'));
    fireEvent.change(screen.getByTestId('openclaw-browser-address'), { target: { value: 'ftp://nope' } });
    fireEvent.change(screen.getByTestId('openclaw-browser-token'), { target: { value: 'tok' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('openclaw-browser-connect'));
    });
    expect(screen.getByTestId('openclaw-browser-error').textContent).toMatch(/gateway address/);
  });

  it('once set up: the host, the same list, and Forget this browser', () => {
    useOpenClawBrowserStore.setState({
      userId: 'u1',
      paired: { url: 'wss://box.tail1.ts.net', pairedAt: 1, deviceId: 'a'.repeat(64) },
    });
    render(<OpenClawBrowserChat />);
    expect(screen.getByTestId('openclaw-browser-host').textContent).toBe('box.tail1.ts.net');
    expect(screen.getByTestId('openclaw-browser-status').textContent).toContain('On this browser');
    expect(screen.getByTestId('openclaw-browser-capabilities').textContent).toContain(BROWSER_CANNOT[0]);
    expect(screen.getByTestId('openclaw-browser-forget')).toBeInTheDocument();
  });
});
