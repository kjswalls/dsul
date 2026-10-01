import { beforeEach, describe, expect, it, vi } from 'vitest';

const exchange = vi.fn();
vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(async () => ({ auth: { exchangeCodeForSession: exchange } })),
}));

import { GET } from '@/app/auth/callback/route';

const at = (qs: string) => GET(new Request(`https://do.dsul.app/auth/callback${qs}`));

describe('/auth/callback', () => {
  beforeEach(() => {
    exchange.mockReset();
    exchange.mockResolvedValue({ error: null });
  });

  it('goes on to next after a good exchange', async () => {
    const res = await at('?code=abc&next=%2Fconnect%3Fcode%3Dx');
    expect(exchange).toHaveBeenCalledWith('abc');
    expect(res.headers.get('location')).toBe('https://do.dsul.app/connect?code=x');
  });

  it('goes home with no next', async () => {
    const res = await at('?code=abc');
    expect(res.headers.get('location')).toBe('https://do.dsul.app/');
  });

  it.each(['%40evil.com', '%2F%2Fevil.com', '%2F%5Cevil.com', 'https%3A%2F%2Fevil.com'])(
    'never leaves the origin for next=%s',
    async (next) => {
      const res = await at(`?code=abc&next=${next}`);
      expect(new URL(res.headers.get('location')!).host).toBe('do.dsul.app');
      expect(res.headers.get('location')).toBe('https://do.dsul.app/');
    },
  );

  it('sends a failed exchange to the login page, keeping where it was going', async () => {
    exchange.mockResolvedValue({ error: { message: 'bad_code_verifier' } });
    const res = await at('?code=abc&next=%2Fgoal%2Fx');
    expect(res.headers.get('location')).toBe(
      'https://do.dsul.app/login?redirect=%2Fgoal%2Fx&error=auth',
    );
  });

  it('keeps a pairing link through a failed sign-in, its code inside redirect', async () => {
    // The retry from /login reads `redirect` again (lib/auth-redirect.ts), so
    // the pairing code survives an expired or already-spent link. A top-level
    // `code` would read as an auth code to the desktop shell's guard.
    exchange.mockResolvedValue({
      error: { code: 'flow_state_expired', message: 'invalid flow state, flow state has expired' },
    });
    const res = await at('?next=%2Fconnect%3Fcode%3DABCD1234&code=STALECODE123');
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('expired');
    expect(location.searchParams.get('redirect')).toBe('/connect?code=ABCD1234');
    expect(location.searchParams.has('code')).toBe(false);
  });

  it('keeps where it was going when the provider came back with an error and no code', async () => {
    // A cancelled Google sign-in, or a magic link a mail scanner opened first:
    // GoTrue appends its error to the redirectTo, which still has `next`.
    const res = await at('?next=%2Fgoal%2Fx&error=access_denied&error_description=denied');
    expect(exchange).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(
      'https://do.dsul.app/login?redirect=%2Fgoal%2Fx&error=auth',
    );
  });

  it('carries nothing back for a next it would not go to', async () => {
    exchange.mockResolvedValue({ error: { message: 'bad_code_verifier' } });
    const res = await at('?code=abc&next=%2F%2Fevil.com');
    expect(res.headers.get('location')).toBe('https://do.dsul.app/login?error=auth');
  });

  it('says a code that outlived its flow state expired', async () => {
    exchange.mockResolvedValue({
      error: { code: 'flow_state_expired', message: 'invalid flow state, flow state has expired' },
    });
    const res = await at('?code=abc');
    expect(res.headers.get('location')).toBe('https://do.dsul.app/login?error=expired');
  });

  it('sends a callback with no code to the login page', async () => {
    const res = await at('');
    expect(exchange).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe('https://do.dsul.app/login?error=auth');
  });
});
