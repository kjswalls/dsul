'use client';

import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  Flag,
  Folder,
  Hash,
  Moon,
  RotateCcw,
  Rows3,
  SlidersHorizontal,
  Target,
  type LucideIcon,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip';
import { RailTipContent, useQuietTip } from '@/components/primitives/pills';
import { useIsMobile } from '@/hooks/use-mobile';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { NO_PRIORITY, type PriorityFilterValue, type ViewFilters } from '@/lib/filters';
import {
  UNKNOWN_GOAL_LABEL,
  goalMenuOrder,
  priorityFilterLabel,
  resetDisplay,
  useDisplaySummary,
  type DisplaySurface,
} from '@/lib/display-summary';
import {
  CONTAINER_KINDS,
  NO_CONTAINER,
  containerRef,
  namesOfKind,
  sameContainerName,
} from '@/lib/container-registry';
import { displayGoals } from '@/lib/goals';
import { useBraindumpGroupBy, useCanvasGroupBy, useGoalsEnabled } from '@/lib/extension-gates';
import { accentColorForName } from '@/lib/accent-colors';
import { buildScopeRows } from '@/lib/scope-rail';
import { setGateOn } from '@/lib/gate-toggle';
import { toDateStr } from '@/lib/recurrence';
import { CategoryIcon } from '@/lib/category-icons';
import {
  BRAINDUMP_GROUP_BY_OPTIONS,
  CANVAS_GROUP_BY_OPTIONS,
  TYPE_OPTIONS,
  groupBySupport,
  sortByBlockedBy,
  SORT_BY_OPTIONS,
} from '@/lib/view-options';
import type { Goal, GroupBy, Priority } from '@/lib/planner-types';
import { TIME_BUCKET_RANGES } from '@/lib/planner-types';
import { BUCKET_ORDER } from '@/lib/day-items';
import type { BraindumpGroupBy, ViewScope } from '@/lib/view-store';
import { cn } from '@/lib/utils';

/**
 * Display — one menu for grouping and filtering, per surface.
 *
 * Replaces `primitives/filter-popover.tsx` and the braindump's character-for-
 * character copy of it. Both were bare `<button>`s inside a Radix `Popover`: no
 * roving focus, no typeahead, no menu semantics, sitting 8px from three real
 * DropdownMenus on the same pill. This is a real menu, so all of that is free.
 *
 * **Structure above the separator, Filter and Show below it.** Above the line
 * nothing can make an item disappear; below it everything can. One separator
 * buys a safety affordance that costs nothing to teach.
 *
 * Both Structure rows follow one rule: they always render, and individual VALUES
 * disable themselves with the reason on the rail where the current view cannot
 * honour them. Hiding the row instead strands the clause — nothing clears
 * `canvasGroupBy` or `canvasSortBy` on a scope or layout change, so the trigger
 * would keep counting something with no row to account for it.
 *
 * ## One body, two shells
 *
 * Pointer gets the nested dropdown described above. Touch gets a bottom Drawer
 * that DRILLS IN: the root lists the sections with their current value on the
 * rail, tapping one slides that section into the sheet, and a back affordance
 * returns. Radix submenus are a hover-and-aim pattern — on a phone the second
 * tier opens off-screen or under the thumb, with nothing to dismiss it back to
 * the tier it came from, which is the bug this split fixes.
 *
 * **Drill-in rather than one flattened sheet, because one section is
 * unbounded.** Grouping is 6 values, Ordering 3, Type 3, Priority 4 — but
 * The Project section is every container plus the unset value,
 * which is why it carries a scroller on the desktop panel too. Flattened, a
 * fresh seed already stands ~22 rows tall at the 44px touch floor (~970px, past
 * an 80vh sheet on most phones) and it grows with the user's own data, burying
 * every section below it. Drilled, no pane but that one exceeds six rows.
 *
 * The two shells share the ROW MODEL below rather than their markup, which is
 * the lesson of what this menu replaced: two popovers with one body drifted
 * apart field by field until one of them was wrong. A row is described once —
 * label, state, what it writes, whether picking it completes the choice — and
 * each shell renders that description in its own idiom.
 *
 * The ITEM roles are shared with it deliberately. A row's role says what the
 * row MEANS (a value in a set, an independent toggle, an action), and that does
 * not change with the input device — so the sheet's rows carry the same
 * `menuitemradio` / `menuitemcheckbox` / `menuitem` the dropdown does, and the
 * ruling that an ACTION row must not be announced as a sixth unselected radio
 * holds in both. The CONTAINER is not shared, and must not be: `role="menu"`
 * promises a keyboard contract Radix implements and this shell does not. See
 * the pane below.
 */

/**
 * Declared beside the display model (lib/display-summary.ts), which reads it as
 * well; re-exported for the callers that name it from here.
 */
export type { DisplaySurface };

/* ── the row idiom ──────────────────────────────────────────────────────────
 *
 * 32px rows at 12px. Today's filter rows are 11px at 23px — the smallest type
 * and tightest rows anywhere in dsul, in the panel holding the most control
 * types. shadcn's own item is `py-1.5 text-sm`, hence the overrides.
 */
const ROW = 'h-8 gap-2 rounded-[5px] px-2 text-xs';
/** Same row, grown to hold a label plus its muted example line (`hint`). */
const ROW_TALL = 'min-h-11 py-1.5 gap-2 rounded-[5px] px-2 text-xs';
const CAP = 'px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground';
/** 240px. Today's popover is 208px, the narrowest menu in the app. */
const PANEL = 'w-60 rounded-[10px] p-1 shadow-[var(--shadow-elev-md)]';

/**
 * The touch idiom: 44px floor, 14px type, full-bleed rows.
 *
 * 44 and not the mode sheet's 48 for the same reason this shell drills instead
 * of flattening — the Project / Group pane is as long as the user's data, and
 * the floor is what the row has to clear, not what it should aim past. Every
 * pressable thing in this sheet is at least this tall, the back affordance
 * included.
 */
const SHEET_ROW =
  'flex w-full min-h-11 items-center gap-3 rounded-[10px] px-3 text-left text-sm text-foreground';
const SHEET_CAP =
  'px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground';

function Cap({ children }: { children: React.ReactNode }) {
  return <div className={CAP}>{children}</div>;
}

/**
 * Selection is a TRAILING check at inherited colour, matching ChipOption and
 * CollectRow. Radix's own DropdownMenuCheckboxItem/RadioItem put their indicator
 * on the left (`pl-8`, `absolute left-2`) against that house grammar, which is
 * why this uses plain items with an explicit role and aria-checked instead.
 *
 * Not `text-primary-foreground`: that is --lime-ink, dark-green ink meant to sit
 * ON a lime fill, and it is very nearly invisible on the popover ground. See the
 * same bug at header-capsule.tsx:75.
 */
function Tick({ on, className }: { on: boolean; className?: string }) {
  return on ? <Check className={cn('size-3.5', className)} /> : null;
}

/**
 * 8px dot in the real priority token, or a hollow ring for "no priority".
 * Exported so the braindump's Display shelf marks a value the way its row here
 * does.
 */
