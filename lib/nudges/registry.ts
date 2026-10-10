import { Flame, Sunrise, type LucideIcon } from 'lucide-react';

/**
 * One-time nudges — a tiny declarative catalog, the same bargain the extension
 * registry makes: a nudge is a row here plus a mount, never a new code path.
 *
 * A "nudge" is a single orientation message shown to a user ONCE and never
 * again: first-run copy that points out a feature or a setting, not a recurring
 * reminder and not an error. Dismissal is stored server-side (a per-user set,
 * migration 043), so "never again" spans devices and survives a reload.
 *
 * The id is permanent: it is the dismissed-set key AND the persisted value, so
 * renaming one un-dismisses it for everyone who had. Add, never rename — the
 * same rule the extension slugs live under.
 */
export const NUDGE_STREAKS_ON = 'streaks-on';
export const NUDGE_RITUALS_INTRO = 'rituals-intro';
/**
 * The item panel's "Break it down" offer while AI is not set up (AI setup
 * phase 2, lib/item-asks.ts `canOfferBreakDown`). Not a toast, so it has no
 * row in NUDGES: it is the ✕ beside the offer, and closing it once hides the
 * offer on every item and every device. Setting AI up shows the real button
 * whatever this says.
 */
export const NUDGE_BREAK_IT_DOWN_OFFER = 'break-it-down-offer';

export interface NudgeDef {
  /** Permanent id — the dismissed-set key and the stored value. Slug-shaped. */
  id: string;
  title: string;
  body: string;
  icon?: LucideIcon;
  /** CTA button label; omit for a dismiss-only nudge. */
  ctaLabel?: string;
  /**
   * A settings record id the CTA deep-links to via /settings?focus=<id>, which
   * self-routes to whichever pane holds the row (lib/settings/manifest.ts). Omit
   * for a nudge whose CTA does something other than open a setting.
   */
  settingsFocusId?: string;
}

export const NUDGES: NudgeDef[] = [
  {
    id: NUDGE_STREAKS_ON,
    title: 'Streaks are on',
    // The whole reason this nudge exists is the guilt a broken chain can carry,
    // so it names the escape hatch and, in the same breath, promises the counter
    // keeps running — turning streaks off is a display choice, not a reset.
    body: "Flames and streak counts show across the app. If they feel more like pressure than motivation, you can turn them off in Settings. Your streaks keep counting either way.",
    icon: Flame,
    ctaLabel: 'Streak settings',
    settingsFocusId: 'extensions.streaks',
  },
  {
    id: NUDGE_RITUALS_INTRO,
    // Issue #86. Both rituals are opt-in for a new account (migration 054), so
    // without this nobody learns they exist. The nudge only points at them:
    // the CTA opens the Rituals pane and turns nothing on, and the body says so.
    title: 'Two quiet rituals, if you want them',
    body: 'A morning line when something is still waiting from an earlier day, and a short review before the day closes. Both stay off unless you turn them on.',
    icon: Sunrise,
    ctaLabel: 'Rituals settings',
    settingsFocusId: 'rituals.morningCheck',
  },
];

/**
 * When the rituals nudge may fire (issue #86): once the account has something
 * planned, after the first-run tour has had its say, and only while BOTH
 * rituals are off. Settings must be this account's (settingsBelongToUser), or a
 * shared browser's previous values could hide it, or show it to someone who
 * already turned a ritual on. The tour gate waits for the tour's ANSWER, not
 * just its absence, so the toast never lands on top of a tour about to open.
 *
 * `setupOrUndoUp` holds it while the tour's last card has left something on
 * screen: AI setup (the setup column, or the phone's setup page under the Ask
 * tab), the "It works." a connect there ends on, or an undo row (No AI's, whose
 * focused Undo the desktop toaster would cover). After Set up AI there is no
 * toast, and this keeps that true until the person moves on. The shell reads
 * the three (components/shell/app-shell.tsx FirstRunNudges); this only says
 * that any one of them holds the intro.
 */
export function ritualsNudgeReady(s: {
  settingsHydrated: boolean;
  tourAnswered: boolean;
  tourShowing: boolean;
  hasTasks: boolean;
  morningCheckEnabled: boolean;
  eodReviewEnabled: boolean;
  setupOrUndoUp: boolean;
}): boolean {
  return (
    s.settingsHydrated &&
    s.tourAnswered &&
    !s.tourShowing &&
    s.hasTasks &&
    !s.morningCheckEnabled &&
    !s.eodReviewEnabled &&
    !s.setupOrUndoUp
  );
}

export function nudgeDef(id: string): NudgeDef | undefined {
  return NUDGES.find((nudge) => nudge.id === id);
}
