import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isGroupBy, type GroupBy, type TimeBucket } from './planner-types';
import { usePlannerStore } from './planner-store';
import { EMPTY_VIEW_FILTERS, normalizeFilters, type ViewFilters } from './filters';
import { containerRef } from './container-registry';
import { isSortBy, type SortBy } from './sort-rows';
// Type-only, so it is erased at compile time and lib/local-state.ts importing
// this store back does not make a runtime cycle — the same trick the
// week-columns note below relies on.
import type { ClearScope } from './local-state';
import { prefersReducedMotion } from './zen-transition';
// week-columns imports ViewLayout back from here, but type-only — erased at
// compile time, so there is no runtime cycle.
import {
  clampWeekDays,
  isScalableLayout,
  stepWeekDaysFromLastCanvas,
} from './week-columns';

/**
 * View preferences for the redesigned canvas: what slice of time you're
 * looking at (scope), how it's laid out (layout), and what's shown.
 *
 * Source of truth going forward. During the migration (P2–P5) the legacy
 * fields in planner-store (viewMode, timelineItemFilter) are kept mirrored so
 * the old timeline/week-view keep working until their rewrites land; the
 * mirrors and the legacy fields are deleted in P8.
 */

export type ViewScope = 'day' | 'week';
export type ViewLayout = 'buckets' | 'schedule' | 'list';
export type TypeFilter = 'all' | 'tasks' | 'habits';
export type BraindumpGroupBy = 'none' | 'type' | 'project' | 'priority' | 'routine' | 'program' | 'goal';

const BRAINDUMP_GROUP_BY_VALUES: readonly BraindumpGroupBy[] = [
  'none',
  'type',
  'project',
  'priority',
  'routine',
  'program',
  'goal',
];

/**
 * Coerce a persisted `braindumpGroupBy`.
 *
 * Same hazard `isGroupBy` guards on the canvas side: an unrecognised string
 * reaches `groupRows`, whose container branch is the fallthrough, so a stale or
 * devtools-edited value would silently group the braindump by project. This
 * union is user-persisted in `dsul-view` and was widened after ship, so a blob
 * written when it was 'none' | 'type' | 'project' is fine, but a garbage value is
 * not — and unlike the canvas keys, this one was never coerced in `merge` before.
 * 'priority' joined later still; a stale 'priority' that no view-store write has
 * yet overwritten with the coerced 'none' now resolves to a real grouping.
 */
export const isBraindumpGroupBy = (v: unknown): v is BraindumpGroupBy =>
  typeof v === 'string' && (BRAINDUMP_GROUP_BY_VALUES as readonly string[]).includes(v);
/** Content typeface: sans = Inter Medium 13 (Linear look), serif = Source Serif SemiBold 15. */
export type TypeMode = 'sans' | 'serif';
/**
 * Chrome drawn on a schedule block when it's hovered/selected — the corner
 * registration plus the resize grips. All three are 1px --ink-1 hairline and
 * reveal on hover; they differ only in FORM (see components/views/day-schedule).
 *   nodes  — CAD bounding-box handles: hollow squares on the vertices (default)
 *   target — prepress registration crosshairs floating off each corner
 *   trim   — trim-mark lozenges + a three-patch ink strip for the grip
 */
export type ScheduleMarkStyle = 'nodes' | 'target' | 'trim';
/**
 * How a bucket is drawn in day/week × buckets. Both variants share everything
 * that made the redesign worth doing — the header band is vacated in each, an
 * empty bucket collapses to its caption, a drag opens a recess, and both are
 * collapsible — so this only picks where the bucket's glyph lives and what the
 * body is at rest.
 *   spine — "floating card". The glyph sits inline in the caption and the body
 *           is a card floating on the canvas. "Now" is a lime rule down the
 *           card's left wall. (The value's name is from the timeline rail it
 *           used to have; it stays because it is persisted.)
 *   tray  — the glyph sits beside the caption and the rows live in a
 *           bordered, recessed tray. "Now" is a solid lime disc plus a lime rule
 *           down the tray's left wall.
 * See components/primitives/bucket-card.tsx.
 */
export type BucketStyle = 'spine' | 'tray';

