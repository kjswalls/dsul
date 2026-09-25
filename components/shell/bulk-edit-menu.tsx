'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bell,
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  Flag,
  Folder,
  Layers,
  Minus,
  SlidersHorizontal,
  Target,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { ContainerSquare } from '@/components/primitives/display-menu';
import { ColorSquare } from '@/components/planner/surface';
import { usePlannerStore } from '@/lib/planner-store';
import { useGoalsEnabled } from '@/lib/extension-gates';
import { goalItemIds } from '@/lib/goals';
import { membershipSummary } from '@/lib/item-bands';
import { CONTAINER_KINDS, foldContainerName } from '@/lib/container-registry';
import {
  canBulkClearProject,
  canBulkCollect,
  canBulkSetPriority,
  canBulkSetProject,
  canBulkSetReminder,
  reminderNeedsDate,
} from '@/lib/bulk-edit';
import { accentColorForName } from '@/lib/accent-colors';
import type { Item, Priority } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * The multiselect bar's Edit menu — the item dialog's property chips, applied
 * to a whole selection.
 *
 * Two shells, split the way the sidebar's Display menu splits
 * (components/primitives/display-menu.tsx): a POINTER gets a dropdown whose
 * property rows open flyouts on hover, matching that menu; TOUCH gets one
 * Popover drilled IN PLACE (a root list, then one property's pane with Back),
 * because a hover submenu opens off-screen or under the thumb on a phone. Both
 * draw the same option descriptions (`optionsFor`), so they cannot drift.
 *
 * Every row answers to lib/bulk-edit.ts for its eligible subset — the same
 * predicate the store verb filters by, so the " · n" beside a row is exactly
 * how many items the verb may touch. A row nothing in the selection can take
 * is hidden, not disabled, and the whole button goes when no row is left.
 *
 * The selection SURVIVES an edit (like Complete), so several properties can be
 * set in a row; each is still one store action ⇒ one ⌘/Ctrl+Z.
 */

type PaneKey = 'priority' | 'remind' | 'project' | 'routine' | 'program' | 'goal';
type Membership = 'none' | 'some' | 'all';

const PRIORITY_ORDER = ['none', 'low', 'medium', 'high'] as const;
const PRIORITY_LABELS: Record<Priority | 'none', string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const MIXED = 'Mixed';

/**
 * The root row's value: the one value every item shares, nothing when they
 * share "unset", and "Mixed" otherwise. `key` is the comparison, `show` what
 * is printed — they differ for a container name, which compares folded.
 */
function sharedSummary<T>(
  items: readonly Item[],
  read: (i: Item) => T | undefined,
  key: (v: T) => string = String,
  show: (v: T) => string = String,
): string | undefined {
  if (items.length === 0) return undefined;
  const first = read(items[0]);
  const firstKey = first === undefined ? undefined : key(first);
  for (const item of items) {
    const v = read(item);
    if ((v === undefined ? undefined : key(v)) !== firstKey) return MIXED;
  }
  return first === undefined ? undefined : show(first);
}

/** Many-valued memberships: the containers EVERY item is in, or "Mixed". */
function membershipRowSummary<C extends { name: string }>(
  containers: readonly C[],
  state: (c: C) => Membership,
): string | undefined {
  const states = containers.map((c) => [c, state(c)] as const);
  if (states.some(([, s]) => s === 'some')) return MIXED;
  return membershipSummary(states.filter(([, s]) => s === 'all').map(([c]) => c.name));
}

const optionClass = cn(
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs',
  'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none'
);

const sectionClass = 'px-2 pb-1 pt-1.5 text-2xs uppercase tracking-wide text-muted-foreground';

/** " · 3" — only when the row reaches fewer than the whole selection. */
function EligibleCount({ n, of }: { n: number; of: number }) {
  return n < of ? <span className="text-muted-foreground">· {n}</span> : null;
}

/**
 * One option in a property's pane, described once and drawn by either shell.
 * `checked: 'mixed'` is the membership panes' middle state: a selection is
 * rarely all-in or all-out of a container, and a plain checkbox would have to
 * lie about it. Picking a tri-state row with `all` clears the whole selection
 * out; anything less collects the whole selection in. That asymmetry is
 * deliberate — the menu is reached from a selection you just made, so the
 * intent is nearly always "put these there", and only the already-satisfied
 * case can safely mean the opposite.
 */
type OptionSpec = {
  key: string;
  label: string;
  role: 'menuitemradio' | 'menuitemcheckbox';
  checked: boolean | 'mixed';
  testId: string;
  data?: Record<string, string>;
  leading?: ReactNode;
  trailing?: ReactNode;
  muted?: boolean;
  keepOpen?: boolean;
  onSelect: () => void;
};

/** The desktop row and panel: the sidebar Display menu's own. */
const MENU_ROW = 'h-8 gap-2 rounded-[5px] px-2 text-xs';
const PANEL = 'w-60 rounded-[10px] p-1 shadow-[var(--shadow-elev-md)]';

/** A trailing check for all, a dash for some — the house selection grammar. */
function OptionBody({ o }: { o: OptionSpec }) {
  return (
    <>
      {o.leading}
      <span className="truncate">{o.label}</span>
      {o.trailing}
      <span className="ml-auto flex size-3.5 shrink-0 items-center justify-center">
        {o.checked === true && <Check className="size-3.5" />}
        {o.checked === 'mixed' && <Minus className="size-3.5 text-muted-foreground" />}
      </span>
    </>
  );
}

/**
 * The Remind pane, the one pane that is a form rather than a list. In the
 * desktop flyout it sits inside a Radix menu, which claims Tab and every
 * printable key (typeahead) at the content, so the wrapper keeps key events
 * from bubbling out: the field owns its keys, and Tab reaches Apply.
 */
function RemindPane({
  value,
  onChange,
  undated,
  anySet,
  onApply,
  onClear,
}: {
  value: string;
  onChange: (v: string) => void;
  undated: number;
  anySet: boolean;
  onApply: () => void;
  onClear: () => void;
}) {
  return (
    <div role="group" aria-label="Reminder" onKeyDown={(e) => {
        // Escape still closes, and ArrowLeft off the buttons still steps back
        // to the trigger; inside the field the arrows belong to the time.
        if (e.key === 'Escape') return;
        if (e.key === 'ArrowLeft' && (e.target as HTMLElement).tagName !== 'INPUT') return;
        e.stopPropagation();
      }}
    >
      <div className={sectionClass}>Nudge me at</div>
      <div className="flex gap-1 px-2 pb-2">
        <Input
          type="time"
          value={value}
          data-testid="bulk-remind-time"
          aria-label="Reminder time"
          className="h-8 flex-1 text-sm"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onApply();
            }
          }}
        />
        <Button
          size="sm"
          className="h-8 px-2.5 text-xs"
          data-testid="bulk-remind-apply"
          disabled={!value}
          onClick={onApply}
        >
          Apply
        </Button>
      </div>
      {/* The dialog's reminderNeedsDate, counted: a cue fires only on a day the
          item occurs, and an undated anchored item has none. */}
      {undated > 0 && (
        <p className="px-2 pb-2 text-[10px] text-muted-foreground">
          {undated} have no date. Give them one and they will fire.
        </p>
      )}
      {anySet && (
        <button
          type="button"
          data-testid="bulk-remind-clear"
          className={cn(optionClass, 'text-muted-foreground')}
          onClick={onClear}
        >
          No reminder
        </button>
      )}
    </div>
  );
}

