import { NO_MATCH, scoreText, scoreAliases } from '@/lib/commands/score';
import {
  SETTINGS,
  DESTINATIONS,
  displayValue,
  valueLabels,
  isModified,
  subPanesOf,
  type SettingRecord,
  type DestinationRecord,
  type SettingCtx,
  type PaneId,
  type RootPaneId,
} from './manifest';

/**
 * Settings search.
 *
 * Built on lib/commands/score.ts rather than beside it — that module already
 * implements the transparent tier model this needs (exact 1000 / prefix 800 /
 * word-boundary 600 / substring 400 / reverse-word 350, aliases 1200/700) and
 * its comments record why a pair of includes() calls wasn't enough. Reaching
 * for Fuse.js instead is what ranks "twirling" above "twilight".
 *
 * `scoreText` is left ALONE: it returns a bare number and every existing caller
 * does Math.max(...) then compares against NO_MATCH, so widening its return
 * type would be a breaking change across match.ts and entities.ts. Ranges come
 * from a sibling, `scoreTextRanges`, defined here.
 *
 * Three things this adds on top:
 *   1. Field multipliers, so a description-only hit can never outrank a label hit.
 *   2. Whitespace term-splitting with AND across fields — "week start" matches a
 *      record whose label supplies "week" and whose keywords supply "start".
 *   3. A single-edit-distance pass that runs ONLY when the strict pass returns
 *      nothing, surfaced under "Did you mean" and never interleaved.
 */

/** scoreText lowercases the TEXT but not the QUERY. Every caller must do this. */
export function normalizeQuery(raw: string): string {
  return raw.toLowerCase().trim();
}

export function queryTerms(raw: string): string[] {
  return normalizeQuery(raw).split(/\s+/).filter(Boolean);
}

export type MatchRange = [number, number];

/**
 * The same tiers as scoreText, plus the index range that matched, so the label
 * can be highlighted by SLICING rather than by a regex replace on the rendered
 * string — which breaks on multiple matches, on case, and on any markup.
 */
export function scoreTextRanges(
  query: string,
  text: string
): { score: number; ranges: MatchRange[] } {
  const score = scoreText(query, text);
  if (score === NO_MATCH || !query) return { score, ranges: [] };
  const at = text.toLowerCase().indexOf(query);
  return { score, ranges: at === -1 ? [] : [[at, at + query.length]] };
}

const FIELD = {
  label: 1,
  valueLabels: 0.9,
  keywords: 0.7,
  description: 0.45,
} as const;

/** Returns the winning text too — `matchedValue` has to name the value that
 *  actually scored, not whichever option happens to contain the substring. */
function bestOf(query: string, texts: string[]): { score: number; text: string | null } {
  let score = NO_MATCH;
  let text: string | null = null;
  for (const candidate of texts) {
    const s = scoreText(query, candidate);
    if (s > score) {
      score = s;
      text = candidate;
    }
  }
  return { score, text };
}

export interface SettingHit {
  kind: 'setting';
  record: SettingRecord;
  score: number;
  /** Ranges into `record.label`. */
  ranges: MatchRange[];
  /**
   * A value label that matched but is NOT the current value — rendered as
   * "matches: 24-hour" so it's obvious why the row surfaced.
   */
  matchedValue?: string;
}

export interface DestinationHit {
  kind: 'destination';
  record: DestinationRecord;
  score: number;
  ranges: MatchRange[];
}

export interface SearchResult {
  settings: SettingHit[];
  destinations: DestinationHit[];
  /** True when the strict pass found nothing and these came from the fuzzy fallback. */
  didYouMean: boolean;
  counts: Record<string, number>;
  total: number;
}

