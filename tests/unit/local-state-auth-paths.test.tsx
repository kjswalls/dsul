import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

/**
 * Every path into "the current user changed", driven through the REAL provider.
 *
 * lib/local-state.ts names five, and the point of this file is that only ONE of
 * them is a sign-out. A fix wired to the sign-out button alone passes the first
 * test here and fails the rest:
 *
 *   1. explicit sign-out                     → SIGNED_OUT
 *   2. account switch, no intervening        → a bare SIGNED_IN for a
 *      sign-out                                 different user
 *   3. session expired while the tab was     → no event at all: a plain page
 *      closed, someone else signs in later      load that is already signed in
 *   4. plain page load on a shared browser   → the same, and equally silent
 *   5. another tab adopts a new user         → covered in local-state.test.ts,
 *                                               where the storage event lives
 *
 * 3 and 4 arrive as a mount with a live session and nothing in memory to
 * compare against, which is exactly what the persisted owner stamp is for. They
 * are asserted on the AI instructions (`systemPrompt`) and on the canvas
 * filters because neither is ever written by `hydrateSettings` — so a green
 * assertion means the state was CLEARED, and can't be a server response
 * happening to land on top of it.
 *
 * The last two tests are not about paths at all: they pin the ORDER of
 * `adoptUser`, and the fact that a browser refusing to persist still boots.
 */

import { signedOutNav } from '@/lib/signed-out-redirect';

// jsdom cannot navigate; every SIGNED_OUT below would otherwise log its
// "Not implemented: navigation". The redirect itself is asserted at the end.
const navReplace = vi.spyOn(signedOutNav, 'replace').mockImplementation(() => {});

const SERVER = {
  theme: 'dark',
  time_format: '24h',
  left_sidebar_hover: false,
  morning_check_enabled: true,
  morning_check_time: '08:00',
  morning_check_dismissed_date: null,
  morning_auto_age_enabled: false,
  morning_auto_age_days: 30,
  eod_review_enabled: false,
  eod_review_time: '21:00',
};

vi.mock('@/lib/settings-service', () => ({
  loadSettings: vi.fn(async () => SERVER),
  saveSettings: vi.fn(),
  flushSettings: vi.fn(async () => {}),
}));

/** The session the provider finds on mount, and the auth events after it. */
type FakeSession = {
  user: { id: string; email?: string; user_metadata?: Record<string, unknown> };
};
let mountSession: FakeSession | null = null;
let emit: (event: string, session: FakeSession | null) => void = () => {};

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: mountSession } }),
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        emit = cb as typeof emit;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  }),
}));

vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));

import { loadSettings } from '@/lib/settings-service';
import { SupabaseProvider } from '@/components/providers/supabase-provider';
import { LOCAL_STATE_OWNER_KEY, localStateOwner } from '@/lib/local-state';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { chatTransport } from '@/lib/chat-transport';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
} from '@/lib/conversations-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useChannelSecretsStore } from '@/lib/channel-secrets-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { useSessionUserStore } from '@/lib/session-user-store';
import { useUIStore } from '@/lib/ui-store';
import { ASK_PENDING_KEY, clearKeptQuestionState, keepQuestion, readKept } from '@/lib/ask-pending';
import { fail, fakeApi, fakeTransport, flush } from './helpers/conversations-fakes';

const USER_A = 'user-a';
const USER_B = 'user-b';
/** Text user A wrote into the AI instructions — disclosive, and never hydrated from the server. */
const SECRET = 'A private prompt about A';

const original = {
  initializeStore: usePlannerStore.getState().initializeStore,
  extensions: useExtensionsStore.getState().hydrate,
  secrets: useChannelSecretsStore.getState().hydrate,
  aiHydrate: useAIConnectionStore.getState().hydrate,
  aiReset: useAIConnectionStore.getState().reset,
};

/**
 * The AI gate's status GET, stood in at the store boundary like the other
 * loads: the provider's call is what is under test, not the request.
 */
const aiHydrate = vi.fn<(userId: string) => Promise<void>>(async () => {});
const aiReset = vi.fn<() => void>();

/** A question A kept from `?` while nothing answered: sessionStorage, and the memory mirror. */
const KEPT = 'A private question kept for later';

/** Kept as A, as the door keeps it: under the AI gate's account. */
function keepAsUserA() {
  const before = useAIConnectionStore.getState().hydratedUserId;
  useAIConnectionStore.setState({ hydratedUserId: USER_A });
  try {
    expect(keepQuestion(KEPT)).toBe(true);
  } finally {
    useAIConnectionStore.setState({ hydratedUserId: before });
  }
}

