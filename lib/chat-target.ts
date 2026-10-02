import { useAISettingsStore } from './ai-settings-store';
import { resetPluginTransport } from './chat-transport';
import { resetGeneralThread } from './open-chat';
import { useRailStore } from './rail-store';
import type { ChatTarget } from './ai-types';

/**
 * The ONLY user-initiated way to change who answers in chat. It DELETES
 * NOTHING: nothing in the app deletes a saved conversation except the user's
 * own Delete.
 *
 * It sets the device-local choice, drops the cached plugin transport, and
 * returns both Ask stacks to home (and gives the old single-thread panels a
 * fresh general conversation), so the next ask starts a new conversation with
 * the new answerer. An old conversation can still be continued: each message
 * records who answered it, and the store folds a continuity note into the
 * context for OpenClaw (lib/conversations-store.ts).
 *
 * It is a function and not a store subscriber on purpose. A subscriber also
 * fires when the persisted choice REHYDRATES, when `clearUserScopedState`
 * resets it, and on any raw `setState`, and none of those is a person choosing
 * a different answerer. No-op for the same value.
 */
export function chooseChatTarget(next: ChatTarget): void {
  const settings = useAISettingsStore.getState();
  if (settings.chatTarget === next) return;
  settings.setChatTarget(next);
  resetPluginTransport();
  useRailStore.getState().popToHome('desktop');
  useRailStore.getState().popToHome('phone');
  resetGeneralThread();
}