/**
 * The filter shape lives in lib/filters.ts, which is store-free so the pure
 * derivation modules can import it too.
 *
 * There used to be FOUR declarations of one concept — `BraindumpFilters`,
 * `CanvasFilters`, `DayItemFilters` and `FilterPopoverValue` — and two of them
 * disagreed: `priorities` was `string[]` on one and `Priority[]` on the other,
 * for a value that only ever came from a `Priority[]` const.
 *
 * The braindump and the canvas still hold SEPARATE VALUES; only the shape is
 * shared.
 */
export type { ViewFilters };
export { EMPTY_VIEW_FILTERS };

/** @deprecated Aliases so the rename lands in one commit. Prefer `ViewFilters`. */
export type BraindumpFilters = ViewFilters;
export type CanvasFilters = ViewFilters;

interface ViewStore {
  scope: ViewScope;
  layout: ViewLayout;
  typeFilter: TypeFilter;
  canvasGroupBy: GroupBy;
  braindumpGroupBy: BraindumpGroupBy;
  /** Ordering, per surface. List surfaces only — see lib/sort-rows.ts. */
  canvasSortBy: SortBy;
  braindumpSortBy: SortBy;
  braindumpFilters: ViewFilters;
  canvasFilters: ViewFilters;
  typeMode: TypeMode;
  scheduleMarkStyle: ScheduleMarkStyle;
  /**
   * How many day columns the week views try to fit across the canvas — the
   * value behind the week scale control. Stored as a day COUNT, not a pixel
   * width, so it keeps meaning the same thing when the canvas resizes under it
   * (item panel, sidebar, window). lib/week-columns.ts turns it into pixels.
   *
   * `null` means the user has never adjusted it, and is NOT the same as landing
   * on the default by choice: while it is null the view picks whichever stop
   * comes nearest TARGET_COL_PX on the canvas it actually has, and keeps
   * re-picking as that canvas changes. The first adjustment writes a number and
   * that is what persists from then on.
   */
  weekDaysVisible: number | null;
  bucketStyle: BucketStyle;
  /**
   * Buckets the user has shut, in BOTH day and week — the state is the bucket,
   * not the bucket-on-a-date, so collapsing Morning shuts it in all seven week
   * columns at once ("I'm not thinking about mornings"). Per-date collapse would
   * make the week view's columns disagree about their own rhythm, and there is
   * no surface that would show you which dates you had shut.
   *
   * An array rather than a Set or a Record so it round-trips through the persist
   * middleware's JSON without a serializer.
   */
  collapsedBuckets: TimeBucket[];
  /**
   * Zen — the distraction-free room. True means the whole shell is replaced by
   * the Zen surface (components/zen/zen-room.tsx).
   *
   * It lives HERE, beside scope and layout, rather than in ui-store's
   * `activeDialog`, and the difference is load-bearing: that slot holds one
   * thing at a time, so summoning ⌘K or quick-add from inside Zen would evict
   * the room. As its own flag, dialogs open ON TOP of Zen and closing one
   * returns to it — capture never costs you the room.
   *
   * PERSISTED, unlike the schedule's lane focus (lib/schedule-focus-store.ts),
   * which is deliberately transient. That store holds an inspection gesture; this
   * one holds a place you work for an hour, and a reload mid-session should land
   * you back in it rather than dumping you into the full app.
   *
   * Desktop only for now — see the `view.zen` command. Nothing in the mobile
   * tree reads this.
   */
  zenOpen: boolean;
  /**
   * True while the desktop is animating between the planner and Zen
   * (components/zen/zen-stage.tsx), when BOTH surfaces are mounted. Flipped in
   * the SAME update as `zenOpen`, so nothing ever renders a frame where the flag
   * has moved and this has not: the siblings that swap with the room (the modal
   * editor arm, the help bubble, the bulk bar) and Zen's own date sync wait on
   * it rather than jumping in over the wave. A second flip mid-flight cancels
   * the switch, so it toggles; ZenStage clears it when the wave lands. Never
   * true under reduced motion. Not meaningful across a reload — the merge below
   * forces it off.
   */
  zenMoving: boolean;
  /** One-time adoption of legacy planner-store view prefs (see adoptLegacyViewPrefs). */
  adoptedLegacy: boolean;

