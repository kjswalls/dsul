'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, X, Zap } from 'lucide-react';
import { Button, ButtonKey } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TaskRow, type RowItem } from '@/components/primitives/task-row';
import { isRowCompletedOn } from '@/lib/sort-rows';
import { itemSizeOf } from '@/lib/item-size';
import {
  DO_STUFF_MIN_OPEN,
  doneNext,
  makeItSo,
  putOnToday,
  skipNext,
  takeShuffleFrom,
  useDoStuffStore,
} from '@/lib/do-stuff';
import {
  LANES,
  laneDef,
  laneForDigit,
  laneOf,
  laneOffered,
  nextNow,
  placeOnDays,
  stepLane,
  type Lane,
  type LaneFacts,
} from '@/lib/do-stuff-plan';
import { canHandOff } from '@/lib/agent-handoff';
import { sameAssignee, type AgentAssignee } from '@/lib/agent-assignees';
import { useAgentsStore, useHandOffTargets } from '@/lib/agents-store';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { inactiveItemIdsOn } from '@/lib/active';
import { useAwayStore } from '@/lib/away-store';
import { usePlannerStore } from '@/lib/planner-store';
import { toDateStr } from '@/lib/recurrence';
import { addDaysStr } from '@/lib/container-schedule';
import { prefersReducedMotion } from '@/lib/zen-transition';
import { packIsStale, type PrepPack } from '@/lib/prep-packs';
import { usePrepPacksStore, type PrepItem } from '@/lib/prep-packs-store';
import { PackChip, PackDeck, PackInline, PackPeek } from '@/components/sidebar/prep-pack';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { chordLabel, isApplePlatform } from '@/lib/commands/keys';
import { cn } from '@/lib/utils';

/**
 * Do stuff: the braindump sorted into a plan in lanes, then walked
 * (memory/plans/power-mode.md, build order 2).
 *
 * The key in the header starts it, and the rows shuffle from where they stood
 * into their lanes (lib/do-stuff-plan.ts decides which). Each row carries a
 * lane chip, shown on hover; the number keys move the row under the pointer or
 * focus, and a swipe moves it on the phone. "Do now" lifts its next thing in
 * place with its actions under it, and the strip above the list carries "make
 * it so", which puts the calendar lane on its days and hands the handed-off
 * lane to the agent.
 *
 * Nothing shows at rest: no size dots, no chips. Colour lives only in 6px dots
 * and the lane headers' hairlines, the row rail's rule (pills.tsx). The lime
 * appears as the done-for-you dot, the Enter keycap and the "on" ring, and
 * never under anything whose opacity changes.
 */

const isOpen = (row: RowItem) => !isRowCompletedOn(row, null);

function Dot({ color, hollow, className }: { color: string; hollow?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('size-1.5 shrink-0 rounded-full', className)}
      style={hollow ? { boxShadow: `inset 0 0 0 1.5px ${color}` } : { background: color }}
    />
  );
}

/** A small keycap beside a secondary action; the primary one uses ButtonKey. */
function Cap({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      aria-hidden
      className="font-num inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] border border-border px-1 text-[10.5px] text-muted-foreground"
    >
      {children}
    </kbd>
  );
}

/* ── the key that starts it ──────────────────────────────────────────── */

/**
 * Whether the key (and, once it is pressed, the row) shows at all. A short, unsized braindump reads fine as it
 * is, and a fresh account must see the braindump it always saw; the key
 * arrives once the list is long enough to need it, or once something is sized.
 */
export function wantsDoStuffRow(rows: readonly RowItem[]): boolean {
  const open = rows.filter(isOpen);
  return open.length >= DO_STUFF_MIN_OPEN || open.some((r) => itemSizeOf(r.item));
}

/**
 * The do stuff key: a small keycap in the braindump's header, the twin of
 * Ask's (components/ai/rail/ask-opener.tsx). The bolt is its light: at rest the
 * rim is lit over the bolt's corner and steps down to the hairline before the
 * word, and engaged (hover, focus, press, or doing stuff) the light runs round
 * the whole rim and the chord turns lime. The CSS is app/globals.css, "The do
 * stuff key".
 *
 * It gives way to the header's title and controls by the braindump's own
 * width (the `braindump` container): the key with its chord, then without it,
 * then the bolt alone at the 280px minimum. No chord on the phone, where there
 * is no keyboard to press it on. The chord is the live `do_stuff` binding,
 * never typed by hand.
 */
