import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { config } from '@/proxy';

// The mod sandbox frame (app/mods/sandbox/[v]) is left out of the gate: a
// frame load costs no getUser(), and a signed-out moment cannot put the
// login page inside the frame. Only the exact mods/sandbox/ segment is left
// out; anything else under /mods stays gated. Read through Next's own
// matcher, as tests/unit/proxy-signed-out.test.ts does.
async function gated(path: string) {
  const g = globalThis as { AsyncLocalStorage?: unknown };
  g.AsyncLocalStorage ??= AsyncLocalStorage;
  const { unstable_doesMiddlewareMatch } = await import('next/experimental/testing/server');
  return unstable_doesMiddlewareMatch({ config, url: `https://do.dsul.app${path}` });
}

describe('proxy matcher and the mod sandbox', () => {
  it.each(['/mods/sandbox/abc', '/mods/sandbox/0123456789abcdef'])('never gates %s', async (path) => {
    expect(await gated(path)).toBe(false);
  });

  it.each(['/mods/other', '/modsx', '/mods', '/mods/sandbox', '/'])('still runs on %s', async (path) => {
    expect(await gated(path)).toBe(true);
  });
});
