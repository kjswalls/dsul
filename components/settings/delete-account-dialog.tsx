'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ACCOUNT_COPY, accountLine, confirms, consequenceLines, doneMessage } from '@/lib/account-copy';
import {
  fetchAccountFacts,
  rememberDeletion,
  requestAccountDeletion,
} from '@/lib/account-client';
import { ACCOUNT_CONFIRM_WORD, type AccountFacts, type AppleRevocation } from '@/lib/account-types';
import { createClient } from '@/lib/supabase';
import { signedOutNav } from '@/lib/signed-out-redirect';

/**
 * Settings → dsul → Delete account (memory/plans/account-deletion.md).
 *
 * Opening it asks GET /api/account for what this account holds that dsul
 * can't delete for the person, and names the account by its email: someone
 * with two accounts sees which one is about to go. Delete stays off until the
 * facts are in and DELETE is typed (any case). The delete body carries the
 * `userId` the dialog opened with, so a browser that has switched accounts
 * under the open dialog (an email link opened in another tab) deletes nothing
 * and is told so.
 *
 * Once the delete answers 200 the outcome is written to sessionStorage FIRST
 * (`rememberDeletion`), before anything renders: another dsul tab whose refresh
 * is refused can broadcast SIGNED_OUT and replace this page at any moment, and
 * /login reads the note to say the same thing. Done, Escape and the close
 * button all sign this browser out locally; the provider's SIGNED_OUT handler
 * clears the stores and goes to /login. No `flushSettings()` first: anything
 * buffered belongs to an account that no longer exists.
 *
 * The web never revokes Sign in with Apple (it has no fresh Apple code), so an
 * Apple account always gets the web's manual line, never the phone's step line.
 */

type Phase =
  | { kind: 'loading' }
  | { kind: 'unreachable' }
  | { kind: 'ready'; facts: AccountFacts }
  | { kind: 'done'; message: string };

/** A local sign-out with nobody to tell: the provider's SIGNED_OUT goes to /login. */
function endSessionQuietly(): void {
  try {
    void createClient()
      .auth.signOut({ scope: 'local' })
      .catch(() => {});
  } catch {
    // Nothing is left to show a failure to.
  }
}

