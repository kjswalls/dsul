import { eodLinkDay } from '@/lib/eod';
import { useEODStore } from '@/lib/eod-store';
import { selectPlannerSettled } from '@/lib/planner-ready';

type LoadState = { userId: string | null; isLoading: boolean };

/**
 * Open the review a `?eod=` deep link asks for, once the planner's load for
 * this account has landed, and then take the link off the address bar.
 *
 * The review's push lands here: the reminder scan sends `/?eod=<yyyy-MM-dd>`,
 * the day it invites a review of, and that day is what Done records the
 * review against (lib/eod.ts's reviewedDay), so a push tapped after midnight
 * is not filed under the new day. Dropped on the way in, the 6th's push
 * finished at 00:15 would stamp the 7th and retire the 7th's invitation
 * before it was sent. The bare `?eod=1` that pushes sent before 2026-10-06
 * still opens the review, naming no day; anything else is no review link, and
 * is left where it is.
 *
 * Out of AppShell's mount effect, like lib/onboarding-watch.ts, so the step
 * from URL to store can be asked about without mounting the shell.
 *
 * `!isLoading` alone is NOT "loaded": the store initialises with
 * isLoading:false, and AppShell's effect runs before the load even starts
 * (initializeStore is called from SupabaseProvider, a PARENT, and React runs
 * child effects first). So the fast path used to fire against an EMPTY store,
 * and EODReview snapshots its pending list once on the isOpen transition and
 * never re-snapshots, leaving a permanently empty review for anyone who
 * arrived by tapping the push notification. selectPlannerSettled waits for
 * `userId` too, which is set in the same set() as isLoading:true.
 *
 * @param search `window.location.search`.
 * @returns the cleanup for the effect that calls it.
 */
export function openReviewFromLink(
  search: string,
  opts: {
    getState: () => LoadState;
    subscribe: (fn: (s: LoadState) => void) => () => void;
    /** Takes the link off the address bar, so a reload does not reopen it. */
    clearLink: () => void;
  }
): () => void {
  const eod = new URLSearchParams(search).get('eod');
  if (eod === null) return () => {};
  const invitedFor = eodLinkDay(eod);
  if (eod !== '1' && invitedFor === null) return () => {};

  const openAndClear = () => {
    const eodStore = useEODStore.getState();
    if (invitedFor) eodStore.openInvited(invitedFor);
    else eodStore.open();
    opts.clearLink();
  };

  if (selectPlannerSettled(opts.getState())) {
    openAndClear();
    return () => {};
  }
  const unsub = opts.subscribe((state) => {
    if (selectPlannerSettled(state)) {
      unsub();
      openAndClear();
    }
  });
  return unsub;
}