export function BulkEditMenu({ selected }: { selected: Item[] }) {
  const projects = usePlannerStore((s) => s.projects);
  const getProjectColor = usePlannerStore((s) => s.getProjectColor);
  const routines = usePlannerStore((s) => s.routines);
  const programs = usePlannerStore((s) => s.programs);
  const goals = usePlannerStore((s) => s.goals);
  const collectionsAvailable = usePlannerStore((s) => s.collectionsAvailable);
  const goalsAvailable = usePlannerStore((s) => s.goalsAvailable);
  const setItemsPriority = usePlannerStore((s) => s.setItemsPriority);
  const setItemsProject = usePlannerStore((s) => s.setItemsProject);
  const setItemsReminder = usePlannerStore((s) => s.setItemsReminder);
  const setItemsCollected = usePlannerStore((s) => s.setItemsCollected);
  const setItemsGoal = usePlannerStore((s) => s.setItemsGoal);
  const goalsOn = useGoalsEnabled();
  // Which shell — the same live breakpoint the sidebar's Display menu uses.
  const isTouch = useIsMobile();

  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<PaneKey | null>(null);
  const [remindTime, setRemindTime] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  // The row last drilled from, so Back lands on it rather than on the top row.
  const [drilledFrom, setDrilledFrom] = useState<PaneKey | null>(null);

  const count = selected.length;

  // ── eligible subsets, one per property, all from lib/bulk-edit.ts ──────────
  const prioritizable = useMemo(() => selected.filter(canBulkSetPriority), [selected]);
  const remindable = useMemo(() => selected.filter(canBulkSetReminder), [selected]);
  const fileable = useMemo(() => selected.filter(canBulkSetProject), [selected]);
  const unfileable = useMemo(() => selected.filter(canBulkClearProject), [selected]);
  // Subtasks are not collectible (they surface only inside their parent), so a
  // selection swept off the canvas can carry ids no container will take.
  const collectible = useMemo(() => selected.filter(canBulkCollect), [selected]);
  const collectibleIds = useMemo(() => collectible.map((i) => i.id), [collectible]);
  const activeGoals = useMemo(() => goals.filter((g) => g.state === 'active'), [goals]);

  const membershipOf = (held: Iterable<string>): Membership => {
    if (collectibleIds.length === 0) return 'none';
    const set = new Set(held);
    const n = collectibleIds.filter((id) => set.has(id)).length;
    return n === 0 ? 'none' : n === collectibleIds.length ? 'all' : 'some';
  };
  const containerState = (c: { itemIds: string[] }) => membershipOf(c.itemIds);
  // All three role arrays: a milestone is as much "in" the goal as a member.
  const goalState = (g: (typeof goals)[number]) => membershipOf(goalItemIds(g));

  const allIds = (items: readonly Item[]) => items.map((i) => i.id);
  const undatedReminders = remindable.filter(reminderNeedsDate).length;

  // ── the root list, in the item dialog's order ─────────────────────────────
  const rows: {
    key: PaneKey;
    label: string;
    icon: ReactNode;
    eligible: number;
    summary: string | undefined;
    visible: boolean;
  }[] = [
    {
      key: 'priority',
      label: 'Priority',
      icon: <Flag className="size-3.5" />,
      eligible: prioritizable.length,
      summary: sharedSummary(prioritizable, (i) => (i as { priority?: Priority }).priority, String, (p) => PRIORITY_LABELS[p]),
      visible: prioritizable.length > 0,
    },
    {
      key: 'remind',
      label: 'Remind',
      icon: <Bell className="size-3.5" />,
      eligible: remindable.length,
      summary: sharedSummary(remindable, (i) => i.reminderTime || undefined),
      visible: remindable.length > 0,
    },
    {
      key: 'project',
      label: CONTAINER_KINDS.project.label,
      icon: <Folder className="size-3.5" />,
      eligible: fileable.length,
      summary: sharedSummary(
        fileable,
        (i) => i.project || undefined,
        (name) => foldContainerName('project', name),
      ),
      // No inline creation here, so a pane with no projects has only "No
      // project" to offer — worth showing only if something can be unfiled.
      visible:
        fileable.length > 0 && (projects.length > 0 || unfileable.some((i) => !!i.project)),
    },
    {
      key: 'routine',
      label: CONTAINER_KINDS.routine.label,
      icon: <Layers className="size-3.5" />,
      eligible: collectible.length,
      summary: membershipRowSummary(routines, containerState),
      // Hidden entirely when migration 024's tables are unreachable — a row
      // would promise a feature the writes cannot reach.
      visible: collectionsAvailable && collectible.length > 0 && routines.length > 0,
    },
    {
      key: 'program',
      label: CONTAINER_KINDS.program.label,
      icon: <CalendarRange className="size-3.5" />,
      eligible: collectible.length,
      summary: membershipRowSummary(programs, containerState),
      visible: collectionsAvailable && collectible.length > 0 && programs.length > 0,
    },
    {
      key: 'goal',
      label: CONTAINER_KINDS.goal.label,
      icon: <Target className="size-3.5" />,
      eligible: collectible.length,
      summary: membershipRowSummary(activeGoals, goalState),
      // The dialog's aspire-band gate (visibleContainerBands), plus somewhere
      // to go: there is no inline goal creation here.
      visible: collectible.length > 0 && goalsOn && goalsAvailable && activeGoals.length > 0,
    },
  ];
  const visibleRows = rows.filter((r) => r.visible);

  // Drilling in or out moves focus into the new level, so a keyboard user is
  // never left holding focus on a row that just unmounted: a pane's first
  // OPTION (the time field in Remind — not Back, which comes first in the
  // DOM), and on the way out the row the user drilled from.
  useEffect(() => {
    if (!open) return;
    const body = bodyRef.current;
    if (!body) return;
    const target = pane
      ? body.querySelector<HTMLElement>(
          pane === 'remind' ? '[data-testid="bulk-remind-time"]' : 'button:not([data-testid="bulk-edit-back"])'
        )
      : (drilledFrom &&
          body.querySelector<HTMLElement>(`[data-testid="bulk-edit-row-${drilledFrom}"]`)) ||
        body.querySelector<HTMLElement>('button');
    target?.focus();
  }, [open, pane, drilledFrom]);

  if (visibleRows.length === 0) return null;

  // The Remind field starts from the time the selection shares, recomputed on
  // every entry so a Clear or an abandoned draft never lingers.
  const prefillRemind = () => {
    const shared = sharedSummary(remindable, (i) => i.reminderTime || undefined);
    setRemindTime(shared && shared !== MIXED ? shared : '');
  };

  const drill = (key: PaneKey) => {
    if (key === 'remind') prefillRemind();
    setDrilledFrom(key);
    setPane(key);
  };

  const current = rows.find((r) => r.key === pane);

  // ── each pane's options, as DATA, drawn by whichever shell is live ────────
  // Two shells, one description (display-menu.tsx's lesson: two bodies drift).
  // `keepOpen` is the multi-valued membership panes — several containers are
  // toggled in one visit — and a picked single value completes the choice.
  const optionsFor = (key: PaneKey): OptionSpec[] => {
    switch (key) {
      case 'priority': {
        const values = prioritizable.map((i) => (i as { priority?: Priority }).priority ?? 'none');
        return PRIORITY_ORDER.map((p) => ({
          key: p,
          label: PRIORITY_LABELS[p],
          role: 'menuitemradio',
          checked: values.every((v) => v === p),
          testId: 'bulk-priority-option',
          data: { 'data-value': p },
          leading: (
            <span
              aria-hidden
              className={cn('size-2 shrink-0 rounded-full', p === 'none' && 'opacity-50')}
              style={{ background: p === 'none' ? 'var(--muted-foreground)' : `var(--priority-${p})` }}
            />
          ),
          onSelect: () => setItemsPriority(allIds(prioritizable), p === 'none' ? undefined : p),
        }));
      }
      case 'project': {
        const folded = fileable.map((i) => (i.project ? foldContainerName('project', i.project) : undefined));
        const allIn = (name: string) => folded.every((f) => f === foldContainerName('project', name));
        const none: OptionSpec[] =
          unfileable.length > 0
            ? [
                {
                  key: '',
                  label: `No ${CONTAINER_KINDS.project.label.toLowerCase()}`,
                  role: 'menuitemradio',
                  checked: unfileable.every((i) => !i.project),
                  testId: 'bulk-project-option',
                  data: { 'data-project-id': '' },
                  muted: true,
                  trailing: <EligibleCount n={unfileable.length} of={fileable.length} />,
                  onSelect: () => setItemsProject(allIds(unfileable), undefined),
                },
              ]
            : [];
        return [
          ...none,
          ...projects.map(
            (p): OptionSpec => ({
              key: p.id,
              label: p.name,
              role: 'menuitemradio',
              checked: allIn(p.name),
              testId: 'bulk-project-option',
              data: { 'data-project-id': p.id },
              leading: <ColorSquare color={getProjectColor(p.name)} />,
              onSelect: () => setItemsProject(allIds(fileable), p.name),
            })
          ),
        ];
      }
      case 'routine':
      case 'program':
      case 'goal': {
        const list: readonly { c: { id: string; name: string; color?: string }; state: Membership }[] =
          key === 'routine'
            ? routines.map((c) => ({ c, state: containerState(c) }))
            : key === 'program'
              ? programs.map((c) => ({ c, state: containerState(c) }))
              : activeGoals.map((c) => ({ c, state: goalState(c) }));
        return list.map(({ c, state }): OptionSpec => {
          return {
            key: c.id,
            label: c.name,
            role: 'menuitemcheckbox',
            checked: state === 'all' ? true : state === 'some' ? 'mixed' : false,
            testId: key === 'goal' ? 'bulk-goal-option' : 'bulk-collect-option',
            data: { 'data-container-id': c.id, 'data-state': state },
            keepOpen: true,
            leading: <ContainerSquare color={c.color ?? accentColorForName(c.name)} />,
            // Tri-state: `all` clears the whole selection out, anything less
            // collects it in — see OptionSpec.
            onSelect: () => {
              const member = state !== 'all';
              if (key === 'goal') setItemsGoal(collectibleIds, c.id, member);
              else setItemsCollected(collectibleIds, key, c.id, member);
            },
          };
        });
      }
      default:
        return [];
    }
  };

  const remindBody = (onDone: () => void): ReactNode => (
    <RemindPane
      value={remindTime}
      onChange={setRemindTime}
      undated={undatedReminders}
      anySet={remindable.some((i) => !!i.reminderTime)}
      onApply={() => {
        if (!remindTime) return;
        setItemsReminder(allIds(remindable), remindTime);
        onDone();
      }}
      onClear={() => {
        setItemsReminder(allIds(remindable), undefined);
        onDone();
      }}
    />
  );

  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 gap-1.5 rounded-full px-2.5 text-xs"
      data-testid="bulk-edit"
    >
      <SlidersHorizontal className="h-3.5 w-3.5" />
      Edit
    </Button>
  );

  const reset = (next: boolean) => {
    setOpen(next);
    // Every opening starts at the top, not in whichever pane was left.
    if (!next) {
      setPane(null);
      setDrilledFrom(null);
    }
    // The pointer shell has no drill step to prefill on.
    if (next) prefillRemind();
  };

  /* ── the pointer shell: flyouts on hover, like the sidebar's Display menu ─ */
  if (!isTouch) {
    return (
      <DropdownMenu open={open} onOpenChange={reset}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent
          align="center"
          side="top"
          className={PANEL}
          data-testid="bulk-edit-menu"
          data-bulk-edit-variant="menu"
        >
          {visibleRows.map((r) => (
            <DropdownMenuSub key={r.key}>
              <DropdownMenuSubTrigger
                className={cn(MENU_ROW, '[&>svg:last-child]:size-3.5')}
                data-testid={`bulk-edit-row-${r.key}`}
              >
                <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
                  {r.icon}
                </span>
                {/* The trigger appends its own ml-auto chevron, so the label takes
                    the slack and the value sits on the rail beside it. */}
                <span className="flex-1 truncate">
                  {r.label} <EligibleCount n={r.eligible} of={count} />
                </span>
                {r.summary && (
                  <span className="max-w-24 shrink-0 truncate text-muted-foreground">{r.summary}</span>
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                className={PANEL}
                // A keyboard-opened flyout focuses its own content, and Remind's
                // content holds no menu items for the arrows to walk: step into
                // the form instead. Radix would otherwise eat the Tab too.
                onKeyDown={
                  r.key === 'remind'
                    ? (e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key !== 'ArrowDown' && e.key !== 'Home' && e.key !== 'Tab') return;
                        e.preventDefault();
                        e.currentTarget
                          .querySelector<HTMLElement>('[data-testid="bulk-remind-time"]')
                          ?.focus();
                      }
                    : undefined
                }
              >
                {r.key === 'remind' ? (
                  remindBody(() => reset(false))
                ) : (
                  <div className="scrollbar-hide max-h-[min(20rem,60vh)] overflow-x-hidden overflow-y-auto">
                    {optionsFor(r.key).map((o) => (
                      <DropdownMenuItem
                        key={o.key}
                        role={o.role}
                        aria-checked={o.checked === 'mixed' ? 'mixed' : o.checked}
                        data-testid={o.testId}
                        {...o.data}
                        className={cn(MENU_ROW, o.muted && 'text-muted-foreground')}
                        onSelect={(e) => {
                          if (o.keepOpen) e.preventDefault();
                          o.onSelect();
                        }}
                      >
                        <OptionBody o={o} />
                      </DropdownMenuItem>
                    ))}
                  </div>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  /* ── the touch shell: one popover, drilled in place ─────────────────────── */
  return (
    <Popover open={open} onOpenChange={reset}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="center" className="w-60 p-1" data-bulk-edit-variant="sheet">
        {/* Remind holds a text field and a plain Apply button, neither of which
            a menu may contain, so that pane is a group; the others are menus of
            menuitem rows. */}
        <div
          ref={bodyRef}
          role={pane === 'remind' ? 'group' : 'menu'}
          aria-label={current ? current.label : 'Edit properties'}
        >
          {current ? (
            <>
              <div className="flex items-center gap-1 pb-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Back"
                  data-testid="bulk-edit-back"
                  onClick={() => setPane(null)}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="text-xs font-medium">{current.label}</span>
                <span className="ml-auto pr-2 text-xs">
                  <EligibleCount n={current.eligible} of={count} />
                </span>
              </div>
              {pane === 'remind' ? (
                remindBody(() => setPane(null))
              ) : (
                <div className="max-h-64 overflow-y-auto">
                  {optionsFor(pane!).map((o) => (
                    <button
                      key={o.key}
                      type="button"
                      role={o.role}
                      aria-checked={o.checked === 'mixed' ? 'mixed' : o.checked}
                      data-testid={o.testId}
                      {...o.data}
                      className={cn(optionClass, o.muted && 'text-muted-foreground')}
                      onClick={() => {
                        o.onSelect();
                        // A single value completes the choice: back to the list,
                        // so the next property is one tap away.
                        if (!o.keepOpen) setPane(null);
                      }}
                    >
                      <OptionBody o={o} />
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            visibleRows.map((r) => (
              <button
                key={r.key}
                type="button"
                role="menuitem"
                data-testid={`bulk-edit-row-${r.key}`}
                className={optionClass}
                onClick={() => drill(r.key)}
              >
                <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
                  {r.icon}
                </span>
                <span>{r.label}</span>
                <EligibleCount n={r.eligible} of={count} />
                <span className="ml-auto flex min-w-0 items-center gap-1 text-muted-foreground">
                  {r.summary && <span className="truncate">{r.summary}</span>}
                  <ChevronRight className="size-3.5 shrink-0" />
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
