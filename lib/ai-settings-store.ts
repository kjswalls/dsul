'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ChatTarget } from './ai-types';

export type { ChatTarget } from './ai-types';

interface AISettings {
  /**
   * Who the user chose to answer in chat, on this device. The EFFECTIVE target
   * falls back to whatever else is connected (lib/ai-registry.ts), so this is a
   * preference, not a promise that anything answers.
   */
  chatTarget: ChatTarget;
  /** Persisted and read by no view. Kept per the CLAUDE.md rule on such settings. */
  assistantName: string;
  /** Custom instructions, appended to the built-in prompt server-side. */
  systemPrompt: string;
  /**
   * This browser held an AI key from before keys moved server-side. Raised once
   * by the v0 → v1 migration so the app can explain why AI went quiet for
   * exactly those users; cleared when they dismiss it or connect a model.
   */
  legacyNotice: boolean;
}

/**
 * Every field here belongs to the ACCOUNT, not the browser.
 *
 * `dsul-ai-settings` is a browser-global localStorage key, so on a shared
 * browser this blob is whoever signed in last — which is why the store is in
 * the clear registry (lib/local-state.ts). None of it is a credential any more:
 * the model key lives server-side, sealed, and never comes back to the browser
 * (see lib/ai-connection-store.ts). `systemPrompt` is still text the user
 * wrote, so it is cleared like everything else.
 */
const USER_SCOPED_DEFAULTS: AISettings = {
  chatTarget: 'model',
  assistantName: 'Beacon',
  systemPrompt: '',
  legacyNotice: false,
};

export interface AISettingsStore extends AISettings {
  /** RAW setter. A user-initiated change goes through `chooseChatTarget` (lib/chat-target.ts). */
  setChatTarget: (t: ChatTarget) => void;
  setAssistantName: (n: string) => void;
  setSystemPrompt: (p: string) => void;
  dismissLegacyNotice: () => void;
  /** Drop this account's AI settings — see lib/local-state.ts. Never wipes transcripts. */
  clearUserScopedState: () => void;
}

/**
 * v0 → v1. v0 held `provider` ('openclaw' | 'openai' | 'anthropic' | 'none'),
 * a plaintext `apiKey` and a `model`. The key and the model are DROPPED here:
 * persist writes the partialized state back after a migrate, so the plaintext
 * key leaves localStorage on the first load of this build.
 */
export function migrateAISettings(persisted: unknown, version: number): AISettings {
  const p = (persisted && typeof persisted === 'object' ? persisted : {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);

  if (version >= 1) {
    const t = p.chatTarget;
    return {
      chatTarget: t === 'openclaw' || t === 'none' || t === 'model' ? t : USER_SCOPED_DEFAULTS.chatTarget,
      assistantName: str(p.assistantName, USER_SCOPED_DEFAULTS.assistantName),
      systemPrompt: str(p.systemPrompt, USER_SCOPED_DEFAULTS.systemPrompt),
      legacyNotice: p.legacyNotice === true,
    };
  }

  const provider = p.provider;
  return {
    chatTarget: provider === 'openclaw' ? 'openclaw' : provider === 'none' ? 'none' : 'model',
    assistantName: str(p.assistantName, USER_SCOPED_DEFAULTS.assistantName),
    systemPrompt: str(p.systemPrompt, USER_SCOPED_DEFAULTS.systemPrompt),
    legacyNotice:
      provider === 'openai' ||
      provider === 'anthropic' ||
      (typeof p.apiKey === 'string' && p.apiKey !== ''),
  };
}

export const useAISettingsStore = create<AISettingsStore>()(
  persist(
    (set) => ({
      ...USER_SCOPED_DEFAULTS,
      clearUserScopedState: () => set({ ...USER_SCOPED_DEFAULTS }),
      setChatTarget: (chatTarget) => set({ chatTarget }),
      setAssistantName: (assistantName) => set({ assistantName }),
      setSystemPrompt: (systemPrompt) => set({ systemPrompt }),
      dismissLegacyNotice: () => set({ legacyNotice: false }),
    }),
    {
      name: 'dsul-ai-settings',
      version: 1,
      migrate: migrateAISettings,
      partialize: (state): AISettings => ({
        chatTarget: state.chatTarget,
        assistantName: state.assistantName,
        systemPrompt: state.systemPrompt,
        legacyNotice: state.legacyNotice,
      }),
    }
  )
);