export function DeleteAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fieldId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // The line under the button after a delete that didn't go through.
  const [problem, setProblem] = useState<string | null>(null);
  // A 409: this browser is another account now, and the facts on screen are
  // not its. Delete stays off until the dialog is closed and opened again.
  const [changed, setChanged] = useState(false);
  // Each open is its own load; an answer for an earlier open is dropped.
  const loadSeq = useRef(0);
  const doneRef = useRef<HTMLButtonElement>(null);
  // The account is gone (a 200, or a 410 on open), this dialog has begun
  // signing out, and whether it is still mounted: read by the unmount below.
  const deletedRef = useRef(false);
  const leavingRef = useRef(false);
  const unmountedRef = useRef(false);

  // Signs this browser out without a logout call that matters: auth-js
  // ignores the 403 for a user that no longer exists and drops the session,
  // and SIGNED_OUT does the rest. If the sign-out itself fails, /login is
  // still the only place left to go.
  const leave = useCallback(async () => {
    leavingRef.current = true;
    setLeaving(true);
    try {
      const { error } = await createClient().auth.signOut({ scope: 'local' });
      if (error) signedOutNav.replace('/login');
    } catch {
      signedOutNav.replace('/login');
    }
  }, []);

  const finish = useCallback((apple: AppleRevocation, hadApple: boolean) => {
    rememberDeletion(apple, hadApple);
    deletedRef.current = true;
    // Gone already (Back pressed while the delete was out): nobody is left to
    // press Done, so end the session here.
    if (unmountedRef.current) {
      endSessionQuietly();
      return;
    }
    setPhase({ kind: 'done', message: doneMessage(apple, hadApple, { web: true }) });
  }, []);

  // Every way out once the account is gone ends the local session, not only
  // Done, Escape and the close button. Browser Back unmounts the page with the
  // dialog and runs no handler, and the tab would stay signed in as an account
  // that no longer exists until its token expired. The note for /login is
  // already written. StrictMode's rehearsal unmount runs before any delete, so
  // it never signs out.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (deletedRef.current && !leavingRef.current) endSessionQuietly();
    };
  }, []);

  // What the facts call came to. The phase is already 'loading'.
  const settle = useCallback(
    (result: Awaited<ReturnType<typeof fetchAccountFacts>>) => {
      if (result.ok) {
        setPhase({ kind: 'ready', facts: result.facts });
        return;
      }
      switch (result.error) {
        case 'signed_out':
          void leave();
          return;
        case 'gone':
          // An earlier delete whose answer was lost. Nothing says whether it
          // revoked anything, and the web never does.
          finish('unknown', false);
          return;
        default:
          setPhase({ kind: 'unreachable' });
      }
    },
    [finish, leave],
  );

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    void fetchAccountFacts().then((result) => {
      if (seq === loadSeq.current) settle(result);
    });
  }, [settle]);

  // Every open starts clean, reset while rendering the open rather than in an
  // effect after it, so the first frame never shows the last open's state.
  const [shownOpen, setShownOpen] = useState(false);
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      setPhase({ kind: 'loading' });
      setTyped('');
      setDeleting(false);
      setLeaving(false);
      setProblem(null);
      setChanged(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    load();
    return () => {
      // Closing drops whatever the open was still waiting on.
      loadSeq.current += 1;
    };
  }, [open, load]);

  useEffect(() => {
    if (phase.kind === 'done') doneRef.current?.focus();
  }, [phase.kind]);

  const facts = phase.kind === 'ready' ? phase.facts : null;
  const canDelete = facts !== null && confirms(typed) && !deleting && !changed;

  const remove = async () => {
    if (!facts || !canDelete) return;
    setDeleting(true);
    setProblem(null);
    const hadApple = facts.appleIds.length > 0;
    const result = await requestAccountDeletion(facts.userId);
    if (result.ok) {
      finish(result.apple, hadApple);
      setDeleting(false);
      return;
    }
    switch (result.error) {
      case 'gone':
        // Not an answer the delete route gives (a gone caller is 200
        // `unknown` there), but it means the same thing.
        finish('unknown', hadApple);
        setDeleting(false);
        return;
      case 'signed_out':
        void leave();
        return;
      case 'changed':
        setChanged(true);
        setProblem(ACCOUNT_COPY.changed);
        break;
      case 'unreachable':
        setProblem(ACCOUNT_COPY.unreachable);
        break;
      case 'failed':
        setProblem(ACCOUNT_COPY.failed);
        break;
    }
    setDeleting(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      onOpenChange(true);
      return;
    }
    // Nothing closes it mid-delete, and once the account is gone every way
    // out is Done.
    if (deleting || leaving) return;
    if (phase.kind === 'done') {
      void leave();
      return;
    }
    onOpenChange(false);
  };

  const line = facts ? accountLine(facts) : null;
  const lines = facts ? consequenceLines(facts, { appleStep: false, web: true }) : [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        // Capped and scrolled, never clipped: with every consequence line it
        // is taller than a phone, a 768px laptop or the desktop app at its
        // 600px minimum, and the buttons must stay reachable. A plain overflow
        // container, not <ScrollArea>, which ignores max-h.
        className="border-border sm:max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto"
        data-testid="delete-account-dialog"
        showCloseButton={!deleting && !leaving}
        // Reading starts at the top, not in the field Radix would pick: a
        // screen reader then meets the account line and what dsul can't
        // delete before the field, which arrive after the facts load and are
        // not part of the description. Tab still reaches the field first.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-foreground">
            {/* Once the account is gone the question is answered. */}
            {phase.kind === 'done' ? ACCOUNT_COPY.deleteLabel : ACCOUNT_COPY.title}
          </DialogTitle>
          {line && (
            <p className="text-foreground text-sm font-medium" data-testid="delete-account-account">
              {line}
            </p>
          )}
          {phase.kind !== 'done' && (
            <DialogDescription className="text-sm leading-relaxed">{ACCOUNT_COPY.lead}</DialogDescription>
          )}
        </DialogHeader>

        {phase.kind === 'done' ? (
          <div className="flex flex-col gap-4">
            {/* The dialog's description now, so it is read with the dialog. */}
            <DialogDescription asChild>
              <p role="status" className="text-foreground text-sm leading-relaxed" data-testid="delete-account-done">
                {phase.message}
              </p>
            </DialogDescription>
            <div className="flex justify-end">
              <Button
                ref={doneRef}
                size="sm"
                onClick={() => void leave()}
                disabled={leaving}
                data-testid="delete-account-done-button"
              >
                {ACCOUNT_COPY.doneLabel}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void remove();
            }}
          >
            {phase.kind === 'loading' && (
              <div role="status" className="text-muted-foreground flex items-center" aria-busy="true">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                <span className="sr-only">Loading…</span>
              </div>
            )}

            {phase.kind === 'unreachable' && (
              <div className="flex flex-col items-start gap-2">
                <p role="alert" className="text-destructive text-sm" data-testid="delete-account-error">
                  {ACCOUNT_COPY.unreachable}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPhase({ kind: 'loading' });
                    load();
                  }}
                >
                  Try again
                </Button>
              </div>
            )}

            {lines.length > 0 && (
              <ul className="text-foreground flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed">
                {lines.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor={fieldId} className="text-sm font-medium">
                {ACCOUNT_COPY.confirmLabel}
              </label>
              <Input
                id={fieldId}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={ACCOUNT_CONFIRM_WORD}
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                disabled={deleting}
                data-testid="delete-account-confirm"
                className="text-sm"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleOpenChange(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                disabled={!canDelete}
                data-testid="delete-account-submit"
              >
                {deleting ? ACCOUNT_COPY.deletingLabel : ACCOUNT_COPY.deleteLabel}
              </Button>
            </div>

            {problem && (
              <p role="alert" className="text-destructive text-sm" data-testid="delete-account-error">
                {problem}
              </p>
            )}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
