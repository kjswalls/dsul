import { render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * /login after Settings → dsul → Delete account: the dialog leaves a note in
 * sessionStorage before the sign-out that brings the browser here, and the
 * page says the account is deleted, once.
 *
 * Mounted as login-desktop.test.tsx mounts it: the relay field draws to a
 * canvas and the column is measured with a ResizeObserver, neither of which
 * has anything to do with the note.
 */
vi.mock('@/components/primitives/relay-field', () => ({ RelayField: () => null }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({ auth: { signInWithOAuth: vi.fn(), signInWithOtp: vi.fn() } }),
}));

import { LoginPage } from '@/app/login/login-page';
import { DELETION_NOTICE_KEY, rememberDeletion } from '@/lib/account-client';

const DELETED = 'Your dsul account is deleted.';

beforeAll(() => {
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver;
  }
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe('/login after a deletion', () => {
  it('shows the done line as a status, and takes the note', async () => {
    rememberDeletion('revoked', false);
    render(<LoginPage apple={false} />);
    const line = await screen.findByTestId('login-deleted');
    expect(line).toHaveTextContent(DELETED);
    expect(line).toHaveAttribute('role', 'status');
    expect(window.sessionStorage.getItem(DELETION_NOTICE_KEY)).toBeNull();
  });

  it("names Apple's steps for an Apple account the web couldn't revoke", async () => {
    rememberDeletion('not_revoked', true);
    render(<LoginPage apple={false} />);
    const line = await screen.findByTestId('login-deleted');
    expect(line.textContent).toMatch(/^Your dsul account is deleted\. Apple may still list dsul/);
    expect(line.textContent).toContain('account.apple.com');
  });

  it('shows it once: a second visit has nothing to say', async () => {
    rememberDeletion('none', false);
    const first = render(<LoginPage apple={false} />);
    await screen.findByTestId('login-deleted');
    first.unmount();
    render(<LoginPage apple={false} />);
    // The effect has run by the time the buttons are there.
    await screen.findByRole('button', { name: /continue with google/i });
    expect(screen.queryByTestId('login-deleted')).toBeNull();
  });

  it('shows nothing without the note', async () => {
    render(<LoginPage apple={false} />);
    await screen.findByRole('button', { name: /continue with google/i });
    expect(screen.queryByTestId('login-deleted')).toBeNull();
    expect(screen.queryByText(DELETED)).toBeNull();
  });
});
