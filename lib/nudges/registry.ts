import { Flame, type LucideIcon } from 'lucide-react';

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
];

export function nudgeDef(id: string): NudgeDef | undefined {
  return NUDGES.find((nudge) => nudge.id === id);
}
