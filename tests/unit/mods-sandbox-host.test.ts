import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOD_LOAD_WALL_MS } from '@/lib/mods/limits';

vi.mock('@/lib/mods/sandbox/generated/version', () => ({ MOD_RUNTIME_VERSION: 'v-test' }));

import { __resetModSandboxForTests, modSandbox } from '@/lib/mods/sandbox-host';

/**
 * The sandbox host's boot clock (lib/mods/sandbox-host.ts): it starts at the
 * iframe's load, never at its creation; a remove() while it boots latches
 * nothing; and a frame URL that is a 404 reads as `outdated`.
 */

const frame = () => document.querySelector('iframe');

describe('modSandbox boot', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    __resetModSandboxForTests();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The iframe's load, with its contentWindow's postMessage stubbed. */
  function loadFrame(): ReturnType<typeof vi.fn> {
    const f = frame()!;
    const post = vi.fn();
    Object.defineProperty(f, 'contentWindow', { configurable: true, value: { postMessage: post } });
    f.dispatchEvent(new Event('load'));
    return post;
  }

  it('does not start the boot clock before the page has loaded', async () => {
    const release = modSandbox.hold();
    const status = modSandbox.ensure();
    await vi.advanceTimersByTimeAsync(MOD_LOAD_WALL_MS * 3);
    expect(modSandbox.status()).toBe('booting');
    const post = loadFrame();
    expect(post).toHaveBeenCalledWith({ ch: 'dsul-mods', t: 'boot', v: 'v-test' }, '*', expect.any(Array));
    await vi.advanceTimersByTimeAsync(MOD_LOAD_WALL_MS + 10);
    expect(await status).toBe('unavailable');
    release();
  });

  it('a remove() while booting latches nothing, and the next ensure boots again', async () => {
    const release = modSandbox.hold();
    const first = modSandbox.ensure();
    loadFrame();
    release();
    expect(await first).toBe('idle');
    await vi.advanceTimersByTimeAsync(MOD_LOAD_WALL_MS * 2);
    expect(modSandbox.status()).toBe('idle');

    const again = modSandbox.hold();
    void modSandbox.ensure();
    expect(modSandbox.status()).toBe('booting');
    expect(frame()).not.toBeNull();
    again();
  });

  it('a removed boot never overwrites a newer one', async () => {
    const release = modSandbox.hold();
    void modSandbox.ensure();
    loadFrame();
    release();
    const again = modSandbox.hold();
    void modSandbox.ensure();
    await vi.advanceTimersByTimeAsync(MOD_LOAD_WALL_MS - 100);
    // The first boot's clock would have run out by now; the second is still booting.
    await vi.advanceTimersByTimeAsync(200);
    expect(modSandbox.status()).toBe('booting');
    again();
  });

  it('a frame URL that is a 404 is outdated, not unavailable', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    const release = modSandbox.hold();
    const status = modSandbox.ensure();
    loadFrame();
    await vi.advanceTimersByTimeAsync(MOD_LOAD_WALL_MS + 10);
    expect(await status).toBe('outdated');
    expect(fetchMock).toHaveBeenCalledWith('/mods/sandbox/v-test', expect.objectContaining({ method: 'HEAD' }));
    release();
  });

  it('a page that never arrives fails this attempt without latching', async () => {
    const release = modSandbox.hold();
    const status = modSandbox.ensure();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await status).toBe('unavailable');
    expect(modSandbox.status()).toBe('idle');
    expect(frame()).toBeNull();
    release();
  });
});
