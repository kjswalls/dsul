import { useAISettingsStore } from './ai-settings-store';
import { clearChatState } from './chat-store';
import type { ChatTarget } from './ai-types';

/**
 * The ONLY user-initiated way to change who answers in chat.
 *
 * A new answerer gets fresh transcripts: a thread that interleaves replies from
 * two different answerers reads as one voice contradicting itself, and the
 * plugin path keys its sessions per transport. So this wipes every transcript
 * (the global thread and every item thread, in memory and on disk) and the
 * plugin transport cache, through `clearChatState()`.
 *
 * It is a function and not a store subscriber on purpose. A subscriber also
 * fires when the persisted choice REHYDRATES, when `clearUserScopedState`
 * resets it, and on any raw `setState` — and each of those wiped a transcript
 * the user never asked to lose. Only a person choosing a different answerer
 * reaches this. No-op for the same value.
 */
export function chooseChatTarget(next: ChatTarget): void {
  const settings = useAISettingsStore.getState();
  if (settings.chatTarget === next) return;
  settings.setChatTarget(next);
  clearChatState();
}
