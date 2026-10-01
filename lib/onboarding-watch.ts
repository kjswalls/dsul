import { selectPlannerSettled } from '@/lib/planner-ready';

type LoadState = { userId: string | null; isLoading: boolean };

/**
 * Fires ONE onboarding read per (mount, sign-in), after the planner load has
 * settled (ok or failed), and reports BOTH answers.
 *
 * It used to be a `getUser()` + read in AppShell's mount effect, which put an
 * auth round trip and a user_settings read into the cold-start burst. The
 * account is already on planner-store (identifyUser), so waiting for the load
 * to settle costs no request of its own and moves the read out of the burst.
 *
 * BOTH OUTCOMES, NOT ONLY "needed". ui-store is a module singleton and AppShell
 * can stay mounted across an A→B switch, so an answer that could only turn the
 * tour ON would leave B holding A's tour (and OnboardingChat marking completion
 * against A). `onResult(uid, false)` is what turns it off — and it is safe only
 * because it fires once per (mount, sign-in): the first answer for a newly
 * identified account cannot stomp a tour that same account is in the middle of.
 * Re-running the check for the same user (say, on each retry) would. Across a
 * REMOUNT it is not safe on its own — a fresh watcher has no memory — which is
 * why the chat flag is lowered through ui-store's applyChatOnboardingAnswer,
 * which never lowers the answering account's own flag.
 *
 * A REJECTING read is treated as "done", fail-closed like lib/user-profile.ts:
 * a tour nobody can complete is worse than one that does not appear.
 *
 * Relies on AppShell only rendering on a needs-items route (app/page.tsx,
 * lib/route-data.ts): a lean route never clears isLoading after identifyUser,
 * so mounted there this never fires. See lib/planner-ready.ts.
 */
export function watchOnboardingAfterLoad(opts: {
  getState: () => LoadState;
  subscribe: (fn: (s: LoadState) => void) => () => void;
  isComplete: (userId: string) => Promise<boolean>;
  onResult: (userId: string, needed: boolean) => void;
}): () => void {
  let checkedFor: string | null = null;
  let disposed = false;
  const run = (s: LoadState) => {
    // A sign-out releases the latch, so the NEXT identification — the same
    // account included — gets its own read. Without this, A → signed out → A
    // in a still-mounted AppShell never re-checks, and the provider's
    // sign-out clear of Beacon's first-run flag is never undone.
    if (!s.userId) {
      checkedFor = null;
      return;
    }
    if (!selectPlannerSettled(s) || checkedFor === s.userId) return;
    const uid = s.userId as string;
    checkedFor = uid;
    opts
      .isComplete(uid)
      .catch(() => true)
      .then((done) => {
        // A late answer for an account that is no longer current is dropped;
        // the new account gets its own read through the subscription.
        if (disposed || opts.getState().userId !== uid) return;
        opts.onResult(uid, !done);
      });
  };
  run(opts.getState());
  const unsub = opts.subscribe(run);
  return () => {
    disposed = true;
    unsub();
  };
}