  setScope: (scope: ViewScope) => void;
  setLayout: (layout: ViewLayout) => void;
  setTypeFilter: (filter: TypeFilter) => void;
  setCanvasGroupBy: (groupBy: GroupBy) => void;
  setBraindumpGroupBy: (groupBy: BraindumpGroupBy) => void;
  setCanvasSortBy: (sortBy: SortBy) => void;
  setBraindumpSortBy: (sortBy: SortBy) => void;
  setBraindumpFilters: (filters: ViewFilters) => void;
  setCanvasFilters: (filters: ViewFilters) => void;
  /**
   * Follow a container rename through the persisted filter refs.
   *
   * `containers` holds `project:Work` / `group:Wellness` — NAMES, in
   * localStorage, from before containers had stable ids. Renaming was parked
   * until migration 027, so these could never go stale; now they can, and a
   * stale ref does not degrade gracefully: `passesContainerFilter` matches
   * nothing, so the canvas or the braindump empties completely and the only
   * clue is a filter chip naming a project that no longer exists.
   *
   * Called from the rename site rather than from planner-store's action,
   * because this store already imports planner-store and the reverse would
   * close a cycle.
   */
  renameContainerRef: (from: string, to: string) => void;
  setTypeMode: (mode: TypeMode) => void;
  setScheduleMarkStyle: (style: ScheduleMarkStyle) => void;
  /** `null` hands the choice back to the width-derived default. */
  setWeekDaysVisible: (days: number | null) => void;
  /** Move along the ladder by `delta` stops; +1 is one step wider. */
  stepWeekDaysVisible: (delta: number) => void;
  setBucketStyle: (style: BucketStyle) => void;
  setZenOpen: (open: boolean) => void;
  toggleZen: () => void;
  toggleBucketCollapsed: (bucket: TimeBucket) => void;
  /**
   * Force a bucket open. Called when a drop lands in one (see app-shell's
   * handleDragEnd): dropping into a shut bucket would otherwise swallow the
   * item — the count ticks up but nothing appears, which reads as a failed drop.
   */
  expandBucket: (bucket: TimeBucket) => void;
  /** Drop this account's view preferences — see lib/local-state.ts. */
  clearUserScopedState: (scope: ClearScope) => void;
}

/**
 * The two fields that say something about a PERSON, at their defaults.
 *
 * `canvasFilters` / `braindumpFilters` hold `project:`/`group:` refs, tag names
 * and goal ids lifted from the signed-in account's own containers. Left behind
 * on a shared browser they name one person's projects inside another person's
 * session — and, more prosaically, silently empty the next user's canvas,
 * because none of those refs resolve. Cleared under BOTH scopes: on an
 * unstamped browser we cannot rule out that they are someone else's.
 */
const DISCLOSIVE_DEFAULTS = {
  braindumpFilters: EMPTY_VIEW_FILTERS,
  canvasFilters: EMPTY_VIEW_FILTERS,
} satisfies Partial<ViewStore>;

/**
 * Everything else this store persists — the shape of the screen, and nothing
 * about anyone.
 *
 * Every one is a closed enum, a bounded number or a list of time buckets:
 * which slice of time is on screen and how it is laid out, which axis it is
 * grouped and sorted by, which typeface and which block chrome, how many day
 * columns, which buckets are folded shut. None of it is free text, and none of
 * it is derived from the account's own data, so none of it can identify or
 * describe the person who set it.
 *
 * Cleared only under scope 'all' — when we KNOW the user changed. On an
 * unstamped browser (every existing install, once) it survives, because this
 * store has NO server copy at all: no `saveSettings` call reaches it, so
 * clearing it there would be permanent loss of a preference from which nobody
 * could have learned anything.
 *
 * `adoptedLegacy` is in neither list. It is not a preference but a one-time
 * marker that THIS BROWSER's view-store has already absorbed the old
 * planner-store view prefs (see adoptLegacyViewPrefs below). Resetting it would
 * re-run that adoption against whatever planner-store happens to hold at mount
 * — which after a clear is the defaults, and mid-hydration is a race — and it
 * would also invalidate the fixture tests/e2e/helpers/session.ts seeds, whose
 * whole job is to hold that flag true.
 */