export function PriorityDot({ value }: { value: PriorityFilterValue }) {
  if (value === NO_PRIORITY) {
    return (
      <span className="size-2 shrink-0 rounded-full border border-muted-foreground/55" aria-hidden="true" />
    );
  }
  return (
    <span
      className="size-2 shrink-0 rounded-full"
      style={{ background: `var(--priority-${value})` }}
      aria-hidden="true"
    />
  );
}

/**
 * Colour is quarantined to a glyph, never a fill — a 9px rounded square in the
 * container's own colour. The lime budget is exactly one mark per surface (the
 * trigger dot), so a lime-filled selected chip like today's is out. Exported for
 * the braindump's Display shelf, like PriorityDot.
 */
export function ContainerSquare({ color }: { color: string }) {
  return (
    <span
      className="size-[9px] shrink-0 rounded-[3px]"
      style={{ background: color }}
      aria-hidden="true"
    />
  );
}

/* ── what the menu contains, described once ─────────────────────────────────*/

/**
 * One row, in either shell.
 *
 * `keepOpen` is the multi-select flag and it means the same thing on both: a
 * three-project selection is three taps, not three re-opens. Single-select
 * dismisses — the dropdown closes, the sheet closes with the drilled pane it
 * was in, because in both cases the choice is complete.
 */
type RowSpec = {
  key: string;
  label: string;
  checked: boolean;
  onToggle: () => void;
  keepOpen: boolean;
  leading?: React.ReactNode;
  icon?: LucideIcon;
  rail?: string;
  /**
   * A muted second line under the label — a couple of live examples of what this
   * option would produce ("Work, Personal…" beneath Project). Illustrative, not
   * exhaustive: it caps at two names so the row stays one glance, and it sits
   * BELOW the label rather than on the rail, which the canvas reach-notes own.
   */
  hint?: string;
  disabled?: boolean;
  /**
   * Marks a row that DOES something rather than holding a value — "Switch to
   * List" sits among the grouping options but selects none of them, and
   * deriving its role from close-behaviour announced it to a screen reader as a
   * sixth, unselected radio in the set.
   */
  action?: boolean;
};

/** A section's body is rows plus the furniture between them. */
type Entry =
  | ({ kind: 'row' } & RowSpec)
  | { kind: 'sep'; key: string }
  | { kind: 'cap'; key: string; label: string }
  | { kind: 'note'; key: string; text: string };

const rowEntry = (spec: RowSpec): Entry => ({ kind: 'row', ...spec });

/** A second tier: a dropdown submenu on pointer, a drilled pane on touch. */
type Section = {
  id: string;
  icon: LucideIcon;
  label: string;
  rail: string;
  set: boolean;
  entries: Entry[];
  /** Desktop submenu width. The sheet is always full-bleed. */
  width?: string;
  /** The body outgrows the panel; the dropdown scrolls it in place. */
  scroll?: boolean;
};

/**
 * The role is a property of the row, not of the shell it is drawn in — see the
 * header. Both renderers ask this so neither can answer it differently.
 */
function roleOf(spec: RowSpec): 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' {
  if (spec.action) return 'menuitem';
  return spec.keepOpen ? 'menuitemcheckbox' : 'menuitemradio';
}

/* ── the pointer shell ──────────────────────────────────────────────────────*/

/** A value row inside a submenu. Multi-select rows keep the menu open. */
function ValueRow({ spec }: { spec: RowSpec }) {
  const Icon = spec.icon;
  const role = roleOf(spec);
  return (
    <DropdownMenuItem
      className={cn(spec.hint ? ROW_TALL : ROW, spec.checked && 'font-semibold')}
      role={role}
      aria-checked={role === 'menuitem' ? undefined : spec.checked}
      disabled={spec.disabled}
      onSelect={(e) => {
        // Multi-select stays open so a three-project selection is three clicks,
        // not three re-opens. Single-select closes — the choice is complete.
        if (spec.keepOpen) e.preventDefault();
        if (!spec.disabled) spec.onToggle();
      }}
    >
      {spec.leading}
      {Icon && <Icon className="size-4 shrink-0" />}
      <span className="flex-1 min-w-0">
        <span className="block truncate">{spec.label}</span>
        {spec.hint && (
          <span className="block truncate text-[10px] font-normal leading-tight text-muted-foreground">
            {spec.hint}
          </span>
        )}
      </span>
      {spec.rail && <span className="shrink-0 text-[11px] text-muted-foreground">{spec.rail}</span>}
      <Tick on={spec.checked} />
    </DropdownMenuItem>
  );
}

function MenuEntries({ entries }: { entries: Entry[] }) {
  return (
    <>
      {entries.map((e) => {
        if (e.kind === 'sep') return <DropdownMenuSeparator key={e.key} />;
        if (e.kind === 'cap') return <Cap key={e.key}>{e.label}</Cap>;
        if (e.kind === 'note') {
          return (
            <div key={e.key} className="px-2 pb-1.5 pt-2 text-[11px] leading-snug text-muted-foreground">
              {e.text}
            </div>
          );
        }
        return <ValueRow key={e.key} spec={e} />;
      })}
    </>
  );
}

/**
 * A top-level row that opens a submenu, with the current value on its rail.
 *
 * shadcn's SubTrigger appends its own `ChevronRightIcon` with `ml-auto`, so the
 * label takes `flex-1` and the rail lands between them.
 */
function SubRow({ section }: { section: Section }) {
  const Icon = section.icon;
  const body = <MenuEntries entries={section.entries} />;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={cn(ROW, '[&>svg:last-child]:size-3.5')}>
        <Icon className="size-4" />
        <span className={cn('flex-1 truncate', section.set && 'font-semibold')}>{section.label}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{section.rail}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={cn(section.width ?? PANEL, 'shadow-[var(--shadow-elev-md)]')}>
        {section.scroll ? <div className="max-h-64 overflow-y-auto">{body}</div> : body}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/* ── the touch shell ────────────────────────────────────────────────────────*/

function SheetRow({ spec, onDismiss }: { spec: RowSpec; onDismiss: () => void }) {
  const Icon = spec.icon;
  const role = roleOf(spec);
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'menuitem' ? undefined : spec.checked}
      disabled={spec.disabled}
      // Mirrors what Radix stamps on a disabled menu item, so one assertion
      // vocabulary reads both shells.
      data-disabled={spec.disabled ? '' : undefined}
      onClick={() => {
        if (spec.disabled) return;
        spec.onToggle();
        if (!spec.keepOpen) onDismiss();
      }}
      className={cn(
        SHEET_ROW,
        spec.checked && 'font-semibold',
        // --row-selected, not a lime fill: the lime budget is one mark per
        // surface and it is spent on the trigger dot. See mode-switcher-sheet
        // for why this token and not bg-surface-3 (dark mode orders the hover
        // wash above it otherwise).
        spec.checked && !spec.disabled && 'bg-[var(--row-selected)]',
        spec.disabled ? 'opacity-50' : 'hover-wash'
      )}
    >
      {spec.leading}
      {Icon && <Icon className="size-4 shrink-0" />}
      <span className="flex-1 min-w-0">
        <span className="block truncate">{spec.label}</span>
        {spec.hint && (
          <span className="block truncate text-xs font-normal leading-tight text-muted-foreground">
            {spec.hint}
          </span>
        )}
      </span>
      {spec.rail && <span className="shrink-0 text-xs text-muted-foreground">{spec.rail}</span>}
      {/* The sheet's rows are flex children that must not squeeze the check; the
          dropdown's own item already carries `[&_svg]:shrink-0`, so asking for it
          in the shared Tick would put a class in the desktop DOM that this branch
          has no business changing. */}
      <Tick on={spec.checked} className="shrink-0" />
    </button>
  );
}