/**
 * The kept question is gone from storage AND from the mirror: a reader that
 * filled the mirror before the clear ran (the setup page renders before the
 * provider adopts) must find nothing either. readKept(USER_A) would return
 * the mirror's copy if only the key had gone.
 */
function expectKeptQuestionGone() {
  expect(sessionStorage.getItem(ASK_PENDING_KEY)).toBeNull();
  expect(readKept(USER_A)).toBeNull();
}

/** A's conversation, as the memory-only cache holds it mid-session. */
const CONV = 'a0a0a0a0-0000-4000-8000-00000000000a';
let seededGeneration = 0;

/**
 * User A's browser, mid-session: instructions, a conversation in memory, a
 * pre-2a transcript still on disk, filters, a stamp.
 */
function seedUserAState(owner: string | null) {
  useAISettingsStore.setState({ systemPrompt: SECRET });
  useConversationsStore.setState({
    ownerId: USER_A,
    threads: {
      [CONV]: {
        id: CONV,
        itemId: null,
        draftTitle: null,
        saved: true,
        messages: [
          {
            id: 'a0a0a0a0-0000-4000-8000-0000000000aa',
            role: 'user',
            content: 'A private question',
            status: 'complete',
            errorCode: null,
            replyTo: null,
            answerer: null,
            model: null,
            createdAt: 1,
            pos: 1,
            sync: 'saved',
          },
        ],
        load: 'loaded',
        hasEarlier: false,
        streaming: false,
        typing: false,
        fetchedAt: 1,
      },
    },
  });
  seededGeneration = useConversationsStore.getState().generation;
  useViewStore.setState({
    canvasFilters: { ...useViewStore.getState().canvasFilters, containers: ['project:A Private'] },
  });
  localStorage.setItem(
    'dsul-chat-history',
    JSON.stringify({
      messages: [{ role: 'user', content: 'A private question' }],
      savedAt: Date.now(),
    })
  );
  if (owner) localStorage.setItem(LOCAL_STATE_OWNER_KEY, owner);
  else localStorage.removeItem(LOCAL_STATE_OWNER_KEY);
  keepAsUserA();
}

function expectUserAStateGone() {
  expect(useAISettingsStore.getState().systemPrompt).toBe('');
  expect(useViewStore.getState().canvasFilters.containers).toEqual([]);
  expect(localStorage.getItem('dsul-chat-history')).toBeNull();
  // The conversation cache is reset, not just emptied: a newer generation, so
  // a save or a late answer from A's session is dropped, never applied to B.
  expect(useConversationsStore.getState().threads).toEqual({});
  expect(useConversationsStore.getState().ownerId).toBeNull();
  expect(useConversationsStore.getState().generation).toBeGreaterThan(seededGeneration);
  expect(JSON.stringify(localStorage)).not.toContain(SECRET);
  expect(JSON.stringify(localStorage)).not.toContain('A Private');
  // A question A kept from `?` goes on every path, as their conversations do.
  expectKeptQuestionGone();
}

async function mount() {
  render(
    <SupabaseProvider>
      <div />
    </SupabaseProvider>
  );
  // Wait on hydrateSettings reaching its one await, NOT on the stamp: the
  // provider does this whether or not the clear works, so a broken fix fails
  // these tests on the assertion rather than timing out on the wait.
  await waitFor(() => expect(vi.mocked(loadSettings)).toHaveBeenCalled());
}

