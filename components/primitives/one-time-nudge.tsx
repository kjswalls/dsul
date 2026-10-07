'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useOneTimeNudge } from '@/hooks/use-one-time-nudge';
import { nudgeDef } from '@/lib/nudges/registry';

/**
 * Renders one one-time nudge as a persistent sonner toast — shown the first time
 * it goes `active` for this account, gone forever once the user closes it or
 * follows its CTA. Renders nothing itself (returns null).
 *
 * `enabled` is a caller precondition ON TOP of "not yet dismissed": the streak
 * nudge only makes sense while streaks are actually on. While it is false the
 * toast never fires and nothing is recorded, so the nudge is still waiting the
 * day the precondition becomes true.
 *
 * Reusable: add a NudgeDef to lib/nudges/registry.ts and mount one of these on a
 * durable surface (the app shell). The toast is keyed by the nudge id, so a
 * double-invoked effect (React StrictMode in dev) updates the one toast rather
 * than stacking a duplicate.
 */
export function OneTimeNudge({ id, enabled = true }: { id: string; enabled?: boolean }) {
  const router = useRouter();
  const { active, dismiss, userId } = useOneTimeNudge(id);
  // Fire-once latch keyed by ACCOUNT, not a bare boolean: this component lives on
  // the durable shell, which survives a bare account switch (SIGNED_IN with no
  // reload), so a boolean latch would stay latched and the next user would never
  // see their nudge. Keyed on userId, it re-arms the moment the account changes.
  const firedForUser = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !active) return;
    if (firedForUser.current === userId) return;
    const def = nudgeDef(id);
    if (!def) return;
    firedForUser.current = userId;

    toast(def.title, {
      id: def.id,
      description: def.body,
      duration: Infinity,
      action: def.settingsFocusId
        ? {
            label: def.ctaLabel ?? 'Open settings',
            onClick: () => {
              router.push(`/settings?focus=${encodeURIComponent(def.settingsFocusId!)}`);
              dismiss();
            },
          }
        : undefined,
      // Fires on the close button / swipe. Following the CTA already calls
      // dismiss(); calling it twice is a no-op, so either exit records the nudge.
      onDismiss: () => dismiss(),
    });
  }, [enabled, active, id, userId, dismiss, router]);

  // A toast fired for one account comes down when the account changes. Left
  // up, its close button would record the dismissal for the account that
  // fired it, against whoever is signed in now. A programmatic dismiss calls
  // no onDismiss, so nothing is recorded; the latch is released so the toast
  // can fire again for whichever account is next. Declared after the effect
  // above so a switch that fires the next account's toast (same id) lands
  // first and leaves nothing to take down.
  useEffect(() => {
    if (firedForUser.current === null || firedForUser.current === userId) return;
    toast.dismiss(id);
    firedForUser.current = null;
  }, [userId, id]);

  return null;
}
