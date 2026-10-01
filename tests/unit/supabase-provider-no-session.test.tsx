import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { AuthRetryableFetchError } from '@supabase/supabase-js';

/**
 * A page that never had a session, driven through the REAL provider.
 *
 * The desktop app's first launch came up on the planner's "Loading your day…"
 * and stayed there. Whatever let the request past proxy.ts, the client had no
 * way out: with nothing stored, supabase-js answers getSession with
 * `{ session: null, error: null }` and emits INITIAL_SESSION, never SIGNED_OUT,
 * and the provider only acted on a session it found. lib/planner-ready.ts reads
 * "no account" as pending, so the skeleton spun for good.
 *
 * The other half of this file is what must NOT bounce: an error (a stored
 * session that could not refresh offline), a rejection (a stolen lock, which is
 * how a real offline launch ends; an unreadable cookie), the pages a signed-out
 * browser belongs on, and a session.
 */

import { signedOutNav, NO_SESSION_BOUNCE_KEY } from '@/lib/signed-out-redirect';

// Left pending: the one test with a session only needs to see adoption reach
// it, and what hydrateSettings does with an answer is not this file's subject.
vi.mock('@/lib/settings-service', () => ({
  loadSettings: vi.fn(() => new Promise(() => {})),
  saveSettings: vi.fn(),
  flushSettings: vi.fn(async () => {}),
}));

type MountAnswer = { data: { session: { user: { id: string } } | null }; error: unknown };
/** What getSession does on mount: resolve with this, or reject with `reject`. */
let answer: MountAnswer = { data: { session: null }, error: null };
let reject: unknown = undefined;
const getSession = vi.fn(async () => {
  if (reject !== undefined) throw reject;
  return answer;
});

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    auth: {
      getSession,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}));

vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));

import { loadSettings } from '@/lib/settings-service';
import { SupabaseProvider } from '@/components/providers/supabase-provider';
import { usePlannerStore } from '@/lib/planner-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useChannelSecretsStore } from '@/lib/channel-secrets-store';

const original = {
  initializeStore: usePlannerStore.getState().initializeStore,
  extensions: useExtensionsStore.getState().hydrate,
  secrets: useChannelSecretsStore.getState().hydrate,
};

let replace: MockInstance<typeof signedOutNav.replace>;
let consoleError: MockInstance<typeof console.error>;

async function mountAt(path: string) {
  window.history.replaceState({}, '', path);
  render(
    <SupabaseProvider>
      <div />
    </SupabaseProvider>
  );
  await waitFor(() => expect(getSession).toHaveBeenCalled());
  // Let getSession's answer reach its handler. Every assertion below is made
  // after this, so a "did not bounce" is about a settled mount, not an early look.
  await new Promise((r) => setTimeout(r, 0));
}

describe('the provider, on a page with no session', () => {
  beforeEach(() => {
    answer = { data: { session: null }, error: null };
    reject = undefined;
    getSession.mockClear();
    vi.mocked(loadSettings).mockClear();
    sessionStorage.clear();
    replace = vi.spyOn(signedOutNav, 'replace').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    usePlannerStore.setState({ userId: null, initializeStore: async () => {} });
    useExtensionsStore.setState({ hydrate: async () => {} });
    useChannelSecretsStore.setState({ hydrate: async () => {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
    usePlannerStore.setState({ initializeStore: original.initializeStore });
    useExtensionsStore.setState({ hydrate: original.extensions });
    useChannelSecretsStore.setState({ hydrate: original.secrets });
  });

  it('leaves / for bare /login when nothing is stored', async () => {
    await mountAt('/');
    expect(replace).toHaveBeenCalledWith('/login');
    // Stamped, so a page load that comes straight back cannot loop.
    expect(sessionStorage.getItem(NO_SESSION_BOUNCE_KEY)).not.toBeNull();
  });

  it('carries a deep page to /login as ?redirect=', async () => {
    await mountAt('/goal/g1?x=1');
    expect(replace).toHaveBeenCalledWith('/login?redirect=%2Fgoal%2Fg1%3Fx%3D1');
  });

  it('still leaves under NEXT_PUBLIC_DISABLE_AUTH=true', async () => {
    // The flag that switches the server gate off is inlined into the browser
    // bundle too. A backstop that read it would switch off with the gate, in
    // exactly the case it is for.
    vi.stubEnv('NEXT_PUBLIC_DISABLE_AUTH', 'true');
    await mountAt('/');
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it.each(['/login', '/login?redirect=%2Fgoal%2Fg1', '/auth/callback', '/auth/desktop'])(
    'stays put on %s',
    async (path) => {
      await mountAt(path);
      expect(replace).not.toHaveBeenCalled();
    }
  );

  it('stays put when a stored session could not refresh (offline)', async () => {
    // auth-js's own answer for an expired session and no network: no session,
    // an AuthRetryableFetchError, and the stored session kept for a retry.
    answer = {
      data: { session: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0),
    };
    await mountAt('/');
    expect(replace).not.toHaveBeenCalled();
  });

  it('stays put on a rejection, and says so', async () => {
    // The real offline launch: getSession holds the auth lock through auth-js's
    // ~30s refresh retry, and the provider's own subscription steals it after
    // 5s (see the provider). A bounce here strands that user on /login.
    reject = new Error('Lock "lock:sb-auth-token" was released because another request stole it');
    await mountAt('/');
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith('[auth] getSession failed on mount', reject)
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it('adopts a session and goes nowhere', async () => {
    answer = { data: { session: { user: { id: 'user-a' } } }, error: null };
    await mountAt('/');
    await waitFor(() => expect(vi.mocked(loadSettings)).toHaveBeenCalledWith('user-a'));
    expect(usePlannerStore.getState().userId).toBe('user-a');
    expect(replace).not.toHaveBeenCalled();
  });
});
