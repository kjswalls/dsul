'use client';

import { useState, useEffect } from 'react';
import { CircleHelp, Keyboard as KeyboardIcon, MessageSquarePlus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useUIStore } from '@/lib/ui-store';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { formatKeys } from '@/lib/commands/keys';
import { cn } from '@/lib/utils';

/**
 * The live binding printed beside "Keyboard shortcuts".
 *
 * Reads the LIVE binding rather than printing '⌘ + /': `system_shortcuts` is
 * rebindable like every other shortcut, and a hardcoded hint quietly starts
 * lying the moment someone moves the one binding it exists to advertise.
 */
function KbdHint() {
  const [isMac, setIsMac] = useState(false);
  const keys = useShortcutKeys('system_shortcuts');
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad|iPod/.test(navigator.platform));
  }, []);
  return <>{formatKeys(keys, isMac).join(' + ')}</>;
}

/**
 * The floating "?" help hub — desktop only, the canvas's bottom-right corner.
 *
 * One affordance that gathers the scattered help entry points into the spot the
 * bare shortcuts hint used to sit. Every row is an ordinary `ActiveDialog`
 * variant, so each is just an `openDialog` call. A row lands here only once it
 * points somewhere real — a menu whose items dead-end reads as more broken than
 * no menu at all — so Changelog / Guides / Support wait until they exist.
 *
 * Placed by its one mount, DesktopShell, which puts it INSIDE <main>
 * (`absolute bottom-2.5 right-2.5`) rather than fixed to the window: the right
 * rail rests at the window's right edge now, and a window-fixed bubble would
 * sit on Ask's box. Inside <main> it also goes inert with the canvas under an
 * overlaid rail, and it does not exist in Zen, which replaces the shell.
 *
 * 10px is the inset at which it covers nothing in the day's right gutter: the
 * views' scrollbar track is <main>'s outer 10px (scroll-area.tsx's w-2.5) and
 * the nearest control, a bucket's item card, starts 46px in (the canvas's 2rem
 * padding plus the bucket's own inset), so a 36px bubble fills exactly the
 * strip between them, at every canvas width. A list row or schedule block
 * runs to the 2rem edge and can pass under it mid-scroll; every day view ends
 * in pb-20 (80px), so the last row always scrolls clear. In Classic's 30px-
 * radius corner the bubble's centre sits 2px off the arc's centre, so the
 * whole bubble, focus ring included, stays inside the curve.
 */
export function HelpMenu({ className }: { className?: string }) {
  const openDialog = useUIStore((s) => s.openDialog);

  return (
    <div className={cn('hidden md:block', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Help"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-soft-sm transition-colors hover:border-primary/50 hover:text-foreground"
          >
            <CircleHelp className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-56">
          <DropdownMenuItem
            onClick={() => openDialog({ type: 'keyboard-shortcuts' })}
            className="cursor-pointer"
          >
            <KeyboardIcon className="mr-2 h-4 w-4" />
            <span>Keyboard shortcuts</span>
            <DropdownMenuShortcut>
              <KbdHint />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => openDialog({ type: 'bug-report' })}
            className="cursor-pointer"
          >
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            <span>Send feedback</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
