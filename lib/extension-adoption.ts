/**
 * Adoption figures for the extensions store — the arithmetic, kept pure.
 *
 * The database answers with COUNTS per slug (extension_adoption(), migration
 * 051). This turns them into the two fractions a card may show, and it is the
 * only place that decides whether a figure is safe to show at all:
 *
 *   hasItOn    share of people with the extension on. Accounts without a saved
 *              row are on the manifest default, which only the app knows — so
 *              for a default-on extension they count as ON.
 *   keptOn30d  of the people who switched it on at least 30 days ago, the share
 *              who still had it on 30 days later. Never for a default-on
 *              extension: most of its users never flipped anything, so there is
 *              no "switched on" moment to measure from.
 *
 * Privacy: a figure is withheld (null) unless it rests on at least
 * MIN_PEOPLE people AND both sides of the split hold at least MIN_SIDE —
 * "5% of 20 people" would otherwise name one account's choice. Shown values are
 * rounded to the nearest 5% for the same reason. This module runs on the
 * server (the route) and its output is all that reaches a browser.
 */

import { OFFICIAL_EXTENSIONS, type ExtensionManifest } from './extension-registry';

export const MIN_PEOPLE = 20;
export const MIN_SIDE = 5;

export interface AdoptionCounts {
  slug: string;
  users_total: number;
  rows_on: number;
  rows_off: number;
  tried_30d: number;
  kept_30d: number;
}

export interface AdoptionStat {
  hasItOn: number | null;
  keptOn30d: number | null;
}

function share(part: number, whole: number): number | null {
  if (whole < MIN_PEOPLE) return null;
  if (part < MIN_SIDE || whole - part < MIN_SIDE) return null;
  // Both sides have at least MIN_SIDE people, so neither 0% nor 100% is true;
  // rounding 97% up to "100% kept it on" would say something that isn't.
  return Math.min(0.95, Math.max(0.05, Math.round((part / whole) * 20) / 20));
}

export function computeAdoption(
  counts: AdoptionCounts[],
  extensions: ExtensionManifest[] = OFFICIAL_EXTENSIONS
): Record<string, AdoptionStat> {
  // Every row carries the same users_total; a slug nobody has touched has no
  // row at all, so the total is taken from any row (and is 0 on an empty DB).
  const usersTotal = Number(counts[0]?.users_total ?? 0);
  const bySlug = new Map(counts.map((row) => [row.slug, row]));
  const out: Record<string, AdoptionStat> = {};

  for (const extension of extensions) {
    const row = bySlug.get(extension.slug);
    const on = Number(row?.rows_on ?? 0);
    const off = Number(row?.rows_off ?? 0);
    const untouched = Math.max(0, usersTotal - on - off);
    const haveItOn = on + (extension.defaultEnabled ? untouched : 0);

    out[extension.slug] = {
      hasItOn: share(haveItOn, usersTotal),
      keptOn30d: extension.defaultEnabled
        ? null
        : share(Number(row?.kept_30d ?? 0), Number(row?.tried_30d ?? 0)),
    };
  }
  return out;
}

/** The one line a card or header prints, or null when there is nothing to say. */
export function adoptionLine(stat: AdoptionStat | undefined): string | null {
  if (!stat) return null;
  if (stat.keptOn30d !== null) return `${Math.round(stat.keptOn30d * 100)}% kept it on after 30 days`;
  if (stat.hasItOn !== null) return `On for ${Math.round(stat.hasItOn * 100)}% of people`;
  return null;
}