/** One term against one record. Returns null the moment a term doesn't apply. */
function scoreRecord(
  record: SettingRecord,
  terms: string[],
  ctx: SettingCtx
): { score: number; ranges: MatchRange[]; matchedValue?: string } | null {
  let total = 0;
  let ranges: MatchRange[] = [];
  let matchedValue: string | undefined;

  const values = valueLabels(record);
  const current = (() => {
    try {
      return displayValue(record, record.read(ctx));
    } catch {
      return '';
    }
  })();

  for (const term of terms) {
    let best = NO_MATCH;

    const alias = scoreAliases(term, record.aliases);
    if (alias !== NO_MATCH) best = alias;

    const lab = scoreTextRanges(term, record.label);
    if (lab.score !== NO_MATCH) {
      best = Math.max(best, lab.score * FIELD.label);
      ranges = ranges.concat(lab.ranges);
    }

    const val = bestOf(term, values);
    if (val.score !== NO_MATCH) {
      best = Math.max(best, val.score * FIELD.valueLabels);
      // Taken from the value that actually SCORED, not from a fresh
      // includes() scan — scoreText's reverse-word tier ("sundays" → "Sunday")
      // matches where includes() does not, which is exactly the case this
      // subline exists to explain. Shown whenever it isn't already on screen,
      // even if some other field outscored it: the question it answers is "why
      // is this row here", not "which field won".
      if (val.text && val.text !== current) matchedValue = val.text;
    }

    const kw = bestOf(term, record.keywords);
    if (kw.score !== NO_MATCH) best = Math.max(best, kw.score * FIELD.keywords);

    if (record.description) {
      const desc = scoreText(term, record.description);
      if (desc !== NO_MATCH) best = Math.max(best, desc * FIELD.description);
    }

    // AND across terms: every word must find a home somewhere on the record.
    if (best === NO_MATCH) return null;
    total += best;
  }

  return { score: total, ranges, matchedValue };
}

function scoreDestination(
  record: DestinationRecord,
  terms: string[]
): { score: number; ranges: MatchRange[] } | null {
  let total = 0;
  let ranges: MatchRange[] = [];

  for (const term of terms) {
    let best = NO_MATCH;

    const lab = scoreTextRanges(term, record.label);
    if (lab.score !== NO_MATCH) {
      best = Math.max(best, lab.score * FIELD.label);
      ranges = ranges.concat(lab.ranges);
    }
    const kw = bestOf(term, record.keywords);
    if (kw.score !== NO_MATCH) best = Math.max(best, kw.score * FIELD.keywords);

    if (best === NO_MATCH) return null;
    total += best;
  }

  return { score: total, ranges };
}

/** One edit away — transposition, substitution, insertion or deletion. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;

  if (short.length === long.length) {
    let diffs = 0;
    let first = -1;
    for (let i = 0; i < short.length; i++) {
      if (short[i] === long[i]) continue;
      if (diffs === 0) first = i;
      if (++diffs > 2) return false;
    }
    if (diffs === 1) return true;
    // Two positional differences are still ONE edit when they're an adjacent
    // swap — "thmee" for "theme". Transposition is the most common typo class
    // there is, and counting positions alone misses every one of them.
    return (
      diffs === 2 &&
      short[first] === long[first + 1] &&
      short[first + 1] === long[first]
    );
  }

  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

function fuzzyHits(terms: string[], available: SettingRecord[]): SettingHit[] {
  if (terms.length !== 1) return [];
  const term = terms[0];
  // Below four characters an edit-distance pass matches half the manifest.
  if (term.length < 4) return [];

  const hits: SettingHit[] = [];
  for (const record of available) {
    const words = record.label.toLowerCase().split(/[\s/&–—-]+/);
    const near = words.some((w) => w.length >= 4 && withinOneEdit(w, term));
    if (near) hits.push({ kind: 'setting', record, score: 100, ranges: [] });
  }
  return hits;
}

export interface SearchOptions {
  /**
   * Advanced rows are excluded unless the query hits their label exactly, or
   * this is on — VS Code's @tag:advanced with a one-time opt-in instead of an
   * accordion you re-expand on every visit.
   */
  includeAdvanced?: boolean;
  /** Platform-absent rows are not indexed: a result must never open onto nothing. */
  isMobile?: boolean;
}

