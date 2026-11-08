'use client';

import Link from 'next/link';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  ResetAllShortcutsButton,
  ShortcutsPanel,
} from '@/components/settings/shortcuts-panel';
import { SHORTCUT_ONLY_CTX } from '@/lib/settings/manifest';
import { DECK_DIALOG } from '@/components/ui/deck-dialog';
import { cn } from '@/lib/utils';

/**
 * The ⌘/ shell: the shortcuts table, summoned over your work.
 *
 * It renders the SAME <ShortcutsPanel> the Keyboard settings pane renders, in
 * variant="overlay" — one record set (SHORTCUT_RECORDS, lib/settings/manifest.ts),
 * two shells, the arrangement components/shell/omni-launcher.tsx has with the
 * omnibar. This file owns only the chrome: the dialog, the title, the height
 * cap, and the way out.
 *
 * THE HEIGHT CAP IS A PLAIN `overflow-y-auto` BOX. <ScrollArea> silently drops
 * `max-h` (CLAUDE.md), and a shortcuts table that cannot scroll is a table
 * whose last section is unreachable on a laptop.
 *
 * `SHORTCUT_ONLY_CTX` is what lets a settings record render here at all: every
 * `keys` record reads and writes through the keyboard-shortcuts store and never
 * touches ctx (tests/unit/shortcut-records.test.ts proves it), so this surface
 * needs none of the theme, push and router plumbing /settings assembles.
 */
export function KeyboardShortcutsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(DECK_DIALOG.content, 'flex max-h-[80vh] flex-col sm:max-w-lg')}>
        <DialogHeader className="px-[22px] pt-[22px] pb-3 text-left">
          <DialogTitle className={DECK_DIALOG.title}>Keyboard shortcuts</DialogTitle>
          <DialogDescription className="sr-only">
            Every binding in dsul, rebindable in place.
          </DialogDescription>
        </DialogHeader>

        {/* The scrolling half, edge to edge so the rows' own hover wash reaches
            the dialog's sides instead of stopping short of them. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pb-4">
          <ShortcutsPanel variant="overlay" ctx={SHORTCUT_ONLY_CTX} />
        </div>

        {/* The deck, pinned under the scroll: reset quiet on the left, the
            way out on the right (the dialog restyle's round 2, 2026-11-07). */}
        <div data-dialog-deck className={DECK_DIALOG.deck}>
          <div className={DECK_DIALOG.deckLead}>
            <ResetAllShortcutsButton />
          </div>
          <div className="flex items-center gap-2">
            {/* The same table has a permanent address, and saying so is the
                point of the two shells: this one is summoned over your work,
                that one is a page you can link, search and bookmark. */}
            <Button variant="ghost" size="sm" asChild>
              <Link href="/settings/keyboard" onClick={() => onOpenChange(false)}>
                Open in settings
              </Link>
            </Button>
            <Button size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
