'use client';

import { create } from 'zustand';
import { useChatStore } from './chat-store';

/**
 * The OpenClaw gateway connection, as the settings surface sees it.
 *
 * Same posture as channel-secrets-store: the URL is not a secret and comes
 * back, the TOKEN never does. It is full operator access to the user's gateway,
 * lives in user_secrets (service-role only), and /api/agent/gateway answers
 * "is one stored" and nothing more — not even a masked value, because a mask
 * still leaks length and last-four and no screen here needs either.
 *
 * Nothing here reaches localStorage — a cached "the token is set" that outlives
 * the token is worse than asking again — so there is no browser copy for
 * lib/local-state.ts to drop when the account changes. `reset()` on sign-out is
 * the whole of it.
 */
interface GatewayStore {
  gatewayUrl: string;
  /** True when a token is stored — never the token itself. */
  hasToken: boolean;
  /** Both halves present: this is what selects the chat transport. */
  configured: boolean;
  /** False once a fetch proved migration 040 has not landed here. */
  available: boolean;
  hydratedUserId: string | null;
  /** Last write failure, surfaced inline by the settings row. */
  error: string | null;

  hydrate: (userId: string) => Promise<void>;
  setGatewayUrl: (url: string) => void;
  setToken: (token: string) => void;
  reset: () => void;
}

const INITIAL = {
  gatewayUrl: '',
  hasToken: false,
  configured: false,
  available: true,
  hydratedUserId: null as string | null,
  error: null as string | null,
};

/**
 * Writes run one after another. The URL and the token are separate fields a
 * user tabs between, so two blurs fire back to back — and the route writes two
 * different tables, where interleaving would report success for whichever
 * finished last. Same reasoning as the channel-credentials queue.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * The most recently REQUESTED hydrate — a synchronous claim, apart from
 * `hydratedUserId`, which is stamped WITH the values after the await and so
 * cannot double as an in-flight marker (the nudge-store pattern). It does two
 * jobs: a second ask for the same account while the first is in flight costs
 * nothing (the provider can ask from the load's `.then` and from the
 * navigation flush), and a slow response for a switched-away account is
 * dropped instead of being stamped over the newer one. Not released after a
 * success — it then equals `hydratedUserId`, so it guards nothing extra.
 */
let hydratingFor: string | null = null;

export const useGatewayStore = create<GatewayStore>((set, get) => ({
  ...INITIAL,

  hydrate: async (userId) => {
    if (get().hydratedUserId === userId || hydratingFor === userId) return;
    // A bare A→B switch (no SIGNED_OUT between) must never show A's URL and
    // "token saved" as B's while B's answer is in flight — cleared here,
    // synchronously, as channel-secrets-store does.
    const switching = get().hydratedUserId !== null;
    hydratingFor = userId;
    if (switching) set({ ...INITIAL });
    try {
      const res = await fetch('/api/agent/gateway');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (hydratingFor !== userId) return;
      set({
        gatewayUrl: data.gatewayUrl ?? '',
        hasToken: Boolean(data.hasToken),
        configured: Boolean(data.configured),
        available: !data.unavailable,
        hydratedUserId: userId,
        error: null,
      });
    } catch {
      if (hydratingFor !== userId) return;
      // A gateway that cannot be read is a gateway that is not configured —
      // which is true and renderable, not an error state to explain.
      set({ ...INITIAL, hydratedUserId: userId, available: false });
    }
  },

  setGatewayUrl: (url) => {
    const trimmed = url.trim();
    set({ gatewayUrl: trimmed, error: null });
    writeQueue = writeQueue.then(() => saveToServer({ gatewayUrl: trimmed }, set, get));
  },

  setToken: (token) => {
    const trimmed = token.trim();
    // Empty means "leave it alone", not "clear it": the field renders blank
    // whether or not a token is stored, so a stray blur must not wipe one.
    if (!trimmed) return;
    set({ error: null });
    writeQueue = writeQueue.then(() => saveToServer({ token: trimmed }, set, get));
  },

  reset: () => {
    hydratingFor = null;
    set({ ...INITIAL });
  },
}));

/**
 * Named for where it writes. NOT zustand's `persist` middleware — nothing here
 * touches localStorage, which is why this store is absent from
 * PERSISTED_USER_STORES in lib/local-state.ts, and why the audit test there
 * (a text match on `persist(`) must not see the word.
 */
async function saveToServer(
  body: { gatewayUrl?: string; token?: string },
  set: (partial: Partial<GatewayStore>) => void,
  get: () => GatewayStore,
) {
  try {
    const res = await fetch('/api/agent/gateway', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);

    const hasToken = body.token !== undefined ? true : get().hasToken;
    const gatewayUrl = body.gatewayUrl ?? get().gatewayUrl;
    set({ hasToken, configured: Boolean(gatewayUrl && hasToken), error: null });

    // The transport is chosen from this; re-resolve so the next message goes
    // the new way without a reload.
    useChatStore.getState().syncOpenclawInfo();
  } catch (err) {
    set({ error: err instanceof Error ? err.message : 'Could not save.' });
  }
}
