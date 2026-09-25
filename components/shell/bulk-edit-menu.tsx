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
 * One Popover with two levels drilled IN PLACE (a root list of properties, then
 * one property's pane with a Back button) rather than hover submenus: a submenu
 * needs a pointer to open and a phone has none, and a Radix DropdownMenu would
 * steal the time input's keys with its typeahead. Plain buttons in a Popover are
 * what the Collect menu this replaced already used, for the same reasons.
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
 * One tri-state row of a many-valued membership (routine, program, goal).
 * Tri-state, because a selection is rarely all-in or all-out of a container
 * and a plain checkbox would have to lie about the middle: `all` clears the
 * whole selection out, anything less collects the whole selection in. That
 * asymmetry is deliberate — the menu is reached from a selection you just
 * made, so the intent is nearly always "put these there", and only the
 * already-satisfied case can safely mean the opposite.
 */
function CollectRow({
  container,
  state,
  testId = 'bulk-collect-option',
  onToggle,
}: {
  container: { id: string; name: string; color?: string };
  state: Membership;
  testId?: string;
  onToggle: (member: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'}
      data-testid={testId}
      data-container-id={container.id}
      data-state={state}
      onClick={() => onToggle(state !== 'all')}
      className={optionClass}
    >
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-[2px]"
        style={{ background: container.color ?? accentColorForName(container.name) }}
      />
      <span className="truncate">{container.name}</span>
      <span className="ml-auto flex size-3.5 shrink-0 items-center justify-center">
        {state === 'all' && <Check className="size-3.5" />}
        {state === 'some' && <Minus className="size-3.5 text-muted-foreground" />}
      </span>
    </button>
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

  const drill = (key: PaneKey) => {
    if (key === 'remind') {
      const shared = sharedSummary(remindable, (i) => i.reminderTime || undefined);
      setRemindTime(shared && shared !== MIXED ? shared : '');
    }
    setDrilledFrom(key);
    setPane(key);
  };

  const applyReminder = () => {
    if (!remindTime) return;
    setItemsReminder(allIds(remindable), remindTime);
    setPane(null);
  };

  const current = rows.find((r) => r.key === pane);

  const paneBody = (): ReactNode => {
    switch (pane) {
      case 'priority': {
        const values = prioritizable.map((i) => (i as { priority?: Priority }).priority ?? 'none');
        return PRIORITY_ORDER.map((p) => (
          <button
            key={p}
            type="button"
            role="menuitemradio"
            aria-checked={values.every((v) => v === p)}
            data-testid="bulk-priority-option"
            data-value={p}
            className={optionClass}
            onClick={() => {
              setItemsPriority(allIds(prioritizable), p === 'none' ? undefined : p);
              setPane(null);
            }}
          >
            <span
              aria-hidden
              className={cn('size-2 shrink-0 rounded-full', p === 'none' && 'opacity-50')}
              style={{ background: p === 'none' ? 'var(--muted-foreground)' : `var(--priority-${p})` }}
            />
            {PRIORITY_LABELS[p]}
            {values.every((v) => v === p) && <Check className="ml-auto size-3.5" />}
          </button>
        ));
      }
      case 'remind': {
        const anySet = remindable.some((i) => !!i.reminderTime);
        return (
          <>
            <div className={sectionClass}>Nudge me at</div>
            <div className="flex gap-1 px-2 pb-2">
              <Input
                type="time"
                value={remindTime}
                data-testid="bulk-remind-time"
                aria-label="Reminder time"
                className="h-8 flex-1 text-sm"
                onChange={(e) => setRemindTime(e.target.value)}
                onKeyDown={(e) => {
                  // The field owns its keys: nothing global may act on a digit
                  // or a letter typed into the time.
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyReminder();
                  }
                }}
              />
              <Button
                size="sm"
                className="h-8 px-2.5 text-xs"
                data-testid="bulk-remind-apply"
                disabled={!remindTime}
                onClick={applyReminder}
              >
                Apply
              </Button>
            </div>
            {/* The dialog's reminderNeedsDate, counted: a cue fires only on a
                day the item occurs, and an undated anchored item has none. */}
            {undatedReminders > 0 && (
              <p className="px-2 pb-2 text-[10px] text-muted-foreground">
                {undatedReminders} have no date. Give them one and they will fire.
              </p>
            )}
            {anySet && (
              <button
                type="button"
                data-testid="bulk-remind-clear"
                className={cn(optionClass, 'text-muted-foreground')}
                onClick={() => {
                  setItemsReminder(allIds(remindable), undefined);
                  setPane(null);
                }}
              >
                No reminder
              </button>
            )}
          </>
        );
      }
      case 'project': {
        const folded = fileable.map((i) => (i.project ? foldContainerName('project', i.project) : undefined));
        const allIn = (name: string) => folded.every((f) => f === foldContainerName('project', name));
        return (
          <div className="max-h-64 overflow-y-auto">
            {unfileable.length > 0 && (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={unfileable.every((i) => !i.project)}
                data-testid="bulk-project-option"
                data-project-id=""
                className={cn(optionClass, 'text-muted-foreground')}
                onClick={() => {
                  setItemsProject(allIds(unfileable), undefined);
                  setPane(null);
                }}
              >
                No {CONTAINER_KINDS.project.label.toLowerCase()}
                <EligibleCount n={unfileable.length} of={fileable.length} />
                {unfileable.every((i) => !i.project) && <Check className="ml-auto size-3.5 shrink-0" />}
              </button>
            )}
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={allIn(p.name)}
                data-testid="bulk-project-option"
                data-project-id={p.id}
                className={optionClass}
                onClick={() => {
                  setItemsProject(allIds(fileable), p.name);
                  setPane(null);
                }}
              >
                <ColorSquare color={getProjectColor(p.name)} />
                <span className="truncate">{p.name}</span>
                {allIn(p.name) && <Check className="ml-auto size-3.5 shrink-0" />}
              </button>
            ))}
          </div>
        );
      }
      case 'routine':
        return (
          <div className="max-h-64 overflow-y-auto">
            {routines.map((r) => (
              <CollectRow
                key={r.id}
                container={r}
                state={containerState(r)}
                onToggle={(member) => setItemsCollected(collectibleIds, 'routine', r.id, member)}
              />
            ))}
          </div>
        );
      case 'program':
        return (
          <div className="max-h-64 overflow-y-auto">
            {programs.map((p) => (
              <CollectRow
                key={p.id}
                container={p}
                state={containerState(p)}
                onToggle={(member) => setItemsCollected(collectibleIds, 'program', p.id, member)}
              />
            ))}
          </div>
        );
      case 'goal':
        return (
          <div className="max-h-64 overflow-y-auto">
            {activeGoals.map((g) => (
              <CollectRow
                key={g.id}
                container={g}
                state={goalState(g)}
                testId="bulk-goal-option"
                onToggle={(member) => setItemsGoal(collectibleIds, g.id, member)}
              />
            ))}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Every opening starts at the top, not in whichever pane was left.
        if (!next) {
          setPane(null);
          setDrilledFrom(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 rounded-full px-2.5 text-xs"
          data-testid="bulk-edit"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Edit
        </Button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-60 p-1">
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
              {paneBody()}
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