function SheetEntries({ entries, onDismiss }: { entries: Entry[]; onDismiss: () => void }) {
  return (
    <>
      {entries.map((e) => {
        if (e.kind === 'sep') return <div key={e.key} role="separator" className="my-1 h-px bg-border" />;
        if (e.kind === 'cap') return <div key={e.key} className={SHEET_CAP}>{e.label}</div>;
        if (e.kind === 'note') {
          return (
            <div key={e.key} className="px-3 pb-1 pt-2 text-xs leading-snug text-muted-foreground">
              {e.text}
            </div>
          );
        }
        return <SheetRow key={e.key} spec={e} onDismiss={onDismiss} />;
      })}
    </>
  );
}

/** The drill-in row: the section, its current value, and where tapping goes. */
function SheetSectionRow({ section, onOpen }: { section: Section; onOpen: () => void }) {
  const Icon = section.icon;
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      data-testid={`display-section-${section.id}`}
      onClick={onOpen}
      className={cn(SHEET_ROW, 'hover-wash')}
    >
      <Icon className="size-4 shrink-0" />
      <span className={cn('flex-1 truncate', section.set && 'font-semibold')}>{section.label}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{section.rail}</span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/* ── the menu ───────────────────────────────────────────────────────────────*/

/**
 * What DisplayMenu's `ref` exposes. Call it from handlers only: during render
 * the ref is null on the first pass and a commit behind after that.
 */
export interface DisplayMenuHandle {
  /** Open this surface's menu as if its trigger had been used; `from` gets focus back on close. */
  open(from?: HTMLElement | null): void;
  /** Focus the trigger — where focus goes when the thing that held it is about to unmount. */
  focus(): void;
}

export function DisplayMenu({
  surface,
  trigger = 'label',
  align = 'end',
  scope: scopeProp,
  ref,
}: {
  surface: DisplaySurface;
  /** Labelled pill for the canvas capsule; 24px icon for the braindump header. */
  trigger?: 'label' | 'icon';
  align?: 'start' | 'end';
  /**
   * The scope the MOUNTING SHELL actually renders by, when that is not the
   * store's.
   *
   * Mobile is day-only by construction: MobileViewRouter reads `layout` and
   * hardcodes `data-view-scope="day"` (mobile-view-router.tsx:34), and the
   * palette hides both scope commands there for the same reason
   * (commands/registry.ts:623-626). So the phone states its scope rather than
   * inheriting a preference it never renders by — a stale `scope: 'week'` in the
   * persisted blob would otherwise report Grouping as unavailable on a surface
   * that honours it, with nothing on that surface able to correct it.
   */
  scope?: ViewScope;
  /**
   * A second way in, for the braindump's Display shelf: open this menu from
   * something other than its trigger, and move focus to the trigger before that
   * something goes away.
   *
   * A handle, not a second trigger and not open state lifted into the mount.
   * Radix keeps one trigger ref and one anchor per menu, so a second
   * DropdownMenuTrigger would take both over (and duplicate the trigger's test
   * id). Open state held by the braindump would re-render its whole list on
   * every open and close, and held in a store it would outlive the menu it
   * describes — an armed slot that springs open later is the ui-store bug the
   * Organize console already had to route around. Behind a handle, each shell
   * keeps its open state where it already lives.
   */
  ref?: React.Ref<DisplayMenuHandle>;
}) {
  // The icon trigger's tooltip, and the menu's own open state so the tooltip
  // can stand down while the panel is out — and so the handle below can open
  // the dropdown, which Radix's trigger alone cannot be asked to do. Held here,
  // above the touch branch's early return, so the hook order never depends on
  // the input device.
  const tip = useQuietTip();
  const [menuOpen, setMenuOpen] = useState(false);
  const projects = usePlannerStore((s) => s.projects);
  // Read purely to seed the grouping options' example lines — the Routine and
  // Program group-by values name these, the way Project names `projects`.
  const routines = usePlannerStore((s) => s.routines);
  const programs = usePlannerStore((s) => s.programs);
  const getProjectColor = usePlannerStore((s) => s.getProjectColor);
  const showPausedOnGrid = usePlannerStore((s) => s.showPausedOnGrid);
  const setShowPausedOnGrid = usePlannerStore((s) => s.setShowPausedOnGrid);
  const goals = usePlannerStore((s) => s.goals);
  const goalsAvailable = usePlannerStore((s) => s.goalsAvailable);
  /**
   * Two different questions, and both have to be yes.
   *
   * `goalsAvailable` is "the goals TABLE answered" (migration 036 deployed);
   * `goalsOn` is "this account asked for the idea at all". The first is
   * infrastructure and the second is a choice, so neither stands in for the
   * other — and unlike the availability flag, the gate takes the stranded
   * clause with it: while Goals is off nothing consults `filters.goals`, so a
   * selection left behind by the switch narrows nothing and must not be counted
   * by a trigger that has no row to account for it. See lib/extension-gates.ts.
   */
  const goalsOn = useGoalsEnabled();

  const view = useViewStore();
  const isCanvas = surface === 'canvas';
  /**
   * Which shell. `useIsMobile` is a live matchMedia listener that reports false
   * until its first effect, and both shells wrap the SAME trigger button — so
   * the swap costs no visible flash, only which primitive the trigger opens.
   */
  const isTouch = useIsMobile();

  const filters = isCanvas ? view.canvasFilters : view.braindumpFilters;
  const setFilters = isCanvas ? view.setCanvasFilters : view.setBraindumpFilters;
  // The EFFECTIVE value, not the stored one: a group-by whose extension is off
  // resolves to 'none' here exactly as it does on the surfaces themselves, so
  // the rail, the count and the checkmark all say what the canvas is doing. The
  // stored value survives untouched and comes back with the toggle.
  const canvasGroupByOn = useCanvasGroupBy();
  const braindumpGroupByOn = useBraindumpGroupBy();
  const groupBy: string = isCanvas ? canvasGroupByOn : braindumpGroupByOn;

  const patch = (next: Partial<ViewFilters>) => setFilters({ ...filters, ...next });

  const toggle = <T extends string>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  /* ── what is set ──────────────────────────────────────────────────────── */

  const selectedProjects = namesOfKind(filters.containers, 'project');

  /**
   * The Goal clause's rows, described as DATA before anything draws them.
   *
   * ACTIVE goals (lib/goals.ts `displayGoals`), plus any SELECTED goal that is
   * no longer active — `goalMenuOrder`, the order the braindump's shelf lists
   * them in too — plus a placeholder row for any selected id the store can
   * no longer name at all. None of the three halves is tidiness: this menu's
   * rule is that hiding a row STRANDS the clause — the trigger keeps counting
   * something the panel has nothing to account for — and a goal can leave the
   * active list three ways. It can be achieved or abandoned while it filters
   * (still in the store, `state !== 'active'`); it can be DELETED, which drops
   * it from the store outright; or the goals table can be unreachable this
   * session while a selection sits in the persisted blob. Every one of those
   * leaves an id in `filters.goals` and `activeFilterCount` counting it.
   *
   * A row rather than a store-side sweep, and that is the deliberate half. The
   * `renameContainerRef` precedent (view-store.ts) is DRIVEN BY THE STORE for a
   * reason its own docblock gives: the call-site version had no inverse, so undo
   * restored the container and the clause kept the stale value. Dropping the id
   * on `removeGoal` has the mirror of that bug — undo restores the goal and the
   * clause does not come back — and it cannot reach the third case at all, since
   * a goals table that never loaded fires no delete to subscribe to. An
   * untickable row answers all three with one mechanism and reverses nothing.
   *
   * (The clause degrades to INERT in every one of these states rather than
   * emptying the surface; see `goalFilterItemIds`.)
   *
   * Ids, not names: goal names are not unique and rename shipped with the
   * feature, which is why the container ref grammar excludes goals outright.
   */
  const unknownGoalIds = filters.goals.filter((id) => !goals.some((g) => g.id === id));
  const goalRows: RowSpec[] = [
    ...goalMenuOrder(goals, filters.goals).map((goal: Goal) => ({
      key: goal.id,
      label: goal.name,
      leading: <ContainerSquare color={goal.color ?? accentColorForName(goal.name)} />,
      checked: filters.goals.includes(goal.id),
      keepOpen: true,
      onToggle: () => patch({ goals: toggle(filters.goals, goal.id) }),
    })),
    ...unknownGoalIds.map((id) => ({
      key: id,
      label: UNKNOWN_GOAL_LABEL,
      // The rail says what the row cannot: this id names nothing the store
      // holds. It narrows nothing either way, so the only thing left to do with
      // it is untick it, which this row exists to allow.
      rail: 'not found',
      checked: true,
      keepOpen: true,
      onToggle: () => patch({ goals: toggle(filters.goals, id) }),
    })),
  ];

  /**
   * The count behind the trigger dot and the Reset badge, from the one summary
   * the braindump's shelf renders too — so the dot and the shelf cannot
   * disagree about what is set. What it counts, and why, is in
   * lib/display-summary.ts.
   */
  const { activeCount } = useDisplaySummary(surface);
  // What bolds each section's label — per section, where the count is the sum.
  const typeSet = isCanvas && view.typeFilter !== 'all';
  const groupSet = groupBy !== 'none';
  const sortSet = (isCanvas ? view.canvasSortBy : view.braindumpSortBy) !== 'default';

  /** Both shells' Reset row: the function the shelf's ✕ calls, not a copy of it. */
  const reset = () => resetDisplay(surface);

  /* ── grouping ─────────────────────────────────────────────────────────── */

  const scope = scopeProp ?? view.scope;

  /**
   * The Grouping row ALWAYS renders on the canvas; individual values disable
   * themselves where the current view cannot honour them.
   *
   * It used to hide the whole section on Schedule and Week, which had two
   * failures. Neither `setScope` nor `setLayout` clears `canvasGroupBy`
   * (view-store.ts:154-167), so grouping on Day × List and then switching to
   * Schedule left the trigger counting a clause with no row to account for it —
   * "Display (1 active)" over a panel where nothing is set. And a menu whose
   * sections appear and vanish as you switch layouts is harder to learn than one
   * whose rows explain themselves, which is the grammar this menu already uses
   * for values inside Buckets.
   */
  // The Goal value is NOT OFFERED while Goals is off, which is the one place
  // this menu drops a row rather than disabling it. A disabled row states a
  // reason about THIS SURFACE ("Already by bucket", "List only") and invites you
  // to switch layout; "your account does not have this feature" is a different
  // sentence, and its home is the extension's own settings pane — where the row
  // still is, because off means inert rather than gone.
  const groupOptions = (isCanvas ? CANVAS_GROUP_BY_OPTIONS : BRAINDUMP_GROUP_BY_OPTIONS).filter(
    (o) => o.value !== 'goal' || goalsOn
  );
  const groupLabel = groupOptions.find((o) => o.value === groupBy)?.label ?? 'None';

  /**
   * A couple of live examples per group-by value, so "Project" reads with the
   * user's own "Work, Personal…" beneath it and a stranger to the menu can tell
   * what a dimension would carve their day into before they pick it.
   *
   * The names come from the SAME sources the grouping itself reads, so the
   * examples match the sections that appear: container lists off the store,
   * Goals filtered to active by `displayGoals`, and the two static axes from
   * their canonical constants. `type` mirrors the braindump's fixed two sections
   * (braindump.tsx). Capped at two — illustrative, not a legend — and absent
   * (no second line) when a dimension has nothing to name yet, e.g. no routines.
   */
  const previewNames = (names: string[]): string | undefined => {
    const clean = names.map((n) => n.trim()).filter(Boolean);
    if (clean.length === 0) return undefined;
    const shown = clean.slice(0, 2).join(', ');
    return clean.length > 2 ? `${shown}…` : shown;
  };
  const groupExamples: Partial<Record<string, string | undefined>> = {
    project: previewNames(projects.map((p) => p.name)),
    priority: previewNames(['High', 'Medium', 'Low']),
    bucket: previewNames(BUCKET_ORDER.map((b) => TIME_BUCKET_RANGES[b].label)),
    routine: previewNames(routines.map((r) => r.name)),
    program: previewNames(programs.map((p) => p.name)),
    goal: previewNames(displayGoals(goals).map((g) => g.name)),
    // The braindump splits its corpus into exactly these two — see braindump.tsx.
    type: 'Tasks, Habits',
  };
  /** How far the CURRENT value reaches on this surface — see groupBySupport. */
  const groupReach = isCanvas
    ? groupBySupport(scope, view.layout, groupBy as GroupBy)
    : { honoured: true, note: null };

  const sortBy = isCanvas ? view.canvasSortBy : view.braindumpSortBy;
  const sortLabel = SORT_BY_OPTIONS.find((o) => o.value === sortBy)?.label ?? 'Default';
  const sortBlocked = isCanvas ? sortByBlockedBy(view.layout, sortBy) : null;

  /** The one-tier-down escape offered while the current value is inert. */
  const switchToList = (key: string): Entry[] => [
    { kind: 'sep', key: `${key}-sep` },
    rowEntry({
      key: `${key}-switch`,
      icon: ArrowRight,
      label: 'Switch to List',
      checked: false,
      keepOpen: false,
      action: true,
      onToggle: () => view.setLayout('list'),
    }),
  ];

  /* ── the sections, in render order ────────────────────────────────────── */

  const structure: Section[] = [
    {
      id: 'grouping',
      icon: Rows3,
      label: 'Grouping',
      // The rail carries the note whether the value is partly honoured or not
      // at all, so the row always accounts for the clause the trigger is
      // counting.
      rail: groupReach.note ? `${groupLabel} · ${groupReach.note}` : groupLabel,
      set: groupSet,
      entries: [
        ...groupOptions.map((o) => {
          // Three states: honoured silently, honoured with the part it reaches
          // on the rail, or inert — visible and disabled with the reason.
          const reach = isCanvas
            ? groupBySupport(scope, view.layout, o.value as GroupBy)
            : { honoured: true, note: null };
          return rowEntry({
            key: o.value,
            icon: o.icon,
            label: o.label,
            hint: groupExamples[o.value],
            rail: reach.note ?? undefined,
            disabled: !reach.honoured,
            checked: groupBy === o.value,
            keepOpen: false,
            onToggle: () =>
              isCanvas
                ? view.setCanvasGroupBy(o.value as GroupBy)
                : view.setBraindumpGroupBy(o.value as BraindumpGroupBy),
          });
        }),
        // The escape hatch, offered only while the CURRENT value is inert —
        // which since Phase 5a is one combination, Time bucket on Buckets. It
        // used to ride every non-List layout, i.e. most of the time, where it
        // resolved nothing because nothing was blocked.
        ...(isCanvas && !groupReach.honoured && view.layout !== 'list'
          ? switchToList('grouping')
          : []),
      ],
    },
    {
      id: 'ordering',
      icon: ArrowUpDown,
      label: 'Ordering',
      rail: sortBlocked ? `${sortLabel} · ${sortBlocked}` : sortLabel,
      set: sortSet,
      entries: [
        ...SORT_BY_OPTIONS.map((o) => {
          const blocked = isCanvas ? sortByBlockedBy(view.layout, o.value) : null;
          return rowEntry({
            key: o.value,
            icon: o.icon,
            label: o.label,
            rail: blocked ?? undefined,
            disabled: !!blocked,
            checked: sortBy === o.value,
            keepOpen: false,
            onToggle: () =>
              isCanvas ? view.setCanvasSortBy(o.value) : view.setBraindumpSortBy(o.value),
          });
        }),
        ...(isCanvas && view.layout !== 'list' ? switchToList('ordering') : []),
      ],
    },
  ];

  const filterSections: Section[] = [
    // Type is canvas-only: the braindump's corpus is single-type today, and
    // grouping by Type already answers "what is in here" at that size.
    ...(isCanvas
      ? [
          {
            id: 'type',
            icon: Hash,
            label: 'Type',
            rail: TYPE_OPTIONS.find((o) => o.value === view.typeFilter)?.label ?? 'All',
            set: typeSet,
            entries: TYPE_OPTIONS.map((o) =>
              rowEntry({
                key: o.value,
                icon: o.icon,
                label: o.label,
                checked: view.typeFilter === o.value,
                keepOpen: false,
                onToggle: () => view.setTypeFilter(o.value),
              })
            ),
          } satisfies Section,
        ]
      : []),
    {
      id: 'priority',
      icon: Flag,
      label: 'Priority',
      rail: priorityRail(filters.priorities),
      set: filters.priorities.length > 0,
      width: 'w-56',
      entries: [
        ...(['high', 'medium', 'low'] as Priority[]).map((p) =>
          rowEntry({
            key: p,
            leading: <PriorityDot value={p} />,
            label: priorityFilterLabel(p),
            checked: filters.priorities.includes(p),
            keepOpen: true,
            onToggle: () => patch({ priorities: toggle(filters.priorities, p) }),
          })
        ),
        { kind: 'sep', key: 'priority-sep' },
        // An item carrying the field with the value UNSET belongs in an
        // explicit value, not in oblivion. Most items have no priority.
        rowEntry({
          key: NO_PRIORITY,
          leading: <PriorityDot value={NO_PRIORITY} />,
          label: priorityFilterLabel(NO_PRIORITY),
          checked: filters.priorities.includes(NO_PRIORITY),
          keepOpen: true,
          onToggle: () => patch({ priorities: toggle(filters.priorities, NO_PRIORITY) }),
        }),
        {
          kind: 'note',
          key: 'priority-note',
          text: 'Habits carry no priority — they are unaffected.',
        },
      ],
    },
    {
      id: 'container',
      icon: Folder,
      // The noun has one home — see CONTAINER_KINDS.project. This section was
      // "Project / Group" and drew the one question as two capped lists, which
      // is exactly the distinction migration 039 removed.
      label: CONTAINER_KINDS.project.label,
      rail: containerRail(filters.containers),
      set: filters.containers.length > 0,
      // Values are still stored PREFIXED (`project:Work`). Not because a second
      // namespace exists any more, but because these keys share a keyspace with
      // `priority:high` and `goal:none` — see the ref grammar in
      // lib/container-registry.ts.
      //
      // The only section whose length is the user's own data, which is what
      // decides the touch shell for the whole menu — see the header.
      scroll: true,
      entries: [
        ...projects.map((p) => {
          const ref = containerRef('project', p.name);
          return rowEntry({
            key: ref,
            leading: <ContainerSquare color={getProjectColor(p.name)} />,
            label: p.name,
            // Folded, because the axis folds (`CONTAINER_KINDS.project.caseFold`)
            // — a habit stored as 'personal' must tick the 'Personal' row.
            checked: selectedProjects.some((n) => sameContainerName('project', n, p.name)),
            keepOpen: true,
            onToggle: () => patch({ containers: toggle(filters.containers, ref) }),
          });
        }),
        ...(projects.length > 0 ? [{ kind: 'sep', key: 'none-sep' } satisfies Entry] : []),
        // itemFromRow maps an unset container to '' (db.ts), so this is a real
        // reachable value rather than a theoretical one.
        rowEntry({
          key: NO_CONTAINER,
          leading: <PriorityDot value={NO_PRIORITY} />,
          label: CONTAINER_KINDS.project.unsetLabel!,
          checked: filters.containers.includes(NO_CONTAINER),
          keepOpen: true,
          onToggle: () => patch({ containers: toggle(filters.containers, NO_CONTAINER) }),
        }),
      ],
    },
    // GOAL — the aspire axis, and the one filter here that is not a partition.
    // An item can serve three goals at once, so this narrows by MEMBERSHIP
    // rather than by an answer the item carries: every selected goal's members,
    // milestones and check-ins, unioned.
    //
    // No "No goal" value, unlike Project / Group. The classify axis has an unset
    // state (an item carries `project`, possibly empty); the aspire axis has
    // none — `unsetLabel` is null in the container registry because an item
    // serves a goal or it does not — and a checkbox for "everything that serves
    // nothing" is a different question from the one this section asks. Grouping
    // still mints a loose "No goal" section, because grouping may never drop a
    // row.
    //
    // Gated on `goalsAvailable`, not on `goals.length`: the flag is the
    // table-unreachable signal, and the item dialog's chip renders from zero for
    // a reason this section does not share — it is a DOOR to the manager, and a
    // filter is not. With zero goals the panel says so. The `||` is the stranded
    // clause again: an unreachable table must not take the only row that can
    // clear a selection down with it.
    //
    // AND GATED ON THE EXTENSION, which is a stronger cut than either of the
    // two above: with Goals off there is no clause to clear, because nothing
    // consults `filters.goals` at all (hooks/use-day-items.ts, braindump.tsx).
    // A stranded selection is therefore already inert — it hides no row — so
    // the section that exists to clear one has nothing left to do, and the
    // trigger's count leaves it out to match.
    ...(goalsOn && (goalsAvailable || filters.goals.length > 0)
      ? [
          {
            id: 'goal',
            icon: Target,
            label: 'Goal',
            rail: goalRail(filters.goals, goals),
            set: filters.goals.length > 0,
            // Like `container`, and for the same reason: its length is the
            // user's own data. The dropdown scrolls it; the sheet drills into it.
            scroll: true,
            entries: [
              ...goalRows.map(rowEntry),
              // A `note` entry, not a bare <div> under the rows — the sheet
              // renders `Section.entries` and nothing else, so anything that is
              // not an Entry simply does not exist on a phone.
              {
                kind: 'note',
                key: 'goal-note',
                text:
                  goalRows.length === 0
                    ? 'No goals yet — make one in Organize.'
                    : 'Milestones and check-ins count as members.',
              } satisfies Entry,
              ...(unknownGoalIds.length > 0
                ? [
                    {
                      kind: 'note',
                      key: 'goal-unknown-note',
                      text: 'A goal that is gone narrows nothing — untick it to clear the clause.',
                    } satisfies Entry,
                  ]
                : []),
            ],
          } satisfies Section,
        ]
      : []),
  ];

  /** Everything below the Filter sections, which is flat in both shells. */
  const showEntries: Entry[] = [
    { kind: 'cap', key: 'show-cap', label: 'Show' },
    rowEntry({
      key: 'hide-finished',
      icon: Eye,
      label: 'Hide finished',
      checked: filters.hideFinished,
      keepOpen: true,
      onToggle: () => patch({ hideFinished: !filters.hideFinished }),
    }),
    // Captioned "Everywhere" because it is exactly that: a planner-store
    // setting every canvas surface reads, not a preference of this one.
    ...(isCanvas
      ? [
          { kind: 'cap', key: 'everywhere-cap', label: 'Everywhere' } satisfies Entry,
          rowEntry({
            key: 'show-paused',
            icon: Moon,
            label: 'Show paused',
            checked: showPausedOnGrid,
            keepOpen: true,
            onToggle: () => setShowPausedOnGrid(!showPausedOnGrid),
          }),
        ]
      : []),
  ];

  /* ── opening, from the trigger or through the handle ──────────────────── */

  /** The one trigger button, in either shell; Radix's Slot composes this with its own ref. */
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** Whatever opened the menu when the trigger did not — focus goes back to it on close. */
  const returnTo = useRef<HTMLElement | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      open: (from) => {
        if (isTouch) {
          // Through vaul's OWN trigger, the sheet's one opening path: that is
          // where vaul records the sheet as opened (its scroll lock and Safari
          // fix key off it) and where DisplaySheet resets its drilled pane. A
          // click, because a Drawer trigger opens on click.
          triggerRef.current?.click();
          // Set AFTER the click, whose opening edge clears it.
          returnTo.current = from ?? null;
        } else {
          // Radix's dropdown trigger opens on pointerdown and on keys, never on
          // click, so this shell opens through its state instead.
          returnTo.current = from ?? null;
          setMenuOpen(true);
        }
      },
      focus: () => triggerRef.current?.focus(),
    }),
    [isTouch]
  );

  /**
   * Both shells' close: focus goes back to whatever opened the menu, if it is
   * still on the page. Otherwise the default runs, and that is Radix sending it
   * to the trigger.
   */
  const restoreFocus = (e: Event) => {
    const el = returnTo.current;
    returnTo.current = null;
    if (el?.isConnected) {
      e.preventDefault();
      el.focus();
    }
  };

  /**
   * Both dropdowns' open state, as Radix reports it. Radix reports an opening
   * only when its own trigger did it, and then nothing else is waiting for
   * focus back; the handle opens through the state, which Radix does not report.
   */
  const onMenuOpenChange = (next: boolean) => {
    if (next) returnTo.current = null;
    setMenuOpen(next);
  };

  /* ── trigger ──────────────────────────────────────────────────────────── */

  const dot = activeCount > 0 && (
    // No transition. `transition-opacity` on the wrapper would fade lime, and
    // lime never fades — it is the one mark this surface is allowed.
    <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" aria-hidden="true" />
  );

  const ariaLabel = activeCount > 0 ? `Display (${activeCount} active)` : 'Display';

  // One button, whichever shell opens around it — the mounts size it from
  // outside (mobile-header grows the icon trigger to its 30px row slot), so it
  // must not change shape with the input device either.
  const triggerButton =
    trigger === 'label' ? (
      <button
        ref={triggerRef}
        aria-label={ariaLabel}
        data-testid={`display-trigger-${surface}`}
        data-active={activeCount > 0 ? 'true' : 'false'}
        className={cn(
          'relative inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent',
          activeCount > 0 && 'bg-accent/60'
        )}
      >
        <SlidersHorizontal className="size-4" />
        Display
        <ChevronDown className="size-3.5 text-muted-foreground" />
        {dot}
      </button>
    ) : (
      <button
        ref={triggerRef}
        aria-label={ariaLabel}
        data-testid={`display-trigger-${surface}`}
        data-active={activeCount > 0 ? 'true' : 'false'}
        className={cn(
          'relative inline-flex size-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          activeCount > 0 && 'text-foreground'
        )}
      >
        <SlidersHorizontal className="size-4" />
        {dot}
      </button>
    );

  if (isTouch) {
    return (
      <DisplaySheet
        trigger={triggerButton}
        structure={structure}
        filterSections={filterSections}
        showEntries={showEntries}
        activeCount={activeCount}
        reset={reset}
        onOpening={() => {
          returnTo.current = null;
        }}
        onCloseAutoFocus={restoreFocus}
      />
    );
  }

  const menuContent = (
    <DropdownMenuContent
      align={align}
      className={PANEL}
      data-testid="display-menu"
      data-display-variant="menu"
      onCloseAutoFocus={restoreFocus}
      // Mirror Radix's own rule: a right- or ctrl-click outside leaves focus
      // where it lands, so it is not pulled back to the opener either.
      onInteractOutside={(e) => {
        const o = e.detail.originalEvent as PointerEvent;
        if (o.button === 2 || (o.button === 0 && o.ctrlKey)) returnTo.current = null;
      }}
    >
      <Cap>Structure</Cap>
      {structure.map((s) => (
        <SubRow key={s.id} section={s} />
      ))}
      <DropdownMenuSeparator />

      <Cap>Filter</Cap>
      {filterSections.map((s) => (
        <SubRow key={s.id} section={s} />
      ))}

      <MenuEntries entries={showEntries} />

      <PausedScopesSection variant="menu" />

      <DropdownMenuSeparator />
      {/* Permanently mounted, disabled when nothing is set. That is what stops
          the panel jumping height, which today's conditionally-mounted "Clear
          filters" does on the first tick — and it is a view preference, so it
          loses the destructive red styling with it. */}
      <DropdownMenuItem
        className={cn(ROW, 'text-muted-foreground')}
        disabled={activeCount === 0}
        onSelect={() => reset()}
        data-testid="display-reset"
      >
        <RotateCcw className="size-4" />
        <span className="flex-1">Reset display</span>
        {activeCount > 0 && (
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums">{activeCount}</span>
        )}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  // The icon trigger is a bare glyph, so on a pointer it gets the rail tooltip
  // every header control wears. The label trigger says "Display" already.
  //
  // Nesting order is load-bearing: the MENU trigger is the outer one. Both
  // stamp `data-state`, and Radix hands the outer trigger's props to the inner
  // one, which spreads them over its own — tooltip-outside, the button would
  // report the tooltip's closed/delayed-open instead of the menu's open/closed.
  if (trigger === 'icon') {
    return (
      <Tooltip open={tip.open && !menuOpen} onOpenChange={tip.onOpenChange}>
        <DropdownMenu
          open={menuOpen}
          onOpenChange={(next) => {
            onMenuOpenChange(next);
            // Put the tooltip down on BOTH edges. Opening, the menu trigger's
            // pointerdown preventDefaults and so skips the tooltip's own close;
            // while the menu is out the tooltip is held shut by the prop, and a
            // controlled Radix root never reports a close it is already showing.
            // Left alone, tip.open stays true and the tooltip springs back the
            // moment the menu closes, wherever the pointer went. The hover is
            // forgotten too: the pointer went into the menu, and the focus the
            // menu hands back on close must pass the keyboard test on its own.
            tip.reset();
          }}
        >
          <DropdownMenuTrigger asChild>
            <TooltipTrigger asChild {...tip.triggerProps}>
              {triggerButton}
            </TooltipTrigger>
          </DropdownMenuTrigger>
          <RailTipContent
            side="bottom"
            label="Display"
            detail={
              activeCount > 0 ? `${activeCount} active · Filter, group & sort` : 'Filter, group & sort'
            }
          />
          {menuContent}
        </DropdownMenu>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
      <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
      {menuContent}
    </DropdownMenu>
  );
}

/**
 * The touch shell: one bottom sheet, two levels.
 *
 * The root is the dropdown's own top level — the same sections in the same
 * order, each showing what it is currently set to — and tapping one replaces
 * the sheet's body with that section, titled, with a back affordance where a
 * submenu would have had nothing. Nothing about WHAT a row does changes here;
 * only how you reach it.
 *
 * Pane state lives in the sheet rather than in a store: it is not a preference,
 * it is where you are standing inside a control that is currently open, and it
 * must not survive the sheet being dismissed. A drilled pane belongs to ONE
 * opening, and it is reset when the NEXT one begins — see the handler below for
 * why the close edge is the wrong one on both counts.
 */
function DisplaySheet({
  trigger,
  structure,
  filterSections,
  showEntries,
  activeCount,
  reset,
  onOpening,
  onCloseAutoFocus,
}: {
  trigger: React.ReactNode;
  structure: Section[];
  filterSections: Section[];
  showEntries: Entry[];
  activeCount: number;
  reset: () => void;
  /** Called on the opening edge, beside the pane reset — every opening passes it. */
  onOpening?: () => void;
  /** Where focus goes as the sheet closes; handed through vaul to Radix's Dialog. */
  onCloseAutoFocus?: (e: Event) => void;
}) {
  const [open, setOpen] = useState(false);
  const [paneId, setPaneId] = useState<string | null>(null);
  const dismiss = () => setOpen(false);

  const paneRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  /** What the focus effect below compares against; see it for why. */
  const lastPane = useRef<string | null>(null);

  const pane =
    [...structure, ...filterSections].find((s) => s.id === paneId) ?? null;

  /**
   * Focus follows the drill, in both directions.
   *
   * Every one of these transitions unmounts the button that was pressed, and a
   * focused element that unmounts leaves focus on `<body>` — arrows, tab order
   * and a screen reader's reading cursor all restart from the top of the
   * document. The desktop submenu gets this from Radix; the sheet has to do it
   * by hand. It is not a touch-only nicety: `useIsMobile` is viewport-based, so
   * any window under 768px reaches this shell with a physical keyboard.
   *
   * In an effect rather than in the handlers because the element to focus does
   * not exist until the new level has rendered. The first open is skipped —
   * vaul's `autoFocus` owns that one.
   */
  useEffect(() => {
    const previous = lastPane.current;
    lastPane.current = paneId;
    if (!open || previous === paneId) return;
    if (paneId) {
      // The pane's first row, or the way back if it somehow has none.
      const first = paneRef.current?.querySelector<HTMLElement>(
        '[role="menuitem"]:not([disabled]),[role="menuitemcheckbox"]:not([disabled]),[role="menuitemradio"]:not([disabled])'
      );
      (first ?? backRef.current)?.focus();
    } else if (previous) {
      // Back lands on the row you came from, not on the top of the list.
      paneRef.current
        ?.querySelector<HTMLElement>(`[data-testid="display-section-${previous}"]`)
        ?.focus();
    }
  }, [paneId, open]);

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reset on the OPENING edge, not the closing one. Two reasons, and the
        // close edge fails both. `open` is controlled here, so vaul calls this
        // back only for its OWN dismissals — escape, backdrop, swipe — and every
        // close the sheet performs itself (a single-select pick, "Switch to
        // List", Reset) goes through setOpen and would skip a reset written
        // here. And the close edge is the wrong edge anyway: the sheet is still
        // sliding out, so clearing there swaps the body under the exit
        // animation. Opening is one path, vaul's own trigger, and this lands in
        // the same batch as `setOpen(true)` — the first frame of the new sheet
        // is already the root, whichever way the last one closed. The
        // braindump's Display shelf opens the sheet by clicking that same
        // trigger, through DisplayMenu's handle, so it comes this way too.
        if (next) {
          setPaneId(null);
          // The focus effect would otherwise read the last opening's pane as a
          // change and pull focus onto a section row behind vaul's own.
          lastPane.current = null;
          onOpening?.();
        }
      }}
      // vaul defaults autoFocus to false, which leaves focus on the trigger
      // while the app root is aria-hidden around it — the same trap
      // mode-switcher-sheet documents. This sheet is the only route to grouping
      // and filtering on a phone.
      autoFocus
    >
      <DrawerTrigger asChild>{trigger}</DrawerTrigger>

      <DrawerContent
        data-testid="display-menu"
        data-display-variant="sheet"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DrawerHeader className="pb-1">
          <div className="flex items-center gap-1">
            {pane && (
              <button
                type="button"
                ref={backRef}
                data-testid="display-back"
                aria-label="Back to Display"
                onClick={() => setPaneId(null)}
                className="hover-wash -ml-1 flex size-11 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground"
              >
                <ChevronLeft className="size-5" />
              </button>
            )}
            <DrawerTitle className="text-left text-base">{pane ? pane.label : 'Display'}</DrawerTitle>
          </div>
          <DrawerDescription className="sr-only">
            {pane
              ? `Choose a value for ${pane.label}.`
              : 'Grouping, ordering and filters for this surface.'}
          </DrawerDescription>
        </DrawerHeader>

        {/* A plain overflow container, never <ScrollArea> — the Radix wrapper
            silently drops a height cap (CLAUDE.md), and this is the one box in
            the sheet that has to honour one: DrawerContent caps at 80vh and the
            Project / Group pane is as long as the user's data. */}
        {/* `group`, not `menu`. A row's ROLE says what the row means and is shared
            with the model (see the header), but a `menu` CONTAINER also promises a
            keyboard contract — roving tabindex, arrow wrap, Home/End, typeahead —
            that Radix implements for the dropdown and this shell does not. Claiming
            it flips a screen reader into application mode, where the arrows it has
            just been told to use do nothing. `group` is the honest container for a
            set of rows whose item roles still carry their meaning: browse mode
            stays on, the arrows keep working, and every row is a real button in the
            tab order. If this shell ever grows roving focus, this becomes `menu`
            again in the same commit. */}
        <div
          role="group"
          aria-label={pane ? pane.label : 'Display'}
          ref={paneRef}
          data-testid="display-sheet-pane"
          data-pane={pane ? pane.id : 'root'}
          className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]"
        >
          {pane ? (
            <SheetEntries entries={pane.entries} onDismiss={dismiss} />
          ) : (
            <>
              <div className={SHEET_CAP}>Structure</div>
              {structure.map((s) => (
                <SheetSectionRow key={s.id} section={s} onOpen={() => setPaneId(s.id)} />
              ))}
              <div role="separator" className="my-1 h-px bg-border" />

              <div className={SHEET_CAP}>Filter</div>
              {filterSections.map((s) => (
                <SheetSectionRow key={s.id} section={s} onOpen={() => setPaneId(s.id)} />
              ))}

              <SheetEntries entries={showEntries} onDismiss={dismiss} />

              <PausedScopesSection variant="sheet" onDismiss={dismiss} />

              <div role="separator" className="my-1 h-px bg-border" />
              <button
                type="button"
                role="menuitem"
                data-testid="display-reset"
                data-disabled={activeCount === 0 ? '' : undefined}
                disabled={activeCount === 0}
                onClick={() => {
                  reset();
                  dismiss();
                }}
                className={cn(
                  SHEET_ROW,
                  'text-muted-foreground',
                  activeCount === 0 ? 'opacity-50' : 'hover-wash'
                )}
              >
                <RotateCcw className="size-4 shrink-0" />
                <span className="flex-1">Reset display</span>
                {activeCount > 0 && (
                  <span className="shrink-0 font-mono text-xs tabular-nums">{activeCount}</span>
                )}
              </button>
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * The recovery half of "group by scope, flip the header": the scopes that are
 * OFF right now, each one click from back on.
 *
 * A gate container's home when it has no visible members — a fully-paused
 * routine, or an out-of-season program, produces no group header to switch, so
 * without this list it would only be reachable from the Organize console. Shown
 * on BOTH surfaces because pausing is app-wide DB state, and hidden entirely
 * when nothing is off.
 *
 * "Off" means the container's OWN switch is off (`!localOn`): a routine a program
 * is merely holding down keeps its own switch on and is not listed here — the
 * blocking PROGRAM is, and turning it on brings the routine back. Mounted inside
 * the open menu or sheet, so buildScopeRows only runs while one is on screen.
 */
function PausedScopesSection({
  variant,
  onDismiss,
}: {
  variant: 'menu' | 'sheet';
  onDismiss?: () => void;
}) {
  const routines = usePlannerStore((s) => s.routines);
  const programs = usePlannerStore((s) => s.programs);
  const userTimezone = usePlannerStore((s) => s.userTimezone);

  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Resolved at today and used as a memo key — pausing is dateless, and a menu
  // opened after midnight must offer the resume that is true now.
  const todayStr = toDateStr(new Date(), tz);
  const offRows = useMemo(
    () => buildScopeRows(routines, programs, todayStr, tz).filter((row) => !row.localOn),
    [routines, programs, todayStr, tz]
  );

  if (offRows.length === 0) return null;

  const entries: Entry[] = [
    { kind: 'cap', key: 'paused-cap', label: 'Paused scopes' },
    ...offRows.map((row) =>
      rowEntry({
        key: `${row.kind}:${row.id}`,
        leading: (
          <CategoryIcon
            glyph={row.icon}
            name={row.name}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        ),
        label: row.name,
        // The rail's own line — "back Sep 8", "you turned it off", "ended Jul 31".
        rail: row.state,
        // An ACTION, not a value: role=menuitem so a screen reader announces
        // "turn on <name>" rather than a check box that can never read checked
        // (turning it on drops the row from the !localOn list). keepOpen keeps
        // the surface up so a POINTER user can bring several back without
        // reopening — keyboard focus still resets as each row unmounts, so it is
        // not a keyboard "several in a row" affordance.
        checked: false,
        action: true,
        keepOpen: true,
        onToggle: () => setGateOn(row.kind, row.id, true),
      })
    ),
  ];

  return variant === 'menu' ? (
    <MenuEntries entries={entries} />
  ) : (
    <SheetEntries entries={entries} onDismiss={onDismiss ?? (() => {})} />
  );
}

/** "Any" · the single value's name · the count. */
function priorityRail(values: PriorityFilterValue[]): string {
  if (values.length === 0) return 'Any';
  if (values.length === 1) {
    const v = values[0];
    return v === NO_PRIORITY ? 'None' : v[0].toUpperCase() + v.slice(1);
  }
  return String(values.length);
}

/**
 * "Any" · the single goal's NAME · the count.
 *
 * Resolved against the store because the clause holds ids. A selected id that
 * names no goal at all (deleted, or a goals table that never loaded) falls back
 * to the count, which is the honest answer — the rail cannot name what is gone,
 * and the section's "Unknown goal" row is what clears it.
 */
function goalRail(ids: string[], goals: readonly Goal[]): string {
  if (ids.length === 0) return 'Any';
  if (ids.length === 1) return goals.find((g) => g.id === ids[0])?.name ?? '1';
  return String(ids.length);
}

function containerRail(values: string[]): string {
  if (values.length === 0) return 'Any';
  if (values.length === 1) {
    const v = values[0];
    return v === NO_CONTAINER ? 'None' : v.slice(v.indexOf(':') + 1);
  }
  return String(values.length);
}