describe('every path into "the current user changed"', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(loadSettings).mockClear();
    vi.mocked(loadSettings).mockImplementation(async () => SERVER);
    mountSession = null;
    usePlannerStore.setState({ initializeStore: async () => {} });
    useExtensionsStore.setState({ hydrate: async () => {} });
    useChannelSecretsStore.setState({ hydrate: async () => {} });
    aiHydrate.mockClear();
    aiReset.mockClear();
    useAIConnectionStore.setState({ hydrate: aiHydrate, reset: aiReset });
    useAISettingsStore.getState().clearUserScopedState();
    useViewStore.getState().clearUserScopedState('all');
    clearChatState();
    useSessionUserStore.setState({ user: null });
    useUIStore.setState({ chatOnboardingActive: false });
    clearKeptQuestionState();
  });

  afterEach(() => {
    cleanup();
    clearKeptQuestionState();
    usePlannerStore.setState({ initializeStore: original.initializeStore });
    useExtensionsStore.setState({ hydrate: original.extensions });
    useChannelSecretsStore.setState({ hydrate: original.secrets });
    useAIConnectionStore.setState({ hydrate: original.aiHydrate, reset: original.aiReset });
  });

  it('1 — an explicit sign-out drops the account state and releases the stamp', async () => {
    mountSession = { user: { id: USER_A } };
    await mount();
    seedUserAState(USER_A);

    emit('SIGNED_OUT', null);

    expectUserAStateGone();
    expect(localStateOwner()).toBeNull();
  });

  it('1b — a sign-out resets the AI gate, which persists nothing for the clear to reach', async () => {
    mountSession = { user: { id: USER_A } };
    await mount();
    expect(aiHydrate).toHaveBeenCalledWith(USER_A);
    expect(aiReset).not.toHaveBeenCalled();

    emit('SIGNED_OUT', null);

    // Not a persisted store, so clearUserScopedLocalState never touches it:
    // without its own reset, the next sign-in on this tab would read the last
    // account's answer until its own arrived.
    expect(aiReset).toHaveBeenCalledTimes(1);
  });

  it('2b — a bare SIGNED_IN for a different user re-asks the AI gate for that user', async () => {
    mountSession = { user: { id: USER_A } };
    await mount();

    emit('SIGNED_IN', { user: { id: USER_B } });

    // The store clears itself synchronously on a change of user (its own
    // test covers that); what the provider owes it is the call.
    expect(aiHydrate).toHaveBeenLastCalledWith(USER_B);
    expect(aiReset).not.toHaveBeenCalled();
  });

  it('2 — a bare SIGNED_IN for a different user, with no sign-out first', async () => {
    mountSession = { user: { id: USER_A } };
    await mount();
    seedUserAState(USER_A);

    emit('SIGNED_IN', { user: { id: USER_B } });

    expectUserAStateGone();
    expect(localStateOwner()).toBe(USER_B);
  });

  it('2c — a save still queued under the last account is dropped, never sent under the next', async () => {
    mountSession = { user: { id: USER_A } };
    await mount();
    // A's send, whose save fails once (a 5xx) and waits in the retry queue.
    const api = fakeApi();
    api.answer.appendTurn = () => fail(500, 'server');
    configureConversations({ api: api.api, transport: fakeTransport().transport });
    useAIConnectionStore.setState({
      phase: 'ready',
      hydratedUserId: USER_A,
      available: true,
      model: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        baseUrl: null,
        authMethod: 'key',
        status: 'ok',
        problem: null,
        checkedAt: '2026-10-01T00:00:00.000Z',
        limitedUntil: null,
        modelLabel: null,
      },
    });
    try {
      const store = useConversationsStore.getState();
      await store.send(store.newDraft(), 'A private question');
      await conversationsSettled();
      expect(api.turns).toHaveLength(1);
      const generation = useConversationsStore.getState().generation;

      emit('SIGNED_IN', { user: { id: USER_B } });
      useAIConnectionStore.setState({ hydratedUserId: USER_B });
      expect(useConversationsStore.getState().generation).toBe(generation + 1);
      expect(useConversationsStore.getState().threads).toEqual({});

      // Every retry trigger fires; nothing of A's is sent under B's cookie.
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      await conversationsSettled();
      expect(api.turns).toHaveLength(1);
    } finally {
      configureConversations({ transport: chatTransport });
      useAIConnectionStore.setState({ phase: 'unknown', hydratedUserId: null, model: null });
    }
  });

  it('3 — a plain page load already signed in as someone else', async () => {
    // No event will ever fire for this. The session expired while the tab was
    // shut, B signed in, and the app comes up with A's blobs still on disk.
    seedUserAState(USER_A);
    mountSession = { user: { id: USER_B } };

    await mount();

    expectUserAStateGone();
    expect(localStateOwner()).toBe(USER_B);
  });

  it('4 — a plain page load on a browser nothing has ever stamped', async () => {
    seedUserAState(null);
    mountSession = { user: { id: USER_B } };

    await mount();

    // Unstamped means the scope narrows to the disclosive — but the credential,
    // the filters and the transcript are all on that side of the line.
    expectUserAStateGone();
    expect(localStateOwner()).toBe(USER_B);
  });

  it('leaves the owner’s own state alone across a reload and a repeated SIGNED_IN', async () => {
    seedUserAState(USER_A);
    mountSession = { user: { id: USER_A } };

    await mount();
    // Supabase re-emits SIGNED_IN on every hidden→visible transition and
    // broadcasts it across tabs. Neither may cost the user their own settings.
    emit('SIGNED_IN', { user: { id: USER_A } });

    expect(useAISettingsStore.getState().systemPrompt).toBe(SECRET);
    expect(useViewStore.getState().canvasFilters.containers).toEqual(['project:A Private']);
    expect(localStorage.getItem('dsul-chat-history')).not.toBeNull();
    expect(useConversationsStore.getState().threads[CONV]?.messages).toHaveLength(1);
    expect(useConversationsStore.getState().generation).toBe(seededGeneration);
    expect(readKept(USER_A)?.text).toBe(KEPT);
    expect(sessionStorage.getItem(ASK_PENDING_KEY)).toContain(KEPT);
    expect(localStateOwner()).toBe(USER_A);
  });

  /**
   * `adoptLocalState` is the FIRST line of `adoptUser`, and nothing in the
   * current arrangement makes that visible after the fact: hydrateSettings puts
   * its `loadSettings` await before it applies anything, so moving the adopt to
   * the end of `adoptUser` still lands it before the values arrive, and every
   * outcome assertion above stays green.
   *
   * So this observes the loads AT THE MOMENT THEY ARE ENTERED. Both are called
   * synchronously from `adoptUser`, so if the adopt is reordered after either
   * of them, that one sees the previous account's instructions still in memory
   * and the stamp still naming the previous account.
   */
  it('adopts before it loads anything — the one ordering adoptUser depends on', async () => {
    seedUserAState(USER_A);
    mountSession = { user: { id: USER_B } };

    const seen: Record<string, { owner: string | null; systemPrompt: string }> = {};
    const probe = (name: string) => {
      seen[name] = {
        owner: localStateOwner(),
        systemPrompt: useAISettingsStore.getState().systemPrompt,
      };
    };
    usePlannerStore.setState({
      initializeStore: async () => {
        probe('initializeStore');
      },
    });
    vi.mocked(loadSettings).mockImplementation(async () => {
      probe('loadSettings');
      return SERVER;
    });

    await mount();

    // Both loads found this browser already adopted for B and already emptied
    // of A. Move `adoptLocalState(userId)` below either call in adoptUser and
    // that call's probe reads USER_A / the secret instead.
    expect(seen.initializeStore).toEqual({ owner: USER_B, systemPrompt: '' });
    expect(seen.loadSettings).toEqual({ owner: USER_B, systemPrompt: '' });
  });

  /**
   * The clear runs first inside `adoptUser`, and a clear is a zustand `set()`,
   * and zustand's persist middleware calls `storage.setItem` UNWRAPPED. So on a
   * browser at its quota or with site data blocked, an unguarded clear throws
   * out of `adoptUser` and NOTHING after it runs — no planner load, no
   * settings, no extensions. Before this change such a browser merely failed to
   * persist; the regression would be a blank shell.
   *
   * `loadSettings` is left PENDING here on purpose. What is under test is
   * `adoptUser`'s synchronous fan-out, and letting it resolve would run
   * hydrateSettings' own post-await `usePlannerStore.setState`, which is
   * unguarded against a throwing storage on main exactly as it is here — a
   * pre-existing hazard, out of this change's scope, and not something this
   * test should be reporting as its own.
   */
  it('still boots every load on a browser that refuses to persist', async () => {
    seedUserAState(USER_A);
    mountSession = { user: { id: USER_B } };
    vi.mocked(loadSettings).mockImplementation(() => new Promise(() => {}));

    const calls: string[] = [];
    usePlannerStore.setState({
      initializeStore: async () => {
        calls.push('planner');
        // Settle the load: channel secrets are a post-load read now
        // (supabase-provider's hydrateAfterLoad), released by its `.then`.
        await new Promise((r) => setTimeout(r, 0));
        usePlannerStore.setState({ isLoading: false });
      },
    });
    useExtensionsStore.setState({
      hydrate: async () => {
        calls.push('extensions');
      },
    });
    useChannelSecretsStore.setState({
      hydrate: async () => {
        calls.push('secrets');
      },
    });
    useAIConnectionStore.setState({
      hydrate: async () => {
        calls.push('ai');
      },
    });

    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    try {
      await mount();
    } finally {
      Storage.prototype.setItem = setItem;
    }

    await waitFor(() => expect(calls.sort()).toEqual(['ai', 'extensions', 'planner', 'secrets']));
    expect(vi.mocked(loadSettings)).toHaveBeenCalledWith(USER_B);
    // And the part of the clear that does not need storage still happened.
    expect(useAISettingsStore.getState().systemPrompt).toBe('');
  });
});