export function searchSettings(
  raw: string,
  ctx: SettingCtx,
  options: SearchOptions = {}
): SearchResult {
  const terms = queryTerms(raw);
  const empty: SearchResult = {
    settings: [],
    destinations: [],
    didYouMean: false,
    counts: {},
    total: 0,
  };
  if (!terms.length) return empty;

  // A row hidden by platform is absent from the index, not greyed in it —
  // otherwise search deep-links to a control that will never render.
  const available = SETTINGS.filter((r) => !(r.desktopOnly && options.isMobile));

  const settings: SettingHit[] = [];
  for (const record of available) {
    if (record.advanced && !options.includeAdvanced) {
      // Compare the whole normalized query. `terms` was split on /\s+/, so
      // terms[0] can never contain a space — testing against it made this
      // escape hatch unreachable for every advanced label with a space in it,
      // which is all of them but "Model".
      const exact = record.label.toLowerCase() === terms.join(' ');
      if (!exact) continue;
    }
    const hit = scoreRecord(record, terms, ctx);
    if (hit) {
      settings.push({
        kind: 'setting',
        record,
        score: hit.score,
        ranges: hit.ranges,
        matchedValue: hit.matchedValue,
      });
    }
  }

  const destinations: DestinationHit[] = [];
  for (const record of DESTINATIONS) {
    const hit = scoreDestination(record, terms);
    if (hit) {
      destinations.push({ kind: 'destination', record, score: hit.score, ranges: hit.ranges });
    }
  }

  // Ties break on modified-first — surface what you've already touched — then
  // on declaration order, which is the order the panes render in.
  const order = new Map(SETTINGS.map((r, i) => [r.id, i]));
  const rank = (a: SettingHit, b: SettingHit) => {
    if (b.score !== a.score) return b.score - a.score;
    const am = isModified(a.record, ctx) ? 1 : 0;
    const bm = isModified(b.record, ctx) ? 1 : 0;
    if (am !== bm) return bm - am;
    return (order.get(a.record.id) ?? 0) - (order.get(b.record.id) ?? 0);
  };

  let didYouMean = false;
  let final = settings;
  if (!settings.length && !destinations.length) {
    // Only ever a fallback, and never interleaved with strict results.
    final = fuzzyHits(terms, options.includeAdvanced ? available : available.filter((r) => !r.advanced));
    didYouMean = final.length > 0;
  }

  final.sort(rank);
  destinations.sort((a, b) => b.score - a.score);

  const counts: Record<string, number> = {};
  for (const hit of final) {
    counts[hit.record.pane] = (counts[hit.record.pane] ?? 0) + 1;
  }

  return { settings: final, destinations, didYouMean, counts, total: final.length };
}

/**
 * What the rail should show against one of its entries.
 *
 * `counts` is keyed by the pane a record actually lives in, and it stays that
 * way — the sum of its values is the result total, and the results list groups
 * by exactly those keys. But the rail has no row for `extensions/beeminder`,
 * so a hit inside a sub-pane would show as a zero on Extensions and dim the one
 * rail entry that leads to it. This rolls a parent's sub-panes up into it, and
 * is the ONLY place that rollup happens.
 */
export function paneMatchCount(result: SearchResult, pane: PaneId): number {
  const own = result.counts[pane] ?? 0;
  return subPanesOf(pane as RootPaneId).reduce(
    (total, sub) => total + (result.counts[sub.id] ?? 0),
    own
  );
}

/** Rows of the active pane, with the same platform and advanced rules applied. */
export function paneRows(
  pane: PaneId,
  options: SearchOptions = {}
): { rows: SettingRecord[]; advanced: SettingRecord[] } {
  const all = SETTINGS.filter(
    (r) => r.pane === pane && !(r.desktopOnly && options.isMobile)
  );
  return {
    rows: all.filter((r) => !r.advanced),
    advanced: all.filter((r) => r.advanced),
  };
}

/**
 * Split a label into highlighted and plain runs. Ranges are merged first
 * because two terms can overlap on the same word.
 */
export function highlightRuns(
  text: string,
  ranges: MatchRange[]
): { text: string; hit: boolean }[] {
  if (!ranges.length) return [{ text, hit: false }];

  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: MatchRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }

  const runs: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) runs.push({ text: text.slice(cursor, start), hit: false });
    runs.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor), hit: false });
  return runs;
}
