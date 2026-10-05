'use client';

import { Fragment, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeftToLine,
  Bot,
  CalendarClock,
  CalendarDays,
  Check,
  Copy,
  Flame,
  Footprints,
  Link2,
  Maximize2,
  MessageSquare,
  PanelRight,
  Pause,
  Play,
  Redo2,
  SkipForward,
  Split,
  Sprout,
  Trash2,
  Undo2,
  Unlink,
} from 'lucide-react';
import { AskMark } from '@/components/ai/ask-mark';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Calendar } from '@/components/ui/calendar';
import {
  EligibleCount,
  MENU_ROW,
  MIXED,
  OptionBody,
  optionChecked,
  PANEL,
  RemindPane,
  RowSummary,
  sharedSummary,
  useEditModel,
  type OptionSpec,
} from '@/components/shell/bulk-edit-menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useCommandContext } from '@/hooks/use-command-context';
import { usePlannerStore } from '@/lib/planner-store';
import { useSelectionStore } from '@/lib/selection-store';
import { openEditFor } from '@/lib/ui-store';
import { milestoneItemIds } from '@/lib/goals';
import { toDateStr } from '@/lib/recurrence';
import { addDaysStr, weekStartOf, type OccurrenceState } from '@/lib/container-schedule';
import { ITEM_VERBS, drawnState, isDoneOn, type VerbContext, type VerbId } from '@/lib/item-verbs';
import { STATIC_COMMANDS, type Command } from '@/lib/commands';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { useConversationsStore } from '@/lib/conversations-store';
import { inactiveItemIdsOn } from '@/lib/active';
import { itemAsksFor, type ItemAsk, type ItemAskContext, type ItemAskId } from '@/lib/item-asks';
import { askAboutItem, breakDownItem, proposeForItem } from '@/lib/open-chat';
import { canHandOff, canTakeBack, delegateName, handOffItem, heldState, takeBackItem } from '@/lib/agent-handoff';
import { refreshAgentFreshness } from '@/hooks/use-agent-freshness';
import { agentStatusView } from '@/lib/agent-status';
import { assigneeLabel } from '@/lib/chat-utils';
import { parseDay } from '@/lib/collections';
import { cn } from '@/lib/utils';
import type { HabitItem, Item, Task } from '@/lib/planner-types';

/**
 * THE RIGHT-CLICK MENU ON AN ITEM — the grid's blocks, the list and bucket
 * rows, the braindump, the Organize console's member rows.
 *
 * It decides nothing. Every verb is a shared declaration (lib/item-verbs.ts)
 * acting on the day the row was DRAWN on, which is what a right-click means:
 * right-clicking Wednesday's column acts on Wednesday, not on the day the
 * header is browsing. The properties are the multiselect Edit menu's own
 * option lists (useEditModel), handed a selection of one.
 *
 * Right-clicking an item that is part of a multiselection acts on the whole
 * selection, through the ⌘K commands' batch versions (one ⌘Z each) and the
 * same Edit lists; right-clicking anything else makes it the selection first,
 * the way a file manager does, so what the menu acts on is always lit.
 *
 * "AI" is one row with the asks under it (lib/item-asks.ts declares them,
 * lib/open-chat.ts runs them) and the hand-off to the agent
 * (lib/agent-handoff.ts), so the AI adds a single line to the menu; it is not
 * there at all while nothing can answer, propose or take the item.
 *
 * Pointer only. On touch a long-press already means drag (and, on phones, the
 * row swipe), so the trigger is disabled there and the row's own ⋯ / sheet
 * stays the way in. Everything inside mounts only while the menu is open, so a
 * week of rows pays for one Radix root each and nothing else.
 */

export interface ItemContextMenuProps {
  item: Item | Task | HabitItem;
  /**
   * The day the row is drawn on. Omitted: the day on screen. `'today'` is
   * resolved when the menu opens, for a surface that always means today and
   * may have been left open past midnight (the Organize console).
   */
  date?: Date | 'today';
  /**
   * What the surface knows about the item on that day, when it knows more than
   * "it is drawn there" — the console passes its week schedule's answer.
   */
  occurrence?: OccurrenceState | 'absent';
  /** Extra rows the surface owns (the console's "Remove from Mornings"). */
  extra?: ReactNode;
  /** Replaces "Open" — the console cannot host the item panel over itself. */
  openHref?: boolean;
  children: ReactElement;
}

