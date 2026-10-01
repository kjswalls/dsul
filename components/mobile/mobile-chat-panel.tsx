'use client';

import type { ReactNode } from 'react';
import { ChatConversation } from '@/components/ai/chat-conversation';
import { ProposalCard } from '@/components/ai/proposal-card';
import { SurfaceHeader } from '@/components/primitives/surface-header';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { chatAssistantLabel } from '@/lib/chat-utils';

interface MobileChatPanelProps {
  onOpenSettings?: () => void;
  /** The user menu. This tab's capsule is the only header it has to put it in. */
  headerAccessory?: ReactNode;
}

/**
 * Mobile chat tab — the dateless header capsule over the shared
 * ChatConversation (lib/chat-store.ts), both sitting on the paper backdrop.
 *
 * The composer is NOT here. Per design/mobile-redesign/ChatTab.dc.html the
 * dock's bar is the chat input, so this passes `hideComposer` and the dock
 * mounts a `<ChatComposer variant="dock">` in the row the omnibar vacates —
 * which is also what closes the empty well phase 2 left on this tab. The focus
 * signal went with it: the field it was aiming at is down there now.
 */
export function MobileChatPanel({ onOpenSettings, headerAccessory }: MobileChatPanelProps) {
  // Named after whoever EFFECTIVELY answers, not the device's stored choice:
  // the gate falls back to whatever else is connected.
  const { target, agentId } = useAICapabilities();

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* Which agent is answering was a bordered strip inside the conversation
          (ChatConversation's own header); it is the capsule's title now, so the
          tab opens with one header rather than a header under a header. */}
      <SurfaceHeader title={chatAssistantLabel(target, agentId)} className="mx-[10px]">
        {headerAccessory}
      </SurfaceHeader>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ProposalCard className="mx-[10px] shrink-0" />
        {/* cardedReplies: with the panel gone the conversation sits on the
            paper, and the card is what separates a reply from it
            (design/mobile-redesign/ChatTab.dc.html). */}
        <ChatConversation
          variant="mobile"
          hideHeader
          hideComposer
          cardedReplies
          onOpenSettings={onOpenSettings}
        />
      </div>
    </div>
  );
}
