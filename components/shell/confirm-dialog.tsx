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
import { Undo2 } from 'lucide-react';
import { useUIStore, type ConfirmPreview } from '@/lib/ui-store';

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
          {/* With a preview the row says what is going and the deck says
              where, so the full sentence stays only for screen readers. */}
          <AlertDialogDescription className={shown?.preview ? 'sr-only' : undefined}>
            {shown?.description}
          </AlertDialogDescription>
          {shown?.preview && <ConfirmItemRow preview={shown.preview} />}
        </AlertDialogHeader>
        <AlertDialogFooter>
          {shown?.preview && <ConfirmDeckNote note={shown.preview.note} />}
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

/**
 * The item a confirm acts on, drawn as it sits on the planner: the box, the
 * title, the day or tally (Kirby's "item in hand", 2026-11-07). A picture, not
 * a control, so it is hidden from screen readers, which hear the description.
 */
export function ConfirmItemRow({ preview }: { preview: Pick<ConfirmPreview, 'title' | 'meta'> }) {
  return (
    <div
      aria-hidden="true"
      data-testid="confirm-dialog-item"
      className="bg-secondary flex min-w-0 items-center gap-2.5 rounded-[10px] border px-3 py-2.5"
    >
      <span className="border-muted-foreground/50 size-4 flex-none rounded-[5px] border-[1.5px]" />
      <span className="text-foreground min-w-0 flex-1 truncate text-sm">{preview.title}</span>
      {preview.meta && (
        <span className="text-muted-foreground flex-none text-xs whitespace-nowrap tabular-nums">
          {preview.meta}
        </span>
      )}
    </div>
  );
}

/** The deck's left side on an item confirm: where the item goes. */
export function ConfirmDeckNote({ note }: { note: string }) {
  return (
    <span
      aria-hidden="true"
      className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs max-sm:justify-center sm:mr-auto"
    >
      <Undo2 className="size-3.5 flex-none" />
      {note}
    </span>
  );
}