export function DoStuffKey({ touch }: { touch?: boolean }) {
  const on = useDoStuffStore((s) => s.on);
  const keys = useShortcutKeys('do_stuff');
  const isMac = useMemo(() => isApplePlatform(), []);
  const chord = chordLabel(keys, isMac);
  return (
    <button
      type="button"
      data-do-key=""
      data-on={on ? 'true' : undefined}
      data-testid="do-stuff-start"
      aria-pressed={on}
      aria-label={on ? 'Stop doing stuff' : 'Do stuff'}
      title={`${on ? 'Stop doing stuff' : 'Do stuff'} (${chord})`}
      onClick={() => {
        const s = useDoStuffStore.getState();
        if (s.on) s.stop();
        else s.start();
      }}
      className="titlebar-hole flex h-7 shrink-0 cursor-pointer items-center gap-[7px] rounded-[7px] text-[12px] leading-[17px] font-medium whitespace-nowrap text-foreground"
    >
      <Zap aria-hidden data-do-key-bolt="" className="size-3.5 shrink-0" />
      <span data-do-key-word="">do stuff</span>
      {!touch && (
        <kbd
          aria-hidden
          data-do-key-chord=""
          className="inline-flex h-4 items-center rounded-[4px] px-[4px] pt-px font-sans text-[10.5px] leading-none font-medium tabular-nums"
        >
          {chord}
        </kbd>
      )}
    </button>
  );
}

/* ── the plan ─────────────────────────────────────────────────────────── */

interface Plan {
  lanes: Record<Lane, RowItem[]>;
  facts: ReadonlyMap<string, LaneFacts>;
  laneById: ReadonlyMap<string, Lane>;
  /** The calendar lane's days, by id. */
  days: ReadonlyMap<string, string>;
  /** Rows in the handed-off lane the agent does not hold yet. */
  handOff: readonly string[];
  /** Who they go to; null while nobody can take work. */
  target: AgentAssignee | null;
  /** Everyone who could. */
  targets: readonly AgentAssignee[];
  todayStr: string;
  /** Packs written for the row's current title, by id. */
  packs: ReadonlyMap<string, PrepPack>;
  /** Open rows the AI might get ready, in the order worth asking: do now first. */
  prepCandidates: readonly PrepItem[];
}

/**
 * The rows sorted into lanes. The gates are asked here, at render time, never
 * re-derived: `canHandOff` is the agent's own queue filter, so a row offered
 * the handed-off lane is a row the agent will see.
 */
function usePlan(rows: readonly RowItem[]): Plan {
  const moved = useDoStuffStore((s) => s.moved);
  // Any agent at all, OpenClaw or a connected app (lib/agents-store.ts): the
  // lane is offered when someone could take the row.
  const targets = useHandOffTargets();
  const handTo = useDoStuffStore((s) => s.handTo);
  const canDelegate = targets.length > 0;
  const items = usePlannerStore((s) => s.items);
  const tz = usePlannerStore((s) => s.userTimezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const away = useAwayStore((s) => s.periods);
  const stored = usePrepPacksStore((s) => s.packs);
  const todayStr = toDateStr(new Date(), tz);

  return useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const inactiveIds = inactiveItemIdsOn(
      rows.map((r) => byId.get(r.item.id)).filter((i) => i !== undefined),
      todayStr,
      { userTimezone: tz, routines, seasons, away }
    );
    const lanes: Record<Lane, RowItem[]> = { done: [], now: [], calendar: [], handoff: [], leave: [] };
    const facts = new Map<string, LaneFacts>();
    const laneById = new Map<string, Lane>();
    const packs = new Map<string, PrepPack>();
    for (const row of rows) {
      const item = byId.get(row.item.id);
      const assignee = item && 'assignee' in item ? item.assignee : undefined;
      const pack = stored[row.item.id];
      if (pack && !packIsStale(pack, row.item.title)) packs.set(row.item.id, pack);
      const f: LaneFacts = {
        plannable: row.itemType === 'task',
        canHandOff: !!item && canHandOff(item, { canDelegate, todayStr, inactiveIds }),
        handedOff: !!assignee,
        hasPack: packs.has(row.item.id),
      };
      // A done row stays where it was drawn, in its lane, struck through.
      const lane = laneOf(row.item, f, moved);
      facts.set(row.item.id, f);
      laneById.set(row.item.id, lane);
      lanes[lane].push(row);
    }
    const days = placeOnDays(
      lanes.calendar.filter(isOpen).map((r) => r.item),
      todayStr
    );
    const handOff = lanes.handoff
      .filter((r) => isOpen(r) && !facts.get(r.item.id)?.handedOff)
      .map((r) => r.item.id);
    const prepCandidates = (['now', 'leave', 'calendar'] as const).flatMap((lane) =>
      lanes[lane]
        .filter((r) => isOpen(r) && r.itemType === 'task' && !facts.get(r.item.id)?.handedOff)
        .map((r) => {
          const notes = (byId.get(r.item.id) as { notes?: string } | undefined)?.notes;
          return { id: r.item.id, title: r.item.title, ...(notes ? { notes } : {}) };
        })
    );
    const target = targets.find((t) => sameAssignee(t.assignee, handTo)) ?? targets[0] ?? null;
    return { lanes, facts, laneById, days, handOff, target, targets, todayStr, packs, prepCandidates };
  }, [rows, moved, canDelegate, targets, handTo, items, tz, routines, seasons, away, todayStr, stored]);
}

