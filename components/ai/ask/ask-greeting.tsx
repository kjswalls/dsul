'use client';

import { Sparkles } from 'lucide-react';
import { greeting } from '@/lib/ask-home';
import { usePlannerStore } from '@/lib/planner-store';
import { useSessionUserStore } from '@/lib/session-user-store';
import { useNowMinutes } from '@/lib/use-now-minutes';
import { cn } from '@/lib/utils';

/**
 * "Morning, Kirby." The greeting, in the serif, by the user's clock and the
 * first word of their display name (lib/ask-home.ts `greeting`).
 *
 *  - home      Ask home, 15px with a period, and no spark: the AI's mark
 *              (components/ai/ask-mark.tsx) leads the header one line above.
 *  - new-chat  a new chat's empty state, 24px, no period, under the ✦ on a line
 *              of its own, centred (components/ai/ask/new-chat-empty.tsx).
 *
 * The clock is the grid's now-marker clock, aligned to the minute, so it turns
 * from morning to afternoon at noon on its own. `data-ask-greeting` lets a
 * layout with a typeface of its own draw it in that face instead of the serif
 * (app/globals.css, beside the layout type rules): Notepad is your day as plain
 * text, and a serif line would be the one thing on screen that is not.
 */
export function AskGreeting({
  variant,
  spark = variant === 'new-chat',
  className,
}: {
  variant: 'home' | 'new-chat';
  spark?: boolean;
  className?: string;
}) {
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const minutes = useNowMinutes(userTimezone ?? undefined);
  const name = useSessionUserStore((s) => s.user?.displayName ?? null);
  const text = greeting(minutes, name);
  const home = variant === 'home';

  return (
    <p
      data-ask-greeting={variant}
      className={cn(
        'flex items-center font-serif text-foreground',
        // 24px exactly: this theme's text-2xl is 22px (app/globals.css).
        home ? 'gap-1.5 text-[15px] leading-snug' : 'flex-col gap-2.5 text-center text-[24px] leading-tight',
        className
      )}
    >
      {spark && <Sparkles className={cn('shrink-0 text-ai', home ? 'size-4' : 'size-6')} aria-hidden />}
      <span className="min-w-0">{home ? `${text}.` : text}</span>
    </p>
  );
}
