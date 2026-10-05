import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DsulDesktop } from '@/lib/desktop';

/**
 * The login page mounts here once the two things jsdom lacks are out of the
 * way: the relay field draws to a canvas, and the column is measured with a
 * ResizeObserver. Neither has anything to do with which way a sign-in goes.
 */
vi.mock('@/components/primitives/relay-field', () => ({ RelayField: () => null }));

let search = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => search }));

const signInWithOAuth = vi.fn();
const signInWithOtp = vi.fn();
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({ auth: { signInWithOAuth, signInWithOtp } }),
}));

import { LoginPage } from '@/app/login/login-page';
import { getDesktopBridge } from '@/lib/desktop';

const ORIGIN = window.location.origin;
const AUTHORIZE = 'https://ctcspcferkdlzdcqlozq.supabase.co/auth/v1/authorize?provider=google';

beforeAll(() => {
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver;
  }
});

function bridge(overrides: Partial<DsulDesktop> = {}): DsulDesktop {
  return {
    version: 1,
    shellVersion: '1.0.0',
    electronVersion: '44.5.1',
    platform: 'win32',
    onQuickCapture: vi.fn(() => () => {}),
    openAuthUrl: vi.fn(async () => true),
    armEmailSignIn: vi.fn(async () => {}),
    takeSignInNotice: vi.fn(async () => false),
    ...overrides,
  };
}

function mount(query = '') {
  search = new URLSearchParams(query);
  return render(<LoginPage />);
}

const google = () => screen.getByRole('button', { name: /continue with google/i });

async function sendEmail(address = 'kirby@example.com') {
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: address } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /continue with email/i }));
  });
}

beforeEach(() => {
  signInWithOAuth.mockReset().mockResolvedValue({ data: { provider: 'google', url: AUTHORIZE }, error: null });
  signInWithOtp.mockReset().mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  delete window.dsulDesktop;
});

describe('getDesktopBridge', () => {
  it('is null in a browser, and for a bridge shape it does not know', () => {
    expect(getDesktopBridge()).toBeNull();
    window.dsulDesktop = { ...bridge(), version: 2 } as unknown as DsulDesktop;
    expect(getDesktopBridge()).toBeNull();
  });

  it('returns the bridge the shell set', () => {
    const b = bridge();
    window.dsulDesktop = b;
    expect(getDesktopBridge()).toBe(b);
  });
});

describe('login in a browser', () => {
  it('sends Google through the callback, on to the page that asked', async () => {
    mount('redirect=%2Fgoal%2Fx');
    await act(async () => {
      fireEvent.click(google());
    });
    expect(signInWithOAuth).toHaveBeenCalledExactlyOnceWith({
      provider: 'google',
      options: { redirectTo: `${ORIGIN}/auth/callback?next=%2Fgoal%2Fx` },
    });
  });

  it('sends the email link through the callback and says to open it on this device', async () => {
    mount();
    await sendEmail();
    expect(signInWithOtp).toHaveBeenCalledExactlyOnceWith({
      email: 'kirby@example.com',
      options: { emailRedirectTo: `${ORIGIN}/auth/callback` },
    });
    expect(screen.getByText(/open it on this device/i)).toBeInTheDocument();
  });
});

describe('login in the desktop app', () => {
  it('opens Google in the system browser, back through /auth/desktop, ignoring redirect', async () => {
    const b = bridge();
    window.dsulDesktop = b;
    mount('redirect=%2Fgoal%2Fx');
    await act(async () => {
      fireEvent.click(google());
    });

    expect(signInWithOAuth).toHaveBeenCalledExactlyOnceWith({
      provider: 'google',
      options: { redirectTo: `${ORIGIN}/auth/desktop`, skipBrowserRedirect: true },
    });
    expect(b.openAuthUrl).toHaveBeenCalledExactlyOnceWith(AUTHORIZE);
    expect(screen.getByRole('heading', { name: /finish signing in in your browser/i })).toBeInTheDocument();

    const again = screen.getByRole('button', { name: /open again/i });
    expect(again).toBeEnabled();
    await act(async () => {
      fireEvent.click(again);
    });
    expect(b.openAuthUrl).toHaveBeenCalledTimes(2);
    expect(b.openAuthUrl).toHaveBeenLastCalledWith(AUTHORIZE);
    expect(signInWithOAuth).toHaveBeenCalledTimes(1);
  });

  it('says so when the app would not open the browser, and stays on the form', async () => {
    window.dsulDesktop = bridge({ openAuthUrl: vi.fn(async () => false) });
    mount();
    await act(async () => {
      fireEvent.click(google());
    });
    expect(screen.getByText(/couldn’t open your browser/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /finish signing in/i })).toBeNull();
    expect(google()).toBeEnabled();
  });

  it('goes back to both ways in from the waiting state', async () => {
    window.dsulDesktop = bridge();
    mount();
    await act(async () => {
      fireEvent.click(google());
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in another way/i }));
    expect(screen.getByRole('button', { name: /continue with email/i })).toBeInTheDocument();
  });

  it('arms the email sign-in only once the email is on its way', async () => {
    const b = bridge();
    window.dsulDesktop = b;
    let release!: (value: { data: object; error: null }) => void;
    signInWithOtp.mockReturnValue(new Promise((resolve) => (release = resolve)));
    mount('redirect=%2Fgoal%2Fx');
    await sendEmail();

    expect(signInWithOtp).toHaveBeenCalledExactlyOnceWith({
      email: 'kirby@example.com',
      options: { emailRedirectTo: `${ORIGIN}/auth/desktop` },
    });
    expect(b.armEmailSignIn).not.toHaveBeenCalled();

    await act(async () => release({ data: {}, error: null }));
    expect(b.armEmailSignIn).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/open the link on this computer/i)).toBeInTheDocument();
  });

  it('never arms when the email did not go out', async () => {
    const b = bridge();
    window.dsulDesktop = b;
    signInWithOtp.mockResolvedValue({ data: {}, error: { message: 'Email rate limit exceeded' } });
    mount();
    await sendEmail();
    expect(b.armEmailSignIn).not.toHaveBeenCalled();
    expect(screen.getByText('Email rate limit exceeded')).toBeInTheDocument();
  });
});

describe('a sign-in that came back with an error', () => {
  // The desktop app's handoff ends on these. A browser keeps the bare form it
  // has always shown there (the last test), so each of the rest has a bridge.
  beforeEach(() => {
    window.dsulDesktop = bridge();
  });

  it.each([
    ['expired', /took too long and expired/],
    ['cancelled', /was cancelled/],
    ['auth', /didn’t go through/],
  ])("shows dsul's own words for ?error=%s", (value, copy) => {
    mount(`error=${value}`);
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it('shows nothing for a value it does not know, and never the URL text', () => {
    mount('error=Something+bad&error_description=%3Cb%3Ehi%3C%2Fb%3E');
    expect(document.body.textContent).not.toContain('Something bad');
    expect(document.body.innerHTML).not.toContain('<b>hi</b>');
    expect(document.querySelector('.text-destructive')).toBeNull();
  });

  it('clears the notice when a new sign-in starts', async () => {
    mount('error=expired');
    await waitFor(() => expect(screen.getByText(/expired/)).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(google());
    });
    expect(screen.queryByText(/took too long/)).toBeNull();
  });

  it('shows nothing in a browser, where /auth/callback failures land too', () => {
    delete window.dsulDesktop;
    mount('error=auth');
    expect(screen.queryByText(/didn’t go through/)).toBeNull();
    expect(document.querySelector('.text-destructive')).toBeNull();
  });
});