/** "tomorrow", or the weekday within the week, or "Oct 20". */
function dayLabel(day: string, todayStr: string): string {
  if (day === addDaysStr(todayStr, 1)) return 'tomorrow';
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  for (let n = 2; n < 7; n++) {
    if (day === addDaysStr(todayStr, n)) return date.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/* ── the strip while doing stuff ──────────────────────────────────────── */

export function DoStuffRow({ rows }: { rows: readonly RowItem[] }) {
  const on = useDoStuffStore((s) => s.on);
  const doneCount = useDoStuffStore((s) => s.doneCount);
  const { stop } = useDoStuffStore.getState();
  const plan = usePlan(rows);
  const preparing = usePrepPacksStore((s) => Object.keys(s.preparing).length);

  // Started from the key in the header (DoStuffKey) or its chord; off, there
  // is no strip.
  if (!on) return null;

  const left = plan.lanes.now.filter(isOpen).length;
  // The dots are progress through "do now": filled for what was done this
  // run and hollow for what is left, eight at most.
  const filled = Math.min(doneCount, 8);
  const hollow = Math.max(0, Math.min(left, 8 - filled));
  const label = [
    doneCount > 0 && `${doneCount} done`,
    left > 0 && `${left} to do now`,
    preparing > 0 && 'getting things ready…',
  ]
    .filter(Boolean)
    .join(' · ');

  const pending = plan.days.size + plan.handOff.length;
  const detail = [
    plan.days.size > 0 && `${plan.days.size} on the calendar`,
    plan.handOff.length > 0 && plan.target && `${plan.handOff.length} to ${plan.target.name}`,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <div
      data-testid="do-stuff-on"
      className="mx-[14px] flex h-[34px] shrink-0 items-center gap-2 rounded-[8px] border border-[var(--size-quick)] bg-surface-2 pl-3 pr-1 text-sm font-medium shadow-[0_0_0_3px_color-mix(in_oklab,var(--size-quick)_18%,transparent)]"
    >
      <span className="shrink-0">doing stuff</span>
      <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">{label}</span>
      {/* While there is a plan to make so, its button takes the room. */}
      <span aria-hidden className={cn('ml-auto shrink-0 items-center gap-[3px]', pending > 0 ? 'hidden' : 'flex')}>
        {Array.from({ length: filled }, (_, i) => (
          <Dot key={`f${i}`} color="var(--size-quick)" />
        ))}
        {Array.from({ length: hollow }, (_, i) => (
          <Dot key={`h${i}`} color="var(--muted-foreground)" hollow />
        ))}
      </span>
      {pending > 0 && (
        <Button
          size="sm"
          onClick={() => makeItSo({ days: plan.days, handOff: plan.handOff, to: plan.target?.assignee })}
          data-testid="do-stuff-make-it-so"
          title={`Make it so: ${detail}`}
          aria-label={`Make it so: ${detail}`}
          className="ml-auto h-[26px] shrink-0 gap-1 px-2 text-xs"
        >
          <Check aria-hidden className="size-3" />
          make it so
          <span className="font-num font-normal opacity-80">{pending}</span>
        </Button>
      )}
      <button
        type="button"
        onClick={stop}
        aria-label="Stop doing stuff"
        data-testid="do-stuff-stop"
        className="flex size-[26px] shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/* ── lane headers ─────────────────────────────────────────────────────── */

function LaneHeader({
  lane,
  count,
  index,
  action,
}: {
  lane: Lane;
  count: number;
  index: number;
  action?: React.ReactNode;
}) {
  const def = laneDef(lane);
  return (
    <div
      className="do-stuff-pop flex flex-col"
      style={{ '--pop-delay': `${index * 80}ms` } as React.CSSProperties}
      data-testid={`do-stuff-lane-${lane}`}
    >
      <div className="flex h-[30px] items-center gap-2 px-2 text-[13px]">
        <Dot color={def.color} />
        <span className="font-semibold">{def.label}</span>
        <span className="font-num text-[12.5px] text-muted-foreground">{count}</span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {/* The tinted hairline, and the one shimmer that runs along it when the
          mode opens (do-stuff-rule in globals.css: once, staggered, and off
          under either motion veto). */}
      <div
        aria-hidden
        className="do-stuff-rule mx-1 h-[1.5px] rounded-full"
        style={{ '--rule': def.color, '--rule-delay': `${index * 80}ms` } as React.CSSProperties}
      />
    </div>
  );
}

/* ── who the handed-off lane goes to ──────────────────────────────────── */

/**
 * "to OpenClaw", in the handed-off lane's header: who "make it so" hands the
 * lane to (lib/agent-assignees.ts). A menu once there is more than one agent
 * to pick from, OpenClaw and every connected app that may change the planner;
 * the pick is remembered for the next run.
 */
function HandToPicker({ target, targets }: { target: AgentAssignee; targets: readonly AgentAssignee[] }) {
  const setHandTo = useDoStuffStore.getState().setHandTo;
  if (targets.length < 2) {
    return (
      <span data-testid="do-stuff-hand-to" className="text-xs text-muted-foreground">
        to {target.name}
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="do-stuff-hand-to"
          aria-label={`Hand off to ${target.name}. Change who`}
          className="inline-flex h-6 items-center gap-1 rounded-[6px] px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          to {target.name}
          <ChevronDown aria-hidden className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        {targets.map((t) => (
          <DropdownMenuItem
            key={t.assignee}
            data-testid="do-stuff-hand-to-option"
            onSelect={() => setHandTo(t.assignee)}
            className="gap-2 text-sm"
          >
            <span className="min-w-0 flex-1 truncate">{t.name}</span>
            {t.assignee === target.assignee && <Check aria-hidden className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── the lane chip ────────────────────────────────────────────────────── */

/**
 * The row's lane, as a quiet chip in its trailing slot: out of the layout at
 * rest, so it costs the title nothing, and shown on hover or focus (always on
 * a touch screen, which has no hover). Opens the lanes this row may take, each
 * with its number key.
 */
function LaneChip({ id, lane, facts }: { id: string; lane: Lane; facts: LaneFacts }) {
  const move = useDoStuffStore.getState().move;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Lane: ${laneDef(lane).label}. Move to another lane`}
          data-testid="do-stuff-lane-chip"
          data-lane={lane}
          onKeyDown={(e) => e.stopPropagation()}
          className="-my-1.5 hidden h-[22px] shrink-0 items-center gap-1 rounded-full border border-border px-2 text-[11.5px] whitespace-nowrap text-muted-foreground group-hover:flex group-has-[:focus-visible]:flex hover:text-foreground data-[state=open]:flex [@media(hover:none)]:flex"
        >
          {laneDef(lane).label}
          <ChevronDown aria-hidden className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[196px]"
        onKeyDown={(e) => {
          const picked = laneForDigit(e.key);
          if (!picked || !laneOffered(picked, facts)) return;
          e.preventDefault();
          move(id, picked);
        }}
      >
        {LANES.filter((l) => laneOffered(l.key, facts) || l.key === lane).map((l) => (
          <DropdownMenuItem
            key={l.key}
            onSelect={() => move(id, l.key)}
            data-testid={`do-stuff-move-${l.key}`}
            className={cn(lane === l.key && 'font-medium')}
          >
            <Dot color={l.color} />
            {l.label}
            <span className="ml-auto">
              <Cap>{l.digit}</Cap>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Trailing({
  id,
  lane,
  facts,
  day,
  todayStr,
  pack,
}: {
  id: string;
  lane: Lane;
  facts: LaneFacts;
  day?: string;
  todayStr: string;
  pack?: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {pack}
      {day && (
        <span className="whitespace-nowrap text-[11.5px] text-muted-foreground" data-testid="do-stuff-day">
          {dayLabel(day, todayStr)}
        </span>
      )}
      <LaneChip id={id} lane={lane} facts={facts} />
    </span>
  );
}

/* ── the next thing, lifted ───────────────────────────────────────────── */

/**
 * Focus follows the walk: the card takes focus when it appears, but only if
 * focus was already in the list or nowhere at all — never out of the capture
 * row or a dialog the user is typing in.
 */
function useWalkFocus(ref: React.RefObject<HTMLDivElement | null>, id: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const active = document.activeElement;
    const list = el.closest('[data-do-stuff-list]');
    if (!active || active === document.body || (list && list.contains(active))) {
      el.focus({ preventScroll: true });
      el.scrollIntoView?.({ block: 'nearest' });
    }
  }, [ref, id]);
}

function typing(e: { target: EventTarget | null }): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}

function plainKey(e: React.KeyboardEvent | KeyboardEvent): boolean {
  return !(e.metaKey || e.ctrlKey || e.altKey) && !typing(e);
}

function NextCard({ row, trailing }: { row: RowItem; trailing: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = row.item.id;
  useWalkFocus(ref, id);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!plainKey(e)) return;
    const k = e.key.toLowerCase();
    if (k === 'enter' && e.target === e.currentTarget) doneNext(id);
    else if (k === 's') skipNext(id);
    else if (k === 't') putOnToday(id);
    else return;
    e.preventDefault();
  };
  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="do-stuff-next"
      aria-label={`Up next: ${row.item.title}`}
      className="my-1 rounded-[10px] border border-border bg-surface-2 pb-2 shadow-elev-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <TaskRow row={row} context="braindump" trailing={trailing} />
      <div className="flex items-center gap-1 pl-[30px] pr-2">
        <Button size="sm" onClick={() => doneNext(id)} data-testid="do-stuff-done" aria-keyshortcuts="Enter">
          done
          <ButtonKey />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => skipNext(id)}
          data-testid="do-stuff-skip"
          aria-keyshortcuts="S"
          className="text-muted-foreground"
        >
          skip <Cap>S</Cap>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => putOnToday(id)}
          data-testid="do-stuff-today"
          aria-keyshortcuts="T"
          className="text-muted-foreground"
        >
          today <Cap>T</Cap>
        </Button>
      </div>
    </div>
  );
}

/* ── a row in a lane: number keys and the swipe ───────────────────────── */

/** How far a finger travels sideways before a swipe moves the row. */
const SWIPE_PX = 64;

function LaneRow({
  id,
  lane,
  facts,
  hoveredRef,
  children,
}: {
  id: string;
  lane: Lane;
  facts: LaneFacts;
  hoveredRef: React.RefObject<string | null>;
  children: React.ReactNode;
}) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const end = () => {
    start.current = null;
    setDx(0);
  };
  return (
    <div
      data-lane-row={id}
      onMouseEnter={() => (hoveredRef.current = id)}
      onMouseLeave={() => {
        if (hoveredRef.current === id) hoveredRef.current = null;
      }}
      // The phone's swipe: right moves the row a lane up, left a lane down.
      // Touch only; a mouse drags rows, and long-press is drag on touch.
      onPointerDown={(e) => {
        if (e.pointerType === 'touch') start.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const x = e.clientX - s.x;
        const y = e.clientY - s.y;
        if (Math.abs(y) > 24 && Math.abs(y) > Math.abs(x)) return end();
        setDx(Math.max(-96, Math.min(96, x)));
      }}
      onPointerUp={() => {
        if (Math.abs(dx) >= SWIPE_PX) {
          const to = stepLane(lane, dx > 0 ? -1 : 1, facts);
          if (to !== lane) useDoStuffStore.getState().move(id, to);
        }
        end();
      }}
      onPointerCancel={end}
      className="touch-pan-y"
      style={dx ? { transform: `translateX(${dx}px)` } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * The number keys: 1 to 5 move the row that has focus, or else the one under
 * the pointer, to that lane. Never while typing or with a modifier held, and
 * never when focus is somewhere other than the list (a dialog, the dock).
 */
function useLaneKeys(
  listRef: React.RefObject<HTMLDivElement | null>,
  hoveredRef: React.RefObject<string | null>,
  facts: ReadonlyMap<string, LaneFacts>
) {
  const factsRef = useRef(facts);
  useEffect(() => {
    factsRef.current = facts;
  }, [facts]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !plainKey(e)) return;
      const lane = laneForDigit(e.key);
      if (!lane) return;
      const list = listRef.current;
      if (!list) return;
      const active = document.activeElement as HTMLElement | null;
      let id: string | null | undefined;
      if (active && active !== document.body) {
        if (!list.contains(active)) return;
        id = active.closest<HTMLElement>('[data-lane-row]')?.dataset.laneRow;
      }
      id ??= hoveredRef.current;
      const f = id ? factsRef.current.get(id) : undefined;
      if (!id || !f || !laneOffered(lane, f)) return;
      e.preventDefault();
      useDoStuffStore.getState().move(id, lane);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listRef, hoveredRef]);
}

/**
 * The shuffle: each row flies from where it stood in the braindump to its
 * place in its lane, lifting and tilting a little on the way, staggered. Once,
 * when the mode opens, and not under either motion veto.
 */
function useShuffle(listRef: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const from = takeShuffleFrom();
    const list = listRef.current;
    if (!from || !list || prefersReducedMotion()) return;
    list.querySelectorAll<HTMLElement>('[data-lane-row]').forEach((el, i) => {
      const top = from.get(el.dataset.laneRow ?? '');
      if (top === undefined || typeof el.animate !== 'function') return;
      const dy = top - el.getBoundingClientRect().top;
      const side = i % 2 ? 1 : -1;
      el.animate(
        [
          { transform: `translate(0, ${dy}px)` },
          {
            transform: `translate(${side * 12}px, ${dy * 0.5}px) rotate(${side * 1.2}deg) scale(1.02)`,
            boxShadow: 'var(--shadow-elev-sm)',
            background: 'var(--surface-2)',
            offset: 0.45,
          },
          { transform: 'none' },
        ],
        { duration: 620, delay: i * 25, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'backwards' }
      );
    });
  }, [listRef]);
}

/**
 * When the mode starts, the AI gets what it can ready: the packs already made
 * are read, and the open rows not yet asked about this session are sent to
 * the person's own model, a batch at a time (lib/prep-packs-store.ts). Only
 * while that model is who answers (`canPrep`); otherwise packs already made
 * still show, and nothing is sent anywhere.
 */
function usePrepOnStart(candidates: readonly PrepItem[]) {
  const { canPrep } = useAICapabilities();
  // Who else could take the handed-off lane: asked once each start.
  useEffect(() => {
    void useAgentsStore.getState().load();
  }, []);
  const userId = usePlannerStore((s) => s.userId);
  const candidatesRef = useRef(candidates);
  useEffect(() => {
    candidatesRef.current = candidates;
  }, [candidates]);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    const packs = usePrepPacksStore.getState();
    void packs.load(userId).then(() => {
      if (live && canPrep) void usePrepPacksStore.getState().prepare(candidatesRef.current);
    });
    return () => {
      live = false;
    };
  }, [userId, canPrep]);
}

/* ── the list ─────────────────────────────────────────────────────────── */

/**
 * The braindump while the mode is on. `rows` is the list as the braindump
 * would draw it, already narrowed by the Display menu and in its order; only
 * the grouping is replaced (by lane), never what is in it.
 */
export function DoStuffList({ rows, touch }: { rows: readonly RowItem[]; touch?: boolean }) {
  const skipped = useDoStuffStore((s) => s.skipped);
  const plan = usePlan(rows);
  const listRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef<string | null>(null);
  useShuffle(listRef);
  useLaneKeys(listRef, hoveredRef, plan.facts);
  usePrepOnStart(plan.prepCandidates);
  const prepError = usePrepPacksStore((s) => s.error);

  // The one pack open, by item id. ↑ ↓ walk the "done for you" lane.
  const [peek, setPeek] = useState<string | null>(null);
  const ready = plan.lanes.done.filter((r) => plan.packs.has(r.item.id));
  const peekIndex = ready.findIndex((r) => r.item.id === peek);
  const openPeek = peekIndex >= 0 ? peek : null;
  const go = (dir: -1 | 1) => {
    if (ready.length === 0) return;
    const i = (Math.max(0, peekIndex) + dir + ready.length) % ready.length;
    setPeek(ready[i].item.id);
  };

  // The phone deals every pack ready in a deck, once there is more than one.
  const [deckOpen, setDeckOpen] = useState(false);
  const deckCards = ready
    .filter(isOpen)
    .map((r) => ({ itemId: r.item.id, title: r.item.title, stored: plan.packs.get(r.item.id)! }));

  const next = nextNow(plan.lanes.now, isOpen, skipped);
  const pending = plan.days.size + plan.handOff.length;
  const trailing = (r: RowItem) => {
    const pack = plan.packs.get(r.item.id);
    return (
      <Trailing
        id={r.item.id}
        lane={plan.laneById.get(r.item.id)!}
        facts={plan.facts.get(r.item.id)!}
        day={plan.days.get(r.item.id)}
        todayStr={plan.todayStr}
        pack={
          pack && isOpen(r) ? (
            <PackChip
              stored={pack}
              open={openPeek === r.item.id}
              onToggle={() => setPeek((p) => (p === r.item.id ? null : r.item.id))}
            />
          ) : undefined
        }
      />
    );
  };
  const card = (r: RowItem) => ({
    itemId: r.item.id,
    title: r.item.title,
    stored: plan.packs.get(r.item.id)!,
    nav: ready.length > 1 ? { index: peekIndex, count: ready.length, go } : undefined,
    onClose: () => setPeek(null),
  });

  let shown = 0;
  return (
    <div ref={listRef} data-do-stuff-list className="flex flex-col gap-1" data-testid="do-stuff-list">
      {prepError && (
        <p className="px-2 pb-1 text-xs text-muted-foreground" data-testid="prep-pack-error">
          {prepError}
        </p>
      )}
      {LANES.map((l) => {
        const list = plan.lanes[l.key];
        if (list.length === 0) return null;
        const index = shown++;
        return (
          <section key={l.key} className={cn(index > 0 && 'pt-2')} data-lane={l.key}>
            <LaneHeader
              lane={l.key}
              count={list.filter(isOpen).length}
              index={index}
              action={
                l.key === 'done' && touch && deckCards.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setDeckOpen(true)}
                    data-testid="prep-pack-review"
                    className="h-6 rounded-[6px] px-2 text-xs font-medium text-foreground hover:bg-accent"
                  >
                    review {deckCards.length}
                  </button>
                ) : l.key === 'handoff' && plan.target ? (
                  <HandToPicker target={plan.target} targets={plan.targets} />
                ) : undefined
              }
            />
            <div className="pt-1">
              {list.map((r) => (
                <LaneRow
                  key={r.item.id}
                  id={r.item.id}
                  lane={l.key}
                  facts={plan.facts.get(r.item.id)!}
                  hoveredRef={hoveredRef}
                >
                  {r === next ? (
                    <NextCard row={r} trailing={trailing(r)} />
                  ) : plan.packs.has(r.item.id) && !touch ? (
                    <PackPeek open={openPeek === r.item.id} {...card(r)}>
                      <div>
                        <TaskRow row={r} context="braindump" trailing={trailing(r)} />
                      </div>
                    </PackPeek>
                  ) : (
                    <TaskRow row={r} context="braindump" trailing={trailing(r)} />
                  )}
                  {touch && openPeek === r.item.id && <PackInline {...card(r)} />}
                </LaneRow>
              ))}
            </div>
          </section>
        );
      })}

      {touch && <PackDeck open={deckOpen} onOpenChange={setDeckOpen} cards={deckCards} />}

      {!next && pending === 0 && (
        <p className="px-2 pt-4 text-sm text-muted-foreground" data-testid="do-stuff-clear">
          {plan.lanes.leave.some(isOpen) ? 'nothing to do now. the rest can wait.' : 'all done here. nice.'}
        </p>
      )}
    </div>
  );
}
