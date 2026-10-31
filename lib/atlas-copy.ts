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
  /** Atlas's home layout. */
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
  /** Momentum's reason line says the date (rule 13), not a count. */
  touchedYesterday: 'touched yesterday',
  touchedOn: (day: string) => `touched ${day}`,
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
  /** In a computed layout the name says the column or lane (the lanes layer is aria-hidden). */
  cardInLane: (label: string, lane: string) => `${label}, in ${lane}`,
  canvasLabel: 'Atlas map',
  /** The focus sheet (PR1c). */
  focus: 'Focus',
  focusLabel: (name: string) => `Focus on ${name}`,
  back: '‹ Atlas',
  backLabel: 'Back to Atlas',
  /** The item rail's back control on Atlas ("‹ Atlas"): Back closes the item onto the map. */
  railBack: 'Atlas',
  nextUp: 'Next up',
  later: 'Later',
  done: 'Done',
  milestonesHeading: 'Milestones',
  closeSheet: 'Done',
  escKey: 'esc',
  putOnToday: 'Put next step on Today',
  putOnTodayDone: (title: string) => `"${title}" is on Today`,
  openInOrganize: 'Open in Organize',
  showMoreDone: (n: number) => `Show ${n} more`,
  /** The Organize console's door (desktop only). */
  openAtlas: 'Open Atlas',
  openAtlasLabel: 'Close Organize and open Atlas',
  /** The positions table's 2,000-row cap (087), said once a session. */
  placesFull: "Atlas can't remember more places",

  /* ── PR2: layouts ─────────────────────────────────────────────────── */
  layoutMomentum: 'Momentum',
  layoutGoal: 'By goal',
  layoutTimeline: 'Timeline',
  /** By goal's note in the Layout menu while the Goals extension is off. */
  goalsOffNote: 'Turn on Goals',
  layoutCommand: 'Atlas layout',
  layoutCommandDescription: 'Your map, Momentum, By goal or Timeline',
  layoutCommandKeywords: 'atlas layout map momentum goal timeline arrange',
  /** The shortcut rows (keys 1 to 4), as the Keyboard pane lists them. */
  layoutShortcut: (layout: string) => `Atlas: ${layout}`,
  layoutShortcutContext: 'Atlas only, on the desktop.',
  /** The toolbar's filters (they carry across layouts). */
  hideFinished: 'Hide finished',
  hideResting: 'Hide resting',

  /* Momentum's columns. */
  bandNow: 'Now',
  bandSoon: 'Soon',
  bandResting: 'Resting',
  bandNowHint: 'moving this week',
  bandSoonHint: 'touched lately or dated within a month',
  bandRestingHint: 'parked, no pressure',
  /* Momentum's reasons: what the app read, never a tally of idle days. */
  tickedToday: 'ticked today',
  dueToday: 'something on today',
  nextDate: (day: string) => `next date ${day}`,
  wrappingUp: 'all done, wrapping up',
  pinnedHere: (appBand: string) => `pinned here · the app says ${appBand}`,
  unpin: 'Unpin',
  unpinLabel: (name: string) => `Unpin ${name}, back to the app's sort`,
  pinTo: (band: string) => `Pin to ${band}`,
  pinned: (name: string, band: string) => `Pinned ${name} to ${band}`,
  unpinned: (name: string) => `${name} is back to the app's sort`,
  dropInColumn: 'Drop it in a column to pin it there',
  orderIsTheApps: 'The app orders each column. Drop it in another to pin it.',

  /* By goal. */
  notFeeding: 'Not feeding a goal',
  laneHintLink: 'drop a card here to link it',
  laneHintUnlink: 'drop here to unlink',
  feedsGoal: (goal: string) => `feeds ${goal}`,
  feedsGoals: (n: number) => `feeds ${n} goals`,
  notFeedingReason: 'not feeding a goal',
  dropInLane: 'Drop it in a lane to link it',
  goalsStay: 'Goals stay at the head of their lane',
  nothingToLink: 'Nothing in it to link yet',
  alreadyInLane: "It's already here. Drop it in another lane to link or unlink it.",
  alreadyPartOf: (goal: string) => `Already part of ${goal}`,

  /* Timeline. */
  laneRepeats: 'Repeats',
  laneGoals: 'Goals',
  laneDated: 'Dated',
  laneNoDates: 'No dates',
  today: 'Today',
  targetReason: (day: string) => `target ${day}`,
  nextStepDated: (day: string) => `next step dated ${day}`,
  noDates: 'no dates',
  repeats: 'repeats',
  seasonRange: (from: string, to: string) => `${from} to ${to}`,
  seasonFrom: (from: string) => `from ${from}`,
  seasonUntil: (to: string) => `until ${to}`,
  cantEndBeforeStart: (day: string) => `Can't end before it starts, ${day}`,
  projectsFollowDates: 'Projects follow their dated steps. Open one to change a date.',
  routineNoDate: 'A routine repeats, so it has no single date',
  seasonsFollowDates: 'Seasons follow their own dates. Open one to change them.',
  dropAboveNoDates: 'Drop it on a month to give it a target',
  dropInsideTimeline: 'Drop it on a month inside the timeline',
  finishedGoalKeepsDate: 'A finished goal keeps its date',
  dragTarget: (day: string) => `target ${day}`,

  /*
   * The undo strip's sentences for Atlas's item and goal writes. Each starts
   * with one of ATLAS_UNDO_PREFIXES, which hooks/use-undo-toast.ts counts as
   * worth offering an Undo for.
   */
  linked: (n: number, goal: string) =>
    `Linked ${n === 1 ? '1 item' : `${n} items`} to ${goal}. New items won't join on their own.`,
  unlinked: (name: string, goal: string) => `Unlinked ${name} from ${goal}`,
  unlinkedMany: (name: string, n: number) => `Unlinked ${name} from ${n} goals`,
  moved: (name: string, goal: string) => `Moved ${name} to ${goal}. New items won't join on their own.`,
  targetMoved: (goal: string, day: string) => `Target for ${goal} moved to ${day}`,

  /* ── PR3: the far zoom, its Look setting and the minimap ──────────── */
  /** The cluster buttons' group below 50% zoom. */
  farLabel: 'Atlas, zoomed out',
  /** A cluster's label under its tiles. */
  farLeft: (n: number) => `${n} left`,
  farAllDone: 'all done',
  farResting: 'resting',
  /** A cluster's tooltip: "Project · 2 of 7 done". */
  farTip: (kind: string, lit: number, total: number) => `${kind} · ${lit} of ${total} done`,
  farNext: (title: string) => `Next: ${title}`,
  farNothingLeft: "Nothing left. What's next?",
  /** A cluster's hit target, for a screen reader and the keyboard. */
  farClusterLabel: (name: string, kind: string) => `${name}, ${kind}. Zoom in`,
  /** What a screen reader hears after the label: what the tiles and the tooltip show. */
  farClusterStatus: (tip: string, line: string) => `${tip}. ${line}`,
  farZoomIn: 'Zoom in here',
  /** A season's dashed outline around what it holds. */
  farSeason: (name: string, kind: string) => `${name} · ${kind}`,
  /** A season frame's tab on Your map, after its kind in bold: "Spring term · Sep 30 to Nov 4". */
  frameTab: (name: string, dates: string | null) => (dates ? `${name} · ${dates}` : name),
  /** The Look setting (look.atlasFar). */
  farSettingLabel: 'Atlas zoomed out, light mode',
  farSettingDescription:
    'How Atlas looks on this computer when you zoom out past half size on a light theme. Bloom keeps the paper. Dusk turns it to slate so the tiles glow.',
  /** Under the row while a dark theme is showing, when neither pick changes anything yet. */
  farSettingDarkNote: 'You are on a dark theme, where Atlas always glows. This takes effect on a light theme.',
  farBloom: 'Bloom',
  farDusk: 'Dusk',
  /** The minimap and its command (shortcut id toggle_atlas_minimap). */
  minimapToggle: 'Pin or unpin the Atlas minimap',
  minimapToggleDescription: 'Keep the minimap on screen, or let it hide at rest',
  minimapToggleKeywords: 'atlas minimap map overview pin navigator',
  minimapContext: 'Atlas only, on the desktop.',
  minimapPinned: 'Minimap pinned',
  minimapUnpinned: 'Minimap hides at rest',

  /* ── PR4: filing by drag (a braindump row, or a row from another card) ── */
  /** The card's hint while a drag is over it and the drop would file. */
  dropToFile: (name: string) => `Drop to file in ${name}`,
  /** The card's hint while the dragged item is already in it (nothing writes). */
  alreadyHere: 'Already here',
  /** A drop that springs back: the type can't join this kind. */
  cantFileIn: (name: string) => `Can't file that in ${name}`,
  /** A drop that springs back: a subtask goes where its parent goes. */
  subtaskStays: 'Subtasks go where their parent goes',
  /** A drop that springs back: a goal's milestone or check-in, dragged to another goal. */
  milestoneMoves: "Milestones and check-ins move from the goal's page",
  /** A drop on the board between cards. */
  dropOnCard: 'Drop it on a card to file it there',
  /** The same drop in the far zoom, where the cards are clusters. */
  zoomInToFile: 'Zoom in to drop it on a card',
  /** The undo strip's sentences for a filing (ATLAS_UNDO_PREFIXES has 'Filed ' and 'Moved '). */
  filed: (name: string) => `Filed in ${name}`,
  filedFromBraindump: (name: string) => `Filed in ${name}. It stays in the braindump until it has a day.`,
  filedMany: (n: number, name: string) => `Filed ${n} items in ${name}`,
  movedRow: (title: string, to: string) => `Moved ${title} to ${to}`,
  movedRows: (n: number, to: string) => `Moved ${n} items to ${to}`,

  /* ── Walk Atlas: a calm look at one card at a time (atlas-walk.tsx) ── */
  /** The command's row (atlas.walk) and the walk's accessible name. */
  walk: 'Walk Atlas',
  walkDescription: 'A calm look at each card, one at a time. Nothing is graded.',
  walkKeywords: 'atlas walk review tour look over cards weekly calm',
  /** The toolbar button, and its name while a walk is on. */
  walkButton: 'Walk',
  walkButtonLabel: 'Walk Atlas, one card at a time',
  walkStopLabel: 'Stop walking Atlas',
  /** The panel's top line. */
  walkStep: (n: number, total: number) => `${n} of ${total}`,
  walkCalm: 'one card at a time, nothing here is due',
  /** A card with an open next step. */
  walkNextQuestion: 'Still the right next step?',
  walkNextDetail: (step: string) => `Next up: ${step}`,
  /** A goal with a target day and nothing resting. */
  walkGoalQuestion: (day: string) => `Still aiming for ${day}?`,
  walkGoalDetail: (step: string) => `Next on the way: ${step}`,
  /** Nothing open: everything done, or nothing in it yet. */
  walkEmptyQuestion: "What's the next step?",
  walkEmptyAllDone: 'Everything in it is done. A next step, or a rest, both work.',
  walkEmptyNothing: 'Nothing in it yet. Add a step when one comes to mind.',
  /** Resting: a known old touch or a pause, never a tally (rule 13). */
  walkRestingQuestion: 'Still want this?',
  walkRestingSince: (day: string) => `Resting since ${day}. Letting it rest is fine too.`,
  walkPausedTill: (day: string) => `Paused till ${day}. Letting it rest is fine too.`,
  walkPaused: 'Paused. Letting it rest is fine too.',
  /** Finished as a container: an achieved goal, a season past its days. */
  walkEndedQuestion: 'All wrapped up.',
  walkEndedDetail: 'Nothing needs you here.',
  /** After the last card. */
  walkFinishedQuestion: "That's every card.",
  walkFinishedDetail: 'Thanks for taking a look. Nothing here is graded.',
  /** The buttons: existing verbs, and the walk's own Back, Next and Done. */
  walkPutOnToday: 'Put next step on Today',
  walkWake: 'Wake it: next step on Today',
  walkComplete: 'Mark the step done',
  walkCompleteToday: 'Done for today',
  walkBack: 'Back',
  walkNext: 'Next',
  walkDone: 'Done',
  walkEnterKey: '↵',
  /** What a screen reader hears at each stop. */
  walkAnnounce: (n: number, total: number, name: string, kind: string, question: string) =>
    `Card ${n} of ${total}: ${name}, ${kind}. ${question}`,
  walkAnnounceFinished: "That's every card. Done takes you back to where you were.",
  /** Started with no card drawn (an empty map, or every card filtered away). */
  walkNothing: 'Nothing on the map to walk yet',
} as const;

/** The undo strip offers Undo for these (hooks/use-undo-toast.ts). */
export const ATLAS_UNDO_PREFIXES = ['Linked ', 'Unlinked ', 'Moved ', 'Target for ', 'Filed '] as const;

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
