'use client';

import { useEffect } from 'react';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { deliverAgentReplies, syncConversation } from '@/lib/agent-chat';
import { useAgentsStore } from '@/lib/agents-store';
import { useAskToStore } from '@/lib/ask-to-store';
import { useRailStore } from '@/lib/rail-store';
import { resolveConversationId } from '@/lib/conversations-store';

/** How often to look while a message to an agent waits and the page is in view. */
const WAITING_POLL_MS = 20_000;

/**
 * Brings agents' answers into Ask (lib/agent-chat.ts), mounted once in the
 * app shell. Quiet until it is needed:
 *
 *   - once at start and on every return to the page, when the account has an
 *     app to write to: one read for answers that came while it was away;
 *   - every 20s, only while a message sent from this page still waits and the
 *     page is visible;
 *   - when a conversation is opened on either surface, that conversation's
 *     own rows, so "Sent to Claude" survives a reload.
 */
export function useAgentReplies(): void {
  const { canChat } = useAICapabilities();
  const hasAgents = useAgentsStore((s) => s.agents.length > 0);
  const waiting = useAskToStore((s) => Object.keys(s.waiting).length > 0);
  const on = canChat && hasAgents;

  useEffect(() => {
    if (!on) return;
    void deliverAgentReplies();
    const onFocus = () => {
      if (document.visibilityState === 'visible') void deliverAgentReplies();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [on]);

  useEffect(() => {
    if (!on || !waiting) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void deliverAgentReplies();
    }, WAITING_POLL_MS);
    return () => clearInterval(timer);
  }, [on, waiting]);

  const desktopTop = useRailStore((s) => s.stacks.desktop.at(-1));
  const phoneTop = useRailStore((s) => s.stacks.phone.at(-1));
  const desktopId = desktopTop?.kind === 'conversation' ? desktopTop.id : null;
  const phoneId = phoneTop?.kind === 'conversation' ? phoneTop.id : null;
  useEffect(() => {
    if (!on) return;
    for (const id of new Set([desktopId, phoneId])) if (id) void syncConversation(resolveConversationId(id));
  }, [on, desktopId, phoneId]);
}