const INERT_DEFAULTS = {
  scope: 'day',
  layout: 'buckets',
  typeFilter: 'all',
  canvasGroupBy: 'none',
  braindumpGroupBy: 'none',
  canvasSortBy: 'default',
  braindumpSortBy: 'default',
  typeMode: 'sans',
  scheduleMarkStyle: 'nodes',
  weekDaysVisible: null,
  bucketStyle: 'spine',
  collapsedBuckets: [],
  zenOpen: false,
  zenMoving: false,
} satisfies Partial<ViewStore>;

const USER_SCOPED_DEFAULTS = { ...INERT_DEFAULTS, ...DISCLOSIVE_DEFAULTS };

export const useViewStore = create<ViewStore>()(
  persist(
    (set) => ({
      ...USER_SCOPED_DEFAULTS,
      adoptedLegacy: false,

      clearUserScopedState: (scope) =>
        set(scope === 'all' ? { ...USER_SCOPED_DEFAULTS } : { ...DISCLOSIVE_DEFAULTS }),

      setScope: (scope) => {
        set({ scope });
        // Legacy mirror + user-settings sync (planner-store persists default_view)
        usePlannerStore.getState().setViewMode(scope);
      },
      setLayout: (layout) => set({ layout }),
      setTypeFilter: (typeFilter) => {
        set({ typeFilter });
        usePlannerStore.getState().setTimelineItemFilter(typeFilter);
      },
      setCanvasGroupBy: (canvasGroupBy) => {
        set({ canvasGroupBy });
        usePlannerStore.getState().setGroupBy(canvasGroupBy);
      },
      setBraindumpGroupBy: (braindumpGroupBy) => set({ braindumpGroupBy }),
      setCanvasSortBy: (canvasSortBy) => set({ canvasSortBy }),
      setBraindumpSortBy: (braindumpSortBy) => set({ braindumpSortBy }),
      setBraindumpFilters: (braindumpFilters) => set({ braindumpFilters }),
      setCanvasFilters: (canvasFilters) => set({ canvasFilters }),

      renameContainerRef: (from, to) => {
        // One CLASSIFY kind since 039, so the prefix is a constant rather than a
        // parameter — built through `containerRef` so the grammar has one home.
        const oldRef = containerRef('project', from);
        const newRef = containerRef('project', to);
        const swap = (filters: ViewFilters): ViewFilters => {
          if (!filters.containers.includes(oldRef)) return filters;
          // Through a Set: renaming Work → Home while BOTH were selected would
          // otherwise leave two identical refs, and the chip row would render
          // "Home" twice.
          return {
            ...filters,
            containers: [...new Set(filters.containers.map((c) => (c === oldRef ? newRef : c)))],
          };
        };
        set((s) => ({
          canvasFilters: swap(s.canvasFilters),
          braindumpFilters: swap(s.braindumpFilters),
        }));
      },
      setTypeMode: (typeMode) => set({ typeMode }),
      setScheduleMarkStyle: (scheduleMarkStyle) => set({ scheduleMarkStyle }),
      // Clamped on the way IN, so nothing downstream has to defend against a
      // hand-edited localStorage value or a stale ladder. `null` passes through
      // untouched — it is the "never adjusted" state, not a bad number.
      setWeekDaysVisible: (days) =>
        set({ weekDaysVisible: days === null ? null : clampWeekDays(days) }),
      // Stepping is always an adjustment, so it resolves the current effective
      // value first — from the last measured canvas when nothing is stored yet —
      // and writes a concrete number. Stepping from null must not jump.
      //
      // One step is one visible change of COLUMN WIDTH, not one day: stops that
      // resolve to the same width are one rung (see weekRungs), so a shortcut can
      // move the stored count by more than one and never by nothing.
      stepWeekDaysVisible: (delta) =>
        set((s) => ({ weekDaysVisible: stepWeekDaysFromLastCanvas(s.weekDaysVisible, delta) })),
      setBucketStyle: (bucketStyle) => set({ bucketStyle }),
      setZenOpen: (zenOpen) => set((s) => zenSwitch(s, zenOpen)),
      toggleZen: () => set((s) => zenSwitch(s, !s.zenOpen)),
      toggleBucketCollapsed: (bucket) =>
        set((s) => ({
          collapsedBuckets: s.collapsedBuckets.includes(bucket)
            ? s.collapsedBuckets.filter((b) => b !== bucket)
            : [...s.collapsedBuckets, bucket],
        })),
      // Returns the SAME array when the bucket is already open. Every bucket
      // card subscribes to this slice, and a drop fires on every drag — handing
      // back a fresh array each time would re-render all 28 week cards for a
      // state change that didn't happen.
      expandBucket: (bucket) =>
        set((s) =>
          s.collapsedBuckets.includes(bucket)
            ? { collapsedBuckets: s.collapsedBuckets.filter((b) => b !== bucket) }
            : s
        ),
    }),
    {
      // NOT bumped for weekDaysVisible. zustand's default merge keeps the
      // initial value for any key the persisted payload lacks, so an existing
      // 'dsul-view' blob rehydrates with the default and no migration. A bump
      // would invalidate every stored payload — including the literal version:1
      // one tests/e2e/helpers/session.ts seeds, which would reset adoptedLegacy
      // and re-run the legacy adoption on a fixture.
      name: 'dsul-view',
      version: 1,
      /**
       * Deep-merge the two filter objects; shallow-merge everything else.
       *
       * The sentence above — "keeps the initial value for any key the persisted
       * payload lacks" — is true of TOP-LEVEL keys only. zustand's default merge
       * is `{...current, ...persisted}`, so a NESTED object is replaced
       * wholesale: a stored `canvasFilters` that predates `containers` wins
       * entirely, `filters.containers` reads `undefined`, and `.length` throws
       * on the first render. That is a white screen, not a degraded filter.
       *
       * And the e2e suite cannot catch it. tests/e2e/helpers/session.ts seeds a
       * blob that OMITS both filter objects, so every spec rehydrates fresh
       * defaults and stays green while a real browser breaks. The unit test in
       * tests/unit/view-store-merge.test.ts exists for exactly that gap — do not
       * delete it because "e2e covers this".
       *
       * A `merge` is independent of `version`, so this needs no bump (see above
       * for why a bump is not available anyway).
       */
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ViewStore> & Record<string, unknown>;
        return {
          ...current,
          ...p,
          braindumpFilters: normalizeFilters(p.braindumpFilters),
          canvasFilters: normalizeFilters(p.canvasFilters),
          // Scalars, so the shallow spread already supplies the default for a
          // blob that predates them. Coerced anyway because the value reaches a
          // COMPARATOR: an unrecognised string falls through sortRows' branches
          // to the priority arm and silently reorders the list, and a persisted
          // payload is user-editable in devtools.
          canvasSortBy: isSortBy(p.canvasSortBy) ? p.canvasSortBy : 'default',
          braindumpSortBy: isSortBy(p.braindumpSortBy) ? p.braindumpSortBy : 'default',
          // Same reason, one release later: 'status' WAS a legal GroupBy and is
          // sitting in real payloads. It falls through groupRows' branches to the
          // container arm, so a stale blob would silently group by project — and
          // the Grouping row would render "None" over it, because no option
          // matches, while the trigger counted it as one active clause.
          canvasGroupBy: isGroupBy(p.canvasGroupBy) ? p.canvasGroupBy : 'none',
          // The braindump's own axis, uncoerced before this — it predates the
          // routine/program values, so a blob written earlier holds a value that
          // is still legal, but a garbage one would fall through groupRows to the
          // container arm exactly as a stale canvasGroupBy would.
          braindumpGroupBy: isBraindumpGroupBy(p.braindumpGroupBy) ? p.braindumpGroupBy : 'none',
          // Coerced for the same reason the enums above are, with a sharper
          // failure: this one decides whether the app renders its shell AT ALL.
          // A devtools-edited or hand-written `"false"` is a truthy string, and
          // the whole planner would be replaced by the Zen room on load. `=== true`
          // makes every non-boolean read as closed; a blob that predates the field
          // is `undefined` and lands on the same answer.
          zenOpen: p.zenOpen === true,
          // A reload lands on a surface, never mid-animation.
          zenMoving: false,
        };
      },
    }
  )
);

