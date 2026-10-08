'use client';

import { useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useUIStore } from '@/lib/ui-store';

/**
 * The one confirm prompt for the whole app, driven by ui-store.confirm().
 * Mounted once in AppShell; replaces the per-feature AlertDialog copies.
 *
 * BEING SHARED IS WHY FOCUS NEEDS HANDLING HERE. Radix restores focus on close
 * by running `event.preventDefault(); trigger?.focus()` — correct for the
 * `<AlertDialogTrigger>` it was designed around, and a no-op for this dialog,
 * which has no trigger at all: the opener is any button anywhere that happens to
 * call `confirm()`. The preventDefault still lands, cancelling FocusScope's own
 * restore, so dismissing a confirm dropped the cursor on `<body>` and ended the
 * keyboard session — Tab resumed from the top of the document. It affected every
 * confirm in the app, and reading a delete prompt and deciding NOT to is the
 * ordinary case.
 *
 * THE LAST REQUEST OUTLIVES ITS ANSWER. `resolveConfirm` clears the request
 * before the dialog's 200ms exit animation runs, so the closing dialog read
 * "Confirm" over a blank title, and the close below had nothing to ask where
 * focus should go. The request on screen is kept (state, derived during
 * render) until the close has run.
 */
export function ConfirmDialog() {
  const confirmRequest = useUIStore((s) => s.confirmRequest);
  const resolveConfirm = useUIStore((s) => s.resolveConfirm);
  const returnTo = useRef<HTMLElement | null>(null);
  const [last, setLast] = useState(confirmRequest);
  if (confirmRequest && confirmRequest !== last) setLast(confirmRequest);
  const shown = confirmRequest ?? last;

  return (
    <AlertDialog open={!!confirmRequest} onOpenChange={(open) => !open && resolveConfirm(false)}>
      <AlertDialogContent
        data-testid="confirm-dialog"
        // Captured HERE rather than in an effect or during render: FocusScope
        // dispatches this before it moves focus, so `activeElement` is still the
        // control the user pressed. An effect runs after that move and would
        // capture the Cancel button — this dialog's own.
        //
        // Not prevented, so AlertDialog's own handler still runs and Cancel
        // takes focus, which is the destructive-prompt default worth keeping.
        onOpenAutoFocus={() => {
          returnTo.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(event) => {
          const target = returnTo.current;
          const closed = last;
          // Released either way, so a confirmed delete cannot pin the detail
          // pane's removed subtree in memory behind this ref (nor the closed
          // request's callbacks behind `last`).
          returnTo.current = null;
          setLast(null);
          // `isConnected` costs one property read and is skipped rather than
          // "guarded against": confirming a delete unmounts the control that
          // opened it, and both branches then land focus in the same place —
          // preventing the default and focusing a detached node is a no-op, and
          // so is Radix's own `trigger?.focus()` on a dialog with no trigger.
          // Verified by measuring `document.activeElement` both ways. It is here
          // to keep this handler's contract readable, not for an effect.
          //
          // Gone, the request's own `fallbackFocus` answers instead: it runs
          // here, after the exit animation, the first moment focus is really
          // lost (until then it sits on this dialog's button, still connected).
          if (!target?.isConnected) {
            const fallback = closed?.fallbackFocus;
            if (!fallback) return;
            event.preventDefault();
            fallback();
            return;
          }
          event.preventDefault();
          target.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{shown?.title}</AlertDialogTitle>
          <AlertDialogDescription>{shown?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="confirm-dialog-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction
            // The confirm LABEL is caller-supplied ('Delete', 'Reset streak',
            // 'Confirm'), and 'Delete' collides with three other buttons in the
            // app. This id says which dialog, not which verb.
            data-testid={shown?.testId ?? 'confirm-dialog-confirm'}
            variant={shown?.destructive ? 'destructive' : 'default'}
            onClick={() => resolveConfirm(true)}
          >
            {shown?.confirmLabel ?? 'Confirm'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
