'use client';

import { Laptop, Monitor, Smartphone, TabletSmartphone } from 'lucide-react';

import { useInDesktopApp } from '@/components/ai/connect/connect-shared';
import { cn } from '@/lib/utils';

/**
 * Where a setting in Settings → AI lives: the account ("All your devices") or
 * this device ("This browser only"). Drawn beside a label or a heading, never
 * inside a row's control column.
 *
 * An outline rectangle with 5px corners, as the frames draw it, so it never
 * reads as the fully rounded status pill beside it. It never breaks inside its
 * outline (`whitespace-nowrap`) and never shrinks (`shrink-0`): on a phone the
 * label line wraps instead, and the chip drops under the label whole.
 *
 * The device glyph is a monitor on a desktop and a phone below `md`, swapped
 * in CSS (never by `useIsMobile`, which reads false on a phone's first frame).
 * The desktop app is at least 900px wide, so it never takes the phone glyph;
 * it draws a laptop, and keeps the words.
 */
export function ScopeChip({ scope, className }: { scope: 'account' | 'device'; className?: string }) {
  const inDesktopApp = useInDesktopApp();
  return (
    <span
      data-testid="scope-chip"
      data-scope={scope}
      className={cn(
        'border-border text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-[5px] border px-1.5 py-px text-[11px] whitespace-nowrap',
        className
      )}
    >
      {scope === 'account' ? (
        <TabletSmartphone data-glyph="tablet-smartphone" className="size-3" aria-hidden />
      ) : inDesktopApp ? (
        <Laptop data-glyph="laptop" className="size-3" aria-hidden />
      ) : (
        <>
          <Monitor data-glyph="monitor" className="hidden size-3 md:block" aria-hidden />
          <Smartphone data-glyph="smartphone" className="size-3 md:hidden" aria-hidden />
        </>
      )}
      {scope === 'account' ? 'All your devices' : 'This browser only'}
    </span>
  );
}