/** One flip of the Zen flag, with the animation state that rides along. */
function zenSwitch(
  s: { zenOpen: boolean; zenMoving: boolean },
  zenOpen: boolean
): { zenOpen: boolean; zenMoving: boolean } {
  if (zenOpen === s.zenOpen) return { zenOpen, zenMoving: s.zenMoving };
  return { zenOpen, zenMoving: !s.zenMoving && !prefersReducedMotion() };
}

/**
 * True when the canvas should run edge-to-edge instead of the 1100px column.
 *
 * The week COLUMN views only. `canvas-container`'s cap exists so a day's rows
 * don't stretch into unreadable 2000px lines, and that argument holds just as
 * well for Week × List — but a grid of seven day columns is the one thing on
 * this canvas that can actually use the width, and capping it at 1100px is why
 * seven columns never fit on any monitor. The header capsule and the past-due
 * bar read this too, so all three keep the shared left edge that
 * `@utility canvas-container` exists to guarantee.
 */
export function useCanvasWide(): boolean {
  return useViewStore((s) => s.scope === 'week' && isScalableLayout(s.layout));
}

/**
 * Adopt the user's existing planner-store view prefs the first time the new
 * shell mounts, so nobody's saved day/week + filter choice resets. Runs once;
 * afterwards view-store is authoritative.
 */
