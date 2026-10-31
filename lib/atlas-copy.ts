/**
 * Every user-visible Atlas string, in one module, so one test can read them all
 * (tests/unit/atlas-copy.test.ts): no em or en dashes, no "Beacon", no ⌘ or
 * "Cmd", no "overdue" or "stalled". Modules that show an Atlas string import it
 * from here (the scope option, the registry rows, the skeleton) rather than
 * writing it inline.
 *
 * Guilt-free wording (memory/plans or the Atlas design, rule 13): "resting"
 * comes from a known date or a known pause, never from missing data, and never
 * as a count of idle days.
 */

export const ATLAS_COPY = {
  /** The scope's name: the Scope menu, the status bar, the toolbar title. */
  name: 'Atlas',
  /** The skeleton's screen-reader line while the planner loads. */
  loading: 'Loading Atlas…',
  /** The one Atlas layout PR1 ships. */
  layoutMap: 'Your map',
  /** Palette rows. */
  switchTo: 'Switch to Atlas',
  // Neutral: Goals starts off and routines and seasons can be unavailable, so
  // the palette never names a kind the account may not have.
  switchToDescription: 'Your projects and more as cards on one map',
  switchToKeywords: 'atlas map board canvas projects cards overview',
  /** `v` from Atlas goes back to Day (design 1.6). */
  toggleFromAtlas: 'Switch to Day view',
  /** The toolbar. */
  fit: 'Fit',
  fitLabel: 'Fit every card on screen',
  zoomLabel: (pct: number) => `Zoom ${pct}%`,
  /** The card. */
  allDone: "All done. What's next?",
  noMembers: 'Nothing in here yet',
  open: 'Open as page',
  expand: 'Show every open step',
  collapse: 'Show just the next step',
  centerHere: 'Center here',
  /** The row's tick box, when the verb gives no label of its own. */
  markDone: 'Mark complete',
  markOpen: 'Mark incomplete',
  moreTiles: (n: number) => `+${n}`,
  /** "3 of 7": lit out of lit and open. */
  count: (lit: number, total: number) => `${lit} of ${total}`,
  milestones: (achieved: number, total: number) => `${achieved} of ${total} milestones`,
  feeds: (n: number) => (n === 1 ? '1 thing feeds it' : `${n} things feed it`),
  /** Footer touch lines. */
  touchedToday: 'touched today',
  touchedAgo: (days: number) => `touched ${days}d ago`,
  restingSince: (day: string) => `resting since ${day}`,
  pausedTill: (day: string) => `paused till ${day}`,
  paused: 'paused',
  /** An auto season past its last day. */
  seasonEnded: (day: string) => `ended ${day}`,
  /** A goal that is finished; never "failed" or "abandoned". */
  achievedOn: (day: string) => `achieved ${day}`,
  achieved: 'achieved',
  setAside: 'set aside',
  usually: (time: string) => `usually ${time}`,
  target: (day: string) => `by ${day}`,
  /**
   * The empty map, naming only the kinds this account has (Goals starts off;
   * routines and seasons need their tables), so it never advertises an
   * extension that is off.
   */
  empty: (collections: boolean, goals: boolean) =>
    collections && goals
      ? 'Nothing on the map yet. Projects, routines, seasons and goals show up here as cards.'
      : collections
        ? 'Nothing on the map yet. Projects, routines and seasons show up here as cards.'
        : goals
          ? 'Nothing on the map yet. Projects and goals show up here as cards.'
          : 'Nothing on the map yet. Projects show up here as cards.',
  /** Accessible names. */
  cardLabel: (name: string, kind: string) => `${name}, ${kind}`,
  canvasLabel: 'Atlas map',
  /** The positions table's 2,000-row cap (087), said once a session. */
  placesFull: "Atlas can't remember more places",
} as const;

/** Every string the copy holds, flattened, for the scanning test. */
export function atlasCopyStrings(): string[] {
  const out: string[] = [];
  for (const v of Object.values(ATLAS_COPY)) {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') {
      // Sample each template with plausible arguments.
      out.push(String((v as (...a: unknown[]) => string)(3, 7)));
      out.push(String((v as (...a: unknown[]) => string)('Sep 30', 'Nov 4')));
      out.push(String((v as (...a: unknown[]) => string)(false, false)));
      out.push(String((v as (...a: unknown[]) => string)(true, false)));
      out.push(String((v as (...a: unknown[]) => string)(false, true)));
    }
  }
  return out;
}