/**
 * The chrome's name and avatar come off the session the provider adopts
 * (lib/session-user-store.ts), not a getUser() per widget mount. That makes
 * the provider the one writer, so the account-switch paths above have to move
 * the profile too — and the refresh events, which carry an updated profile,
 * must never be mistaken for an adoption.
 */
describe('the session profile the chrome displays', () => {
  const A = {
    user: { id: USER_A, email: 'a@example.com', user_metadata: { full_name: 'Ada A', avatar_url: 'https://a/img' } },
  };
  const B = {
    user: { id: USER_B, email: 'b@example.com', user_metadata: { name: 'Bo B', picture: 'https://b/img' } },
  };
  let extensionHydrates = 0;

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(loadSettings).mockClear();
    vi.mocked(loadSettings).mockImplementation(async () => SERVER);
    mountSession = null;
    extensionHydrates = 0;
    usePlannerStore.setState({ initializeStore: async () => {} });
    // adoptUser calls this unconditionally (no latch of its own), so its count
    // is the tell for "an event went through adoptUser".
    useExtensionsStore.setState({
      hydrate: async () => {
        extensionHydrates += 1;
      },
    });
    useChannelSecretsStore.setState({ hydrate: async () => {} });
    useAIConnectionStore.setState({ hydrate: aiHydrate, reset: aiReset });
    useSessionUserStore.setState({ user: null });
    useUIStore.setState({ chatOnboardingActive: false });
    clearKeptQuestionState();
  });

  afterEach(() => {
    cleanup();
    clearKeptQuestionState();
    usePlannerStore.setState({ initializeStore: original.initializeStore });
    useExtensionsStore.setState({ hydrate: original.extensions });
    useChannelSecretsStore.setState({ hydrate: original.secrets });
    useAIConnectionStore.setState({ hydrate: original.aiHydrate, reset: original.aiReset });
  });

  it('is populated from the mount session', async () => {
    mountSession = A;
    await mount();
    expect(useSessionUserStore.getState().user).toEqual({
      id: USER_A,
      email: 'a@example.com',
      displayName: 'Ada A',
      avatarUrl: 'https://a/img',
    });
  });

  it('is replaced by a bare SIGNED_IN for another account, with the planner', async () => {
    mountSession = A;
    await mount();

    emit('SIGNED_IN', B);

    expect({
      plannerUser: usePlannerStore.getState().userId,
      profile: useSessionUserStore.getState().user,
    }).toEqual({
      plannerUser: USER_B,
      profile: { id: USER_B, email: 'b@example.com', displayName: 'Bo B', avatarUrl: 'https://b/img' },
    });
  });

  it('is cleared on SIGNED_OUT, and so is the retired first-run chat flag', async () => {
    mountSession = A;
    await mount();
    useUIStore.getState().setChatOnboardingActive(true);

    emit('SIGNED_OUT', null);

    expect(useSessionUserStore.getState().user).toBeNull();
    expect(useUIStore.getState().chatOnboardingActive).toBe(false);
  });

  it('leaves for /login on a SIGNED_OUT nothing else navigated from (a revoked session on /)', async () => {
    mountSession = A;
    await mount();
    navReplace.mockClear();

    emit('SIGNED_OUT', null);

    // Without this the planner's skeleton reads "no account" as "still
    // loading" and spins forever (lib/planner-ready.ts).
    expect(navReplace).toHaveBeenCalledWith('/login');
  });

  it('takes a USER_UPDATED for the same account without re-adopting it', async () => {
    mountSession = A;
    await mount();
    const settingsLoads = vi.mocked(loadSettings).mock.calls.length;
    const hydrates = extensionHydrates;

    emit('USER_UPDATED', { user: { ...A.user, user_metadata: { full_name: 'Ada Renamed' } } });

    expect(useSessionUserStore.getState().user?.displayName).toBe('Ada Renamed');
    expect(useSessionUserStore.getState().user?.avatarUrl).toBeNull();
    expect(vi.mocked(loadSettings).mock.calls.length).toBe(settingsLoads);
    expect(extensionHydrates).toBe(hydrates);
  });

  it.each(['TOKEN_REFRESHED', 'USER_UPDATED'])(
    'ignores a %s naming a different account — that is not a switch',
    async (event) => {
      mountSession = A;
      await mount();
      const before = useSessionUserStore.getState().user;
      const hydrates = extensionHydrates;

      emit(event, B);

      expect(useSessionUserStore.getState().user).toBe(before);
      expect(usePlannerStore.getState().userId).toBe(USER_A);
      expect(extensionHydrates).toBe(hydrates);
    }
  );
});