export function adoptLegacyViewPrefs() {
  const view = useViewStore.getState();
  if (view.adoptedLegacy) return;
  const legacy = usePlannerStore.getState();
  useViewStore.setState({
    scope: legacy.viewMode,
    typeFilter: legacy.timelineItemFilter,
    // The second door 'status' can come through: planner-storage partializes
    // `groupBy`, so a blob written before Phase 5a deleted the member rehydrates
    // planner-store with it and this copies it across on first mount. The
    // declared type says that cannot happen; the stored JSON disagrees.
    canvasGroupBy: isGroupBy(legacy.groupBy) ? legacy.groupBy : 'none',
    adoptedLegacy: true,
  });
}

/**
 * Keep the persisted filter refs following their containers' names.
 *
 * DRIVEN BY THE STORE, not by the rename call site, and that difference is the
 * whole point. Called optimistically from the Organize console, the remap had no
 * inverse: undo restored the container's old name and the localStorage ref kept
 * the new one, so a single ⌘Z after a rename emptied the canvas — a NEW way to
 * cause exactly the harm the remap was added to prevent, and a worse one,
 * because localStorage survives the reload that would have fixed it.
 *
 * Comparing the id's name against its PREVIOUS name makes rename, undo and redo
 * one case instead of three: whatever moves a container's name, the refs follow.
 *
 * Known gap, and it is narrow: if the container UPDATE is rejected by the DB the
 * store stays optimistic, so refs and store agree until a reload re-reads the
 * old name — and the ref is then stale. Nothing here can see that rejection.
 * Carrying ids in the refs instead of names is the real fix and is a persisted-
 * format change; `takenBy` already refuses the collision that causes almost
 * every such rejection.
 */
const remapRefs = (
  before: { id: string; name: string }[],
  after: { id: string; name: string }[],
) => {
  for (const now of after) {
    const was = before.find((b) => b.id === now.id);
    if (was && was.name !== now.name) {
      useViewStore.getState().renameContainerRef(was.name, now.name);
    }
  }
};

// Optional-called because this runs at IMPORT time, and a unit test that mocks
// `@/lib/planner-store` with only the members it needs has no `subscribe` — the
// module-level call then throws while the mocked module is being evaluated, and
// the failure surfaces as an unrelated suite collecting zero tests. Real zustand
// always has it; the dedicated coverage in tests/unit/view-store-merge.test.ts
// drives the actual store.
usePlannerStore.subscribe?.((state, prev) => {
  if (state.projects !== prev.projects) remapRefs(prev.projects, state.projects);
});
