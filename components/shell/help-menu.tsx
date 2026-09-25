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
 * The floating "?" help hub — desktop only, bottom-right corner.
 *
 * One affordance that gathers the scattered help entry points into the spot the
 * bare shortcuts hint used to sit. Every row is an ordinary `ActiveDialog`
 * variant, so each is just an `openDialog` call. A row lands here only once it
 * points somewhere real — a menu whose items dead-end reads as more broken than
 * no menu at all — so Changelog / Guides / Support wait until they exist.
 *
 * Inset 24px so the whole bubble, focus ring included, clears the body panel's
 * rounded corner: the shell's p-3 gutter plus the panel's 30px radius puts the
 * corner arc's centre 42px in, and a 36px bubble at 24px shares that centre.
 */
export function HelpMenu() {
  const openDialog = useUIStore((s) => s.openDialog);

  return (
    <div className="fixed bottom-6 right-6 z-30 hidden md:block">
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