export function ItemContextMenu({ item, date, occurrence, extra, openHref, children }: ItemContextMenuProps) {
  const isMobile = useIsMobile();
  const coarse = useMediaQuery('(pointer: coarse)');

  return (
    <ContextMenu
      onOpenChange={(next) => {
        if (!next) return;
        noteMenuOpener();
        // Light what the menu will act on: an item outside the selection becomes it.
        const sel = useSelectionStore.getState();
        if (!sel.selectedIds.has(item.id)) sel.replace([item.id]);
      }}
    >
      <ContextMenuTrigger asChild disabled={isMobile || coarse}>
        {children}
      </ContextMenuTrigger>
      {/* Mounted only while open (Radix Presence), so the store reads below cost nothing at rest. */}
      <ContextMenuContent
        className={PANEL}
        data-testid="item-context-menu"
        data-item-id={item.id}
        onCloseAutoFocus={keepFocusTaken}
      >
        <MenuBody item={item as Item} date={date} occurrence={occurrence} extra={extra} openHref={openHref} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Radix hands focus back to the row the menu opened from once its close
 * animation ends, whatever happened in between. A row that opened something
 * which took the focus (the item's conversation box, from "AI ▸"; a
 * dialog) keeps it there: the row gets it back only when it would otherwise
 * be lost, the item panel's own return rule (item-dialog.tsx returnFocusTo).
 * By now the menu is gone, so focus left inside it reads as <body>.
 */
function keepFocusTaken(e: Event) {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) e.preventDefault();
}

/**
 * What held focus when the menu opened: the row (a right click's mousedown,
 * or Shift+F10 on it, leaves it focused). One menu is open at a time.
 */
let menuOpener: HTMLElement | null = null;

function noteMenuOpener() {
  const active = document.activeElement;
  menuOpener = active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * Hand focus back to that row BEFORE an ask opens anything, so whatever
 * records where to return focus records the row and not the menu item about
 * to vanish: the item panel (returnFocusTo, captured as it opens) and the
 * rail (rememberFocus on a summon, noteRailEntry as its box takes focus).
 * Closing either afterwards then lands on the row. The submenu's own focus
 * scope is not a trap, so nothing pulls the focus back into the menu.
 */
function returnFocusToOpener() {
  if (menuOpener?.isConnected) menuOpener.focus({ preventScroll: true });
}

/* ── the body: one item, or the selection it belongs to ────────────────── */

function MenuBody({ item, date, occurrence, extra, openHref }: Omit<ItemContextMenuProps, 'children'>) {
  const selectedIds = useSelectionStore((s) => s.selectedIds);
  const items = usePlannerStore((s) => s.items);
  const many = selectedIds.size > 1 && selectedIds.has(item!.id);
  if (many) {
    const selected = items.filter((i) => selectedIds.has(i.id));
    return <SelectionBody selected={selected} />;
  }
  // Re-read: the row was painted from a snapshot, and may be a legacy projection.
  const live = items.find((i) => i.id === item!.id) ?? (item as Item);
  return <SingleBody item={live} date={date} occurrence={occurrence} extra={extra} openHref={openHref} />;
}

/** Row class for the menu's own rows — the Edit menu's, so the two read as one. */
const ROW = cn(MENU_ROW, "[&_svg:not([class*='text-'])]:text-muted-foreground");

/** One plain row, for a surface's `extra` rows as much as the menu's own. */
export function ItemMenuRow(props: Parameters<typeof Row>[0]) {
  return <Row {...props} />;
}

function Row({
  icon,
  label,
  detail,
  testId,
  destructive,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  testId: string;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <ContextMenuItem
      className={ROW}
      variant={destructive ? 'destructive' : 'default'}
      data-testid={testId}
      onSelect={onSelect}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {detail && <span className="text-muted-foreground shrink-0">{detail}</span>}
    </ContextMenuItem>
  );
}

function SingleBody({
  item,
  date,
  occurrence,
  extra,
  openHref,
}: {
  item: Item;
  date?: Date | 'today';
  occurrence?: OccurrenceState | 'absent';
  extra?: ReactNode;
  openHref?: boolean;
}) {
  const router = useRouter();
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const goals = usePlannerStore((s) => s.goals);
  const weekStartDay = usePlannerStore((s) => s.weekStartDay);
  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = date === 'today' ? new Date() : (date ?? selectedDate);
  const dateStr = toDateStr(day, tz);
  const todayStr = toDateStr(new Date(), tz);

  const ctx: VerbContext = {
    dateStr,
    date: day,
    todayStr,
    tz,
    milestoneIds: milestoneItemIds(goals ?? []),
    // Drawn on this day means it falls on it; the surface may know better.
    occurrence: occurrence ?? drawnState(item, dateStr, todayStr),
  };
  const can = (id: VerbId) => ITEM_VERBS[id].eligible(item, ctx);
  const run = (id: VerbId, arg?: string) => () => ITEM_VERBS[id].run(item, ctx, arg);
  const label = (id: VerbId) => ITEM_VERBS[id].label(item, ctx);
  // "today" in a label is only true on today.
  const onDay = (text: string) => (dateStr === todayStr ? text : text.replace(/ today$/, ''));

  const edit = useEditModel([item]);
  const nextWeek = addDaysStr(weekStartOf(todayStr, weekStartDay), 7);
  const itemType = item.type === 'habit' ? 'habit' : 'task';

  const status: ReactNode[] = [];
  if (can('unskip')) {
    status.push(<Row key="unskip" icon={<Undo2 className="size-3.5" />} label={onDay(label('unskip'))} testId="item-menu-unskip" onSelect={run('unskip')} />);
  } else if (can('tick')) {
    const done = isDoneOn(item, dateStr);
    status.push(
      <Row
        key="tick"
        icon={done ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}
        label={onDay(label('tick'))}
        testId="item-menu-tick"
        onSelect={run('tick')}
      />
    );
  }
  if (can('skip')) {
    status.push(<Row key="skip" icon={<SkipForward className="size-3.5" />} label={onDay(label('skip'))} testId="item-menu-skip" onSelect={run('skip')} />);
  }
  if (can('resume')) {
    status.push(<Row key="resume" icon={<Play className="size-3.5" />} label="Resume" testId="item-menu-resume" onSelect={run('resume')} />);
  } else if (can('pause')) {
    status.push(<Row key="pause" icon={<Pause className="size-3.5" />} label="Pause" testId="item-menu-pause" onSelect={run('pause')} />);
  }

  const when: ReactNode[] = [];
  if (can('nextDay')) {
    when.push(
      <Row
        key="next"
        icon={<Redo2 className="size-3.5" />}
        label={label('nextDay')}
        detail={ITEM_VERBS.nextDay.detail?.(item, ctx)}
        testId="item-menu-next-day"
        onSelect={run('nextDay')}
      />
    );
  }
  if (can('reschedule')) {
    const startDate = (item as { startDate?: string }).startDate;
    when.push(
      <ContextMenuSub key="reschedule">
        <ContextMenuSubTrigger className={ROW} data-testid="item-menu-reschedule">
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            <CalendarDays className="size-3.5" />
          </span>
          <span className="flex-1">{label('reschedule')}</span>
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="p-0" data-testid="item-menu-reschedule-content">
          <div className="p-1">
            <Row icon={null} label="Today" testId="item-menu-reschedule-today" onSelect={run('reschedule', todayStr)} />
            <Row icon={null} label="Tomorrow" testId="item-menu-reschedule-tomorrow" onSelect={run('reschedule', addDaysStr(todayStr, 1))} />
            <Row icon={null} label="Next week" testId="item-menu-reschedule-next-week" onSelect={run('reschedule', nextWeek)} />
          </div>
          <ContextMenuSeparator className="my-0" />
          {/* The menu claims the arrows and Tab anywhere inside it, which would
              make the grid unusable from the keyboard. Escape still closes. */}
          <div onKeyDown={(e) => e.key !== 'Escape' && e.stopPropagation()}>
            <Calendar
              mode="single"
              selected={parseDay(startDate)}
              defaultMonth={parseDay(startDate) ?? parseDay(todayStr)}
              onSelect={(picked) => {
                if (!picked) return;
                const y = picked.getFullYear();
                const m = String(picked.getMonth() + 1).padStart(2, '0');
                const d = String(picked.getDate()).padStart(2, '0');
                ITEM_VERBS.reschedule.run(item, ctx, `${y}-${m}-${d}`);
                // Radix closes on an item select and a calendar pick is not one,
                // and a context menu's open state cannot be controlled — so the
                // pick dismisses it the way Escape does (its document listener).
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              }}
            />
          </div>
        </ContextMenuSubContent>
      </ContextMenuSub>
    );
  }
  if (can('braindump')) {
    when.push(<Row key="bd" icon={<ArrowLeftToLine className="size-3.5" />} label={label('braindump')} testId="item-menu-braindump" onSelect={run('braindump')} />);
  }
  if (can('leaveProjectBlock')) {
    when.push(<Row key="block" icon={<Unlink className="size-3.5" />} label={label('leaveProjectBlock')} testId="item-menu-leave-block" onSelect={run('leaveProjectBlock')} />);
  }

  const copy = (text: string, what: string) => () => {
    void navigator.clipboard?.writeText(text).then(
      () => toast(`${what} copied`),
      () => toast.error(`Couldn’t copy the ${what.toLowerCase()}`)
    );
  };

  return (
    <>
      <ContextMenuLabel className="text-muted-foreground max-w-60 truncate px-2 py-1 text-2xs font-normal">
        {item.title}
      </ContextMenuLabel>
      {openHref ? (
        <Row icon={<Maximize2 className="size-3.5" />} label="Open item" testId="item-menu-open-page" onSelect={() => router.push(`/item/${item.id}`)} />
      ) : (
        <>
          <Row icon={<PanelRight className="size-3.5" />} label="Open" testId="item-menu-open" onSelect={() => openEditFor(item as unknown as Task, itemType)} />
          <Row icon={<Maximize2 className="size-3.5" />} label="Open as page" testId="item-menu-open-page" onSelect={() => router.push(`/item/${item.id}`)} />
        </>
      )}
      <AskSection item={item} todayStr={todayStr} tz={tz} page={!!openHref} />
      {status.length > 0 && <ContextMenuSeparator />}
      {status}
      {when.length > 0 && <ContextMenuSeparator />}
      {when}
      <EditSection edit={edit} />
      <ContextMenuSeparator />
      {can('resetStreak') && (
        <Row icon={<Flame className="size-3.5" />} label="Reset streak" testId="item-menu-reset-streak" onSelect={run('resetStreak')} />
      )}
      <Row icon={<Link2 className="size-3.5" />} label="Copy link" testId="item-menu-copy-link" onSelect={copy(`${window.location.origin}/item/${item.id}`, 'Link')} />
      <Row icon={<Copy className="size-3.5" />} label="Copy title" testId="item-menu-copy-title" onSelect={copy(item.title, 'Title')} />
      {extra}
      <ContextMenuSeparator />
      <Row icon={<Trash2 className="size-3.5" />} label="Delete…" destructive testId="item-menu-delete" onSelect={run('delete')} />
    </>
  );
}

/* ── AI: the asks and the hand-off, under one row ─────────────────────── */

const ASK_ICON: Record<ItemAskId, ReactNode> = {
  ask: <MessageSquare className="size-3.5" />,
  breakdown: <Split className="size-3.5" />,
  start: <Footprints className="size-3.5" />,
  findTime: <CalendarClock className="size-3.5" />,
  keep: <Sprout className="size-3.5" />,
};

/**
 * "AI ▸": what can be asked of the AI about this item, then, under a line,
 * handing it to the agent. Each ask runs on the item as it is when picked, and
 * always about the item itself, whatever day it was drawn on. `page`: this
 * surface cannot host the item panel (the console), so the item goes to its
 * own page, as "Open item" does here. Two asks are not offered there: "Ask
 * about this…" would be "Open item" again (the page shows the conversation and
 * its box), and "Find a time" answers in Ask, which that page does not show.
 * The hand-off opens nothing, so it is offered there too.
 *
 * The hand-off row follows the item: "Hand off to OpenClaw" while the agent
 * could take it (lib/agent-handoff.ts canHandOff, the agent's own queue
 * filter), "Take back from OpenClaw" with its status beside it while the agent
 * holds it. Taking back is never gated on the agent being paired.
 *
 * Opening the menu warms the conversation list (it never blocks), so "Continue
 * conversation" can be told apart from "Ask about this…" in a session that has
 * not opened Ask yet.
 */
function AskSection({ item, todayStr, tz, page }: { item: Item; todayStr: string; tz: string; page: boolean }) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const { canChat, canPropose, canDelegate } = useAICapabilities();
  const hasConversation = useConversationsStore((s) => typeof s.itemIndex[item.id] === 'string');
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const goals = usePlannerStore((s) => s.goals);
  // The menu body mounts only while open, so the status beside "Take back"
  // reads the clock as of opening, which is all a glance needs.
  const [now] = useState(() => Date.now());
  useEffect(() => {
    if (canChat) void useConversationsStore.getState().ensureLoaded();
  }, [canChat]);
  // The store hears of the agent's own writes only through Ask home's
  // throttled read, and Ask starts closed: an item handed off an hour ago may
  // be done on the server while it still reads "Queued" here. Read the agent's
  // rows before offering to take it back (a finished report is not the menu's
  // to clear); the row re-renders as the newer state lands.
  const delegated = 'assignee' in item && !!item.assignee;
  useEffect(() => {
    if (delegated) void refreshAgentFreshness();
  }, [delegated]);

  const takeBack = canTakeBack(item);
  if (!canChat && !canPropose && !canDelegate && !takeBack) return null;
  const inactiveIds = inactiveItemIdsOn([item], todayStr, { userTimezone: tz, routines, seasons });
  const ctx: ItemAskContext = {
    todayStr,
    inactiveIds,
    milestoneIds: milestoneItemIds(goals ?? []),
    hasConversation,
    canChat,
    canPropose,
  };
  const asks = itemAsksFor(item, ctx).filter((a) => !(page && (a.kind === 'propose' || a.kind === 'compose')));
  const handOff = !takeBack && canHandOff(item, { canDelegate, todayStr, inactiveIds });
  if (asks.length === 0 && !handOff && !takeBack) return null;

  const run = (ask: ItemAsk) => () => {
    returnFocusToOpener();
    if (page) router.push(`/item/${item.id}`);
    switch (ask.kind) {
      case 'compose':
        askAboutItem(item, { isMobile, page });
        return;
      case 'send':
        askAboutItem(item, { isMobile, page, text: ask.prompt!(item, ctx) });
        return;
      case 'breakdown':
        breakDownItem(item, { isMobile, page });
        return;
      case 'propose':
        proposeForItem(ask.prompt!(item, ctx), isMobile);
        return;
    }
  };
  const who = takeBack && 'assignee' in item && item.assignee ? assigneeLabel(item.assignee) : delegateName();

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger className={cn(ROW, '[&>svg:last-child]:size-3.5')} data-testid="item-menu-ask">
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <AskMark className="size-3.5" />
        </span>
        <span className="flex-1 truncate">AI</span>
      </ContextMenuSubTrigger>
      {/* Sized to its rows, from the panel's width up: "Take back from OpenClaw"
          beside a status ("Couldn't finish") does not fit in 240px. */}
      <ContextMenuSubContent className={cn(PANEL, 'w-auto max-w-80 min-w-60')} data-testid="item-menu-ask-content">
        {asks.map((ask) => (
          <Row
            key={ask.id}
            icon={ASK_ICON[ask.id]}
            label={ask.label(item, ctx)}
            testId={`item-menu-ask-${ask.id}`}
            onSelect={run(ask)}
          />
        ))}
        {asks.length > 0 && (handOff || takeBack) && <ContextMenuSeparator />}
        {handOff && (
          <Row
            icon={<Bot className="size-3.5" />}
            label={`Hand off to ${who}`}
            testId="item-menu-handoff"
            onSelect={() => {
              returnFocusToOpener();
              handOffItem(item);
            }}
          />
        )}
        {takeBack && (
          <Row
            icon={<Undo2 className="size-3.5" />}
            label={`Take back from ${who}`}
            detail={agentStatusView(heldState(item), now)?.label}
            testId="item-menu-takeback"
            onSelect={() => {
              returnFocusToOpener();
              takeBackItem(item);
            }}
          />
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/* ── properties: the Edit menu's own lists ─────────────────────────────── */

function EditSection({ edit }: { edit: ReturnType<typeof useEditModel> }) {
  const [remindTime, setRemindTime] = useState('');
  if (edit.visibleRows.length === 0) return null;
  const ids = (list: readonly Item[]) => list.map((i) => i.id);
  const prefillRemind = () => {
    const shared = sharedSummary(edit.remindable, (i) => i.reminderTime || undefined);
    setRemindTime(shared && shared !== MIXED ? shared : '');
  };
  return (
    <>
      <ContextMenuSeparator />
      {edit.visibleRows.map((r) => (
        <ContextMenuSub key={r.key} onOpenChange={(o) => o && r.key === 'remind' && prefillRemind()}>
          <ContextMenuSubTrigger
            className={cn(ROW, '[&>svg:last-child]:size-3.5')}
            data-testid={`item-menu-edit-${r.key}`}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">{r.icon}</span>
            <span className="flex-1 truncate">
              {r.label} <EligibleCount n={r.eligible} of={edit.count} />
            </span>
            <RowSummary summary={r.summary} />
          </ContextMenuSubTrigger>
          <ContextMenuSubContent
            className={PANEL}
            onKeyDown={
              r.key === 'remind'
                ? (e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key !== 'ArrowDown' && e.key !== 'Home' && e.key !== 'Tab') return;
                    e.preventDefault();
                    e.currentTarget.querySelector<HTMLElement>('[data-testid="bulk-remind-time"]')?.focus();
                  }
                : undefined
            }
          >
            {r.key === 'remind' ? (
              <RemindPane
                value={remindTime}
                onChange={setRemindTime}
                undated={edit.undatedReminders}
                anySet={edit.remindable.some((i) => !!i.reminderTime)}
                onApply={() => {
                  if (remindTime) edit.setItemsReminder(ids(edit.remindable), remindTime);
                }}
                onClear={() => edit.setItemsReminder(ids(edit.remindable), undefined)}
              />
            ) : (
              <div className="scrollbar-hide max-h-[min(20rem,60vh)] overflow-x-hidden overflow-y-auto">
                {edit.optionsFor(r.key).map((o: OptionSpec) => (
                  <Fragment key={o.key}>
                    {o.divider && <ContextMenuSeparator />}
                    <ContextMenuItem
                      role={o.role}
                      aria-checked={optionChecked(o)}
                      data-testid={o.testId}
                      {...o.data}
                      className={cn(MENU_ROW, o.muted && 'text-muted-foreground')}
                      onSelect={(e) => {
                        if (o.keepOpen) e.preventDefault();
                        o.onSelect();
                      }}
                    >
                      <OptionBody o={o} />
                    </ContextMenuItem>
                  </Fragment>
                ))}
              </div>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
      ))}
    </>
  );
}

/* ── a multiselection: the ⌘K commands' batch versions ─────────────────── */

/**
 * The palette's item commands that take a selection, in menu order. Their
 * batches are one ⌘Z each and act on the day on screen, as the bulk bar does —
 * a selection can span a week's columns, so no one row's day is right for all.
 */
const BATCH: { id: string; icon: ReactNode; destructive?: boolean }[] = [
  { id: 'items.complete', icon: <Check className="size-3.5" /> },
  { id: 'items.skip', icon: <SkipForward className="size-3.5" /> },
  { id: 'items.snooze', icon: <Redo2 className="size-3.5" /> },
  { id: 'items.leaveProjectBlock', icon: <Unlink className="size-3.5" /> },
  { id: 'items.pause', icon: <Pause className="size-3.5" /> },
  { id: 'items.resume', icon: <Play className="size-3.5" /> },
  { id: 'items.resetStreak', icon: <Flame className="size-3.5" /> },
];

function entityArg(command: Command | undefined) {
  const arg = command?.argument;
  return arg?.kind === 'entity' && arg.runMany && arg.resolve ? arg : undefined;
}

function SelectionBody({ selected }: { selected: Item[] }) {
  const ctx = useCommandContext();
  const edit = useEditModel(selected);
  const ids = selected.map((i) => i.id);
  const byId = (id: string) => STATIC_COMMANDS.find((c) => c.id === id);

  const rows = BATCH.flatMap(({ id, icon }) => {
    const command = byId(id);
    const arg = entityArg(command);
    if (!command || !arg) return [];
    const n = arg.resolve!(ids, ctx).length;
    if (n === 0) return [];
    return [
      <ContextMenuItem
        key={id}
        className={ROW}
        data-testid={`item-menu-batch-${id.slice('items.'.length)}`}
        onSelect={() => arg.runMany!(ctx, ids)}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
        <span className="flex-1 truncate">
          {command.label} <EligibleCount n={n} of={ids.length} />
        </span>
      </ContextMenuItem>,
    ];
  });
  const del = entityArg(byId('items.delete'));

  return (
    <>
      <ContextMenuLabel className="text-muted-foreground px-2 py-1 text-2xs font-normal">
        {ids.length} items
      </ContextMenuLabel>
      {rows}
      <EditSection edit={edit} />
      {del && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            className={ROW}
            variant="destructive"
            data-testid="item-menu-batch-delete"
            onSelect={() => del.runMany!(ctx, ids)}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              <Trash2 className="size-3.5" />
            </span>
            <span className="flex-1">Delete {ids.length} items…</span>
          </ContextMenuItem>
        </>
      )}
    </>
  );
}
