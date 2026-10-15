'use client';

import { create } from 'zustand';
import { browserCanPair, deleteDevice, generateDeviceKeys, readDevice, writeDevice } from './openclaw-browser/device-store';
import { GatewayLink, identityFrom, type LinkRefusal, type LinkStatus } from './openclaw-browser/link';

/**
 * Chat with OpenClaw straight from this browser: the pairing as the app sees
 * it, and the one live connection (memory/plans/openclaw-browser-chat.md).
 *
 * DEVICE-LOCAL, like the chat-target choice: the pairing is this browser's,
 * so the phone and the desktop app each set up their own, and nothing about it
 * is on dsul's servers. The gate reads `paired` (lib/ai-registry.ts,
 * `browserChat`); Settings → AI drives setup; chat-transport sends through
 * `browserLink()`.
 */

export type SetupState =
  | { step: 'idle' }
  | { step: 'connecting' }
  | { step: 'pairing'; requestId: string | null }
  | { step: 'failed'; why: SetupFailure };

export type SetupFailure = LinkRefusal | 'unreachable' | 'unsupported' | 'address' | 'insecure';

export interface BrowserPairing {
  url: string;
  pairedAt: number;
  /** The gateway's id for this browser, for `openclaw devices remove`. */
  deviceId: string;
}

interface State {
  /** Whose pairing this is. Null until hydrated, and after sign-out. */
  userId: string | null;
  /** This browser has an approved pairing for `userId`. */
  paired: BrowserPairing | null;
  /** The setup dialog's progress. */
  setup: SetupState;

  hydrate: (userId: string) => Promise<void>;
  startSetup: (input: { url: string; token: string }) => Promise<void>;
  cancelSetup: () => void;
  /** The gateway said this pairing is gone: chat stops offering it here. */
  markUnpaired: () => void;
  forget: () => Promise<void>;
  reset: () => void;
}

let link: GatewayLink | null = null;
let setupTimer: ReturnType<typeof setTimeout> | null = null;
/** Setup gives up waiting for approval after this long. */
const SETUP_WAIT_MS = 10 * 60_000;

function dropLink() {
  if (setupTimer) clearTimeout(setupTimer);
  setupTimer = null;
  link?.stop();
  link = null;
}

/**
 * The address as a browser opens it. A person may paste the http(s) form the
 * Control UI shows; the socket is the same host. Null for anything else. Pure.
 */
export function gatewaySocketUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `wss://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * An https page may not open a plain ws:// socket to another machine (mixed
 * content), so the browser would refuse it without a word. Loopback is the
 * exception browsers make. Pure.
 */
export function blockedAsMixedContent(socketUrl: string, pageProtocol: string): boolean {
  if (pageProtocol !== 'https:') return false;
  const url = new URL(socketUrl);
  return url.protocol === 'ws:' && !LOOPBACK.has(url.hostname);
}

export const useOpenClawBrowserStore = create<State>()((set, get) => ({
  userId: null,
  paired: null,
  setup: { step: 'idle' },

  hydrate: async (userId) => {
    if (get().userId !== userId) {
      dropLink();
      set({ userId, paired: null, setup: { step: 'idle' } });
    }
    let paired: BrowserPairing | null = null;
    try {
      const record = await readDevice(userId);
      if (record?.deviceToken && record.pairedAt) {
        paired = { url: record.url, pairedAt: record.pairedAt, deviceId: (await identityFrom(record.keys)).deviceId };
      }
    } catch {
      // No IndexedDB (a private window, blocked storage): nothing is paired here.
    }
    if (get().userId === userId) set({ paired });
  },

  startSetup: async ({ url: typed, token }) => {
    const userId = get().userId;
    if (!userId) return;
    const url = gatewaySocketUrl(typed);
    if (!url) return set({ setup: { step: 'failed', why: 'address' } });
    if (blockedAsMixedContent(url, window.location.protocol)) return set({ setup: { step: 'failed', why: 'insecure' } });
    if (!token.trim()) return set({ setup: { step: 'failed', why: 'token' } });
    dropLink();
    set({ setup: { step: 'connecting' } });
    if (!(await browserCanPair())) return set({ setup: { step: 'failed', why: 'unsupported' } });

    // Keep this browser's key across a re-setup, so the gateway sees the same
    // device rather than collecting a new one each time.
    const existing = await readDevice(userId).catch(() => null);
    const keys = existing?.keys ?? (await generateDeviceKeys());
    await writeDevice({ userId, url, keys, deviceToken: null, pairedAt: null });
    const deviceId = (await identityFrom(keys)).deviceId;
    if (get().userId !== userId) return;
    set({ paired: null });

    let reachedPairing = false;
    const mine = new GatewayLink({
      userId,
      url,
      sharedToken: token.trim(),
      onStatus: (s: LinkStatus) => {
        if (link !== mine) return;
        if (s.kind === 'pairing') {
          reachedPairing = true;
          set({ setup: { step: 'pairing', requestId: s.requestId } });
        } else if (s.kind === 'ready') {
          if (setupTimer) clearTimeout(setupTimer);
          setupTimer = null;
          set({ setup: { step: 'idle' }, paired: { url, pairedAt: Date.now(), deviceId } });
        } else if (s.kind === 'refused') {
          // After setup this is the steady link (browserLink reuses it).
          if (get().paired) {
            if (s.why === 'unpaired') get().markUnpaired();
            return;
          }
          dropLink();
          set({ setup: { step: 'failed', why: s.why } });
        } else if (s.kind === 'offline' && !reachedPairing && get().setup.step === 'connecting') {
          dropLink();
          set({ setup: { step: 'failed', why: 'unreachable' } });
        }
      },
    });
    link = mine;
    setupTimer = setTimeout(() => {
      if (link === mine && get().setup.step === 'pairing') get().cancelSetup();
    }, SETUP_WAIT_MS);
    mine.start();
  },

  cancelSetup: () => {
    if (get().setup.step === 'idle') return;
    dropLink();
    set({ setup: { step: 'idle' } });
  },

  markUnpaired: () => {
    dropLink();
    set({ paired: null });
  },

  forget: async () => {
    const userId = get().userId;
    dropLink();
    set({ paired: null, setup: { step: 'idle' } });
    if (userId) await deleteDevice(userId).catch(() => {});
  },

  reset: () => {
    dropLink();
    set({ userId: null, paired: null, setup: { step: 'idle' } });
  },
}));

/** The live connection for a paired browser, started on first use. Null when not paired. */
export function browserLink(): GatewayLink | null {
  const { userId, paired } = useOpenClawBrowserStore.getState();
  if (!userId || !paired) return null;
  if (!link || link.userId !== userId || link.url !== paired.url) {
    dropLink();
    link = new GatewayLink({
      userId,
      url: paired.url,
      onStatus: (s) => {
        if (s.kind === 'refused' && s.why === 'unpaired') useOpenClawBrowserStore.getState().markUnpaired();
      },
    });
    link.start();
  }
  return link;
}
