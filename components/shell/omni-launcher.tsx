'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Omnibar, launcherDescription } from '@/components/sidebar/omnibar';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { useUIStore } from '@/lib/ui-store';

/**
 * The ⌘K launcher shell: a summoned, centered command + search modal. It hosts
 * the very same <Omnibar> the sidebar dock renders, in variant="launcher" — one
 * core, two shells (see components/sidebar/omnibar.tsx).
 *
 * Opened via the `launcher` ActiveDialog variant (⌘K → the registry's
 * `workspace.focusOmnibar` command on desktop); closed by Escape, the scrim, or
 * — once wired — running an action. The content is deliberately transparent and
 * unpadded so the omnibar's own card is the visible surface rather than a
 * box-in-a-box; DialogContent supplies only the centered position, the scrim,
 * and the focus trap.
 */
export function OmniLauncher() {
  const isOpen = useUIStore((s) => s.activeDialog?.type === 'launcher');
  // Seed for a pre-scoped summon (the `/` binding opens it in command mode).
  const initialQuery = useUIStore((s) =>
    s.activeDialog?.type === 'launcher' ? s.activeDialog.query : undefined,
  );
  const closeDialog = useUIStore((s) => s.closeDialog);
  // The screen-reader line says what the omnibar's placeholder says, so it can
  // only offer to ask when something will answer.
  const { canChat, answererName } = useAICapabilities();

  return (
    <Dialog open={isOpen} onOpenChange={(next) => !next && closeDialog()}>
      <DialogContent
        showCloseButton={false}
        // Escape is staged by the omnibar (clear the argument chip → clear a
        // typed query → close). Radix's DismissableLayer runs its Escape handler
        // in the document CAPTURE phase, before the omnibar input's bubble-phase
        // onKeyDown, and would otherwise dismiss on the FIRST press. preventDefault
        // here makes DismissableLayer skip its onDismiss (it guards on
        // !defaultPrevented), handing Escape to the omnibar, which closes via
        // ui-store when there's nothing left to clear.
        onEscapeKeyDown={(e) => e.preventDefault()}
        // Anchor the bar's top a little above centre so the whole bar + panel
        // ASSEMBLY reads balanced — the panel drops below and its optical centre
        // lands ~mid-viewport (overrides DialogContent's own centering). The
        // omnibar supplies the card surface, so the content stays transparent.
        className="top-[22%] translate-y-0 gap-0 border-0 bg-transparent p-0 shadow-none sm:max-w-xl"
        data-testid="omni-launcher"
      >
        {/* Radix requires a labelled title + description for the dialog; the
            omnibar is the real UI, so both are screen-reader-only. */}
        <DialogTitle className="sr-only">Command launcher</DialogTitle>
        <DialogDescription className="sr-only">
          {`${launcherDescription(canChat, answererName)}.`}
        </DialogDescription>
        {/* Render the omnibar only while open so it MOUNTS FRESH each summon —
            its focus + resting-panel effect keys off mount, and this guarantees
            a fresh mount independent of Radix's content mount/unmount timing. */}
        {isOpen && <Omnibar variant="launcher" initialQuery={initialQuery} />}
      </DialogContent>
    </Dialog>
  );
}
