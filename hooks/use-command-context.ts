'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { usePlannerStore } from '@/lib/planner-store';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { revealChat } from '@/lib/open-chat';
import { saveSettings } from '@/lib/settings-service';
import { applyThemeChange } from '@/lib/theme-transition';
import { useIsMobile } from '@/hooks/use-mobile';
import type { CommandContext } from '@/lib/commands';

/**
 * Builds the CommandContext — the handful of capabilities a command can't
 * reach on its own via `someStore.getState()`.
 *
 * @param overrides.openChat where "Ask AI" should land. The mobile dock
 *   passes its own so the omnibar keeps behaving the way it does today. The
 *   default is `revealChat` (lib/open-chat.ts), which opens nothing while the
 *   AI gate says nothing can answer.
 */
export function useCommandContext(overrides?: { openChat?: () => void }): CommandContext {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const userId = usePlannerStore((s) => s.userId);
  const isMobile = useIsMobile();
  const router = useRouter();
  const openChatOverride = overrides?.openChat;
  // Read here, and not only inside the commands, so the context changes
  // identity when the gate flips. The palette's AI rows decide `hidden` /
  // `availableWhen` off the store (CommandContext is deliberately not
  // widened), and every list memoised on `ctx` must recompute when the answer
  // arrives, or the palette keeps showing the rows from before it.
  const { canChat } = useAICapabilities();

  return useMemo<CommandContext>(
    () => ({
      theme: {
        resolved: resolvedTheme === 'dark' ? 'dark' : 'light',
        value: theme,
        set: (next) => {
          // Wrapped so the swap eases instead of snapping — see
          // lib/theme-transition.ts for why that is not next-themes' job.
          applyThemeChange(() => setTheme(next));
          // setTheme is localStorage-only. Settings hydrate from Supabase on
          // login (components/providers/supabase-provider.tsx), so without
          // this the choice is reverted on the next sign-in.
          if (userId) saveSettings(userId, { theme: next });
        },
      },
      openChat:
        openChatOverride ??
        (() => {
          // revealChat re-reads the gate itself; this is the render's view of
          // it, so a stale closure can only ever open less, never more. It
          // opens the sidebar too on desktop: ChatPanel mounts inside
          // SidebarDock, which lives in a w-0 overflow-hidden container while
          // the sidebar is collapsed.
          if (canChat) revealChat(isMobile);
        }),
      userId,
      isMobile,
      navigate: (href: string) => router.push(href),
    }),
    [theme, resolvedTheme, setTheme, userId, isMobile, openChatOverride, router, canChat]
  );
}
