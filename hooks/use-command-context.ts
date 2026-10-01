'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { usePlannerStore } from '@/lib/planner-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { revealDock } from '@/lib/look-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { saveSettings } from '@/lib/settings-service';
import { applyThemeChange } from '@/lib/theme-transition';
import { useIsMobile } from '@/hooks/use-mobile';
import type { CommandContext } from '@/lib/commands';

/**
 * Builds the CommandContext — the handful of capabilities a command can't
 * reach on its own via `someStore.getState()`.
 *
 * @param overrides.openChat where "Ask Beacon" should land. The mobile dock
 *   passes its own so the omnibar keeps behaving the way it does today.
 */
export function useCommandContext(overrides?: { openChat?: () => void }): CommandContext {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const userId = usePlannerStore((s) => s.userId);
  const isMobile = useIsMobile();
  const router = useRouter();
  const openChatOverride = overrides?.openChat;

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
          if (isMobile) {
            useMobileNavStore.getState().setActiveTab('chat');
            return;
          }
          // ChatPanel mounts inside SidebarDock, which lives in a w-0
          // overflow-hidden container while the sidebar is collapsed — so
          // expanding chat alone expands a panel nobody can see.
          revealDock();
          useSidebarStore.getState().setChatExpanded(true);
        }),
      userId,
      isMobile,
      navigate: (href: string) => router.push(href),
    }),
    [theme, resolvedTheme, setTheme, userId, isMobile, openChatOverride, router]
  );
}
