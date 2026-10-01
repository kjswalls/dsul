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

  it('sends a failed exchange to the login page', async () => {
    exchange.mockResolvedValue({ error: { message: 'bad_code_verifier' } });
    const res = await at('?code=abc&next=%2Fgoal%2Fx');
    expect(res.headers.get('location')).toBe('https://do.dsul.app/login?error=auth');
  });
});
