/**
 * When the "Streaks are on" nudge may show (lib/nudges/registry.ts).
 *
 * It used to fire on the first frame of every new account, beside "Welcome to
 * dsul": a persistent toast above the first-run tour (z-index 999999999 against
 * the tour's 100) that, on a phone, covered the tour's card and its Next button,
 * talking about flames to someone with no habit to have one. So it waits:
 *
 *  - for streaks to be provably ON. `extReady` means the extensions store has
 *    answered, so it never says "turn streaks off" to someone who already did
 *    (streaksOn reads its default-true before hydration), and never at all where
 *    the extensions table is undeployed (configsLoaded stays false there);
 *  - for the tour's answer for THIS account, and for the tour to be over. The
 *    onboarding read lands after the planner load, so "no tour showing" is not
 *    an answer until it has; keyed by account because the shell survives a bare
 *    account switch;
 *  - for a habit, the only thing that has a streak.
 */
export function streakNudgeEnabled(s: {
  extReady: boolean;
  streaksOn: boolean;
  userId: string | null;
  /** The account the onboarding read last answered for (null until it has). */
  tourAnsweredFor: string | null;
  tourShowing: boolean;
  hasHabit: boolean;
}): boolean {
  return (
    s.extReady &&
    s.streaksOn &&
    !!s.userId &&
    s.tourAnsweredFor === s.userId &&
    !s.tourShowing &&
    s.hasHabit
  );
}
