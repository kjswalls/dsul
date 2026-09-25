import { describe, it, expect } from 'vitest';
import { assertLocalTarget } from '../e2e/helpers/env';

// The E2E suite once ran against production Supabase from CI and took it down
// (2026-09-24). This locks the refusal: loopback only, no override.
describe('assertLocalTarget', () => {
  const local = 'http://127.0.0.1:54321';

  it('accepts a loopback Supabase and the default app URL', () => {
    for (const url of [local, 'http://localhost:54321', 'http://[::1]:54321']) {
      expect(() => assertLocalTarget({ NEXT_PUBLIC_SUPABASE_URL: url })).not.toThrow();
    }
  });

  it('refuses a hosted Supabase project', () => {
    expect(() =>
      assertLocalTarget({ NEXT_PUBLIC_SUPABASE_URL: 'https://ctcspcferkdlzdcqlozq.supabase.co' })
    ).toThrow(/non-local host.*ctcspcferkdlzdcqlozq\.supabase\.co/);
  });

  it('is not fooled by userinfo that looks local', () => {
    expect(() =>
      assertLocalTarget({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1@evil.example:54321' })
    ).toThrow(/evil\.example/);
  });

  it('refuses a missing Supabase URL rather than letting the dev server fall back', () => {
    expect(() => assertLocalTarget({})).toThrow(/not set/);
  });

  it('refuses a malformed Supabase URL', () => {
    expect(() => assertLocalTarget({ NEXT_PUBLIC_SUPABASE_URL: 'not a url' })).toThrow(
      /not a URL/
    );
  });

  it('refuses an app under test that is not on loopback', () => {
    expect(() =>
      assertLocalTarget({ NEXT_PUBLIC_SUPABASE_URL: local, E2E_BASE_URL: 'https://do.dsul.app' })
    ).toThrow(/E2E_BASE_URL → do\.dsul\.app/);
  });

  it('has no override, even under CI', () => {
    expect(() =>
      assertLocalTarget({
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        CI: 'true',
        E2E_ALLOW_REMOTE_SUPABASE: 'example.supabase.co',
      })
    ).toThrow(/non-local host/);
  });
});
