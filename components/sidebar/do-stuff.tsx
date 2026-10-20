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
  closeDesk,
  openDesk,
  putOnToday,
  useDeskHosted,
  commitCount,
  commitLines,
  type Mark,
  skipNext,
  sortDelay,
  takeShuffleFrom,
  useDoStuffStore,
} from '@/lib/do-stuff';
import {
  capNow,
  dayLabel,
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
import { isRecurring, toDateStr } from '@/lib/recurrence';
import { prefersReducedMotion } from '@/lib/zen-transition';
import { packIsStale, type PrepPack } from '@/lib/prep-packs';
import { prepItemFor, usePrepPacksStore, type PrepItem } from '@/lib/prep-packs-store';
import { aiWorkSummary, hasLiveRun, type AiWorkSummary } from '@/lib/ai-work';
import { AiChip, RelayRow } from '@/components/ai/ai-work-badge';
import { PackChip, PackDeck, PackInline, PackPeek } from '@/components/sidebar/prep-pack';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { chordLabel, isApplePlatform } from '@/lib/commands/keys';
import { cn } from '@/lib/utils';
import { openFirstSteps, useCanFirstSteps } from '@/components/sidebar/first-steps';
import { PocketButton } from '@/components/sidebar/do-stuff-pocket';

/**
 * Do stuff: the braindump, and today's anytime rows, sorted into a plan in
 * seven lanes, then walked (memory/plans/power-mode.md, build order 2 and
 * round 5).
 *
 * The key in the header (or the dock) starts it, and the rows glide from where
 * they stood into their lanes: ready / do it now / today / another day / do it
 * for me / later / whatever (lib/do-stuff-plan.ts decides which). Each row
 * carries a lane chip, shown on hover; the keys 1 to 7 move the row under the
 * pointer or the one reached by keyboard, and a swipe moves it on the phone.
 * Only the lane being walked is open; the rest fold to one line (L1). The walk
 * is do it now, then today: the next thing is lifted in place with its actions
 * under it, or opens in today's free stretch on the schedule (do-stuff-slot.tsx)
 * with this row kept as a notch. "Make it so" (the strip, or the dock) puts
 * today on today, another day on its days, hands do it for me to the agent,
 * sends later's today rows back to the braindump and lets whatever go; done,
 * skip, today and first steps write as you go.
 *
 * Nothing shows at rest: no size dots, no chips. Colour lives only in 6px dots
 * and the lane headers' hairlines, the row rail's rule (pills.tsx). The lime
 * appears as the ready dot, the Enter keycap, the notch and the "on" ring, and
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

/** A small keycap beside a secondary action; the primary one uses ButtonKey. The desk's too. */
export function Cap({ children }: { children: React.ReactNode }) {
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
/**
 * What the key says about the AI's work (lib/ai-work.ts): the relay in the
 * bolt's place while anything is being worked on, and "N ready" while packs
 * wait. Packs are read at sign-in (PrepPacksBoot, in the app shell), so the
 * count is there before the mode is first started. The clock ticks only while
 * a handed-off run is live, since only that can go quiet.
 */
function useAiWork(): AiWorkSummary {
  const items = usePlannerStore((s) => s.items);
  const preparing = usePrepPacksStore((s) => s.preparing);
  const packs = usePrepPacksStore((s) => s.packs);
  const live = useMemo(() => hasLiveRun(items), [items]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [live]);
  return useMemo(() => aiWorkSummary(items, { preparing, packs }, now), [items, preparing, packs, now]);
}

export function DoStuffKey({ touch, place = 'header' }: { touch?: boolean; place?: 'header' | 'dock' }) {
  const on = useDoStuffStore((s) => s.on);
  const work = useAiWork();
  const ready = on ? 0 : work.ready;
  const keys = useShortcutKeys('do_stuff');
  const isMac = useMemo(() => isApplePlatform(), []);
  const chord = chordLabel(keys, isMac);
  return (
    <button
      type="button"
      data-do-key=""
      data-do-key-place={place}
      data-on={on ? 'true' : undefined}
      data-testid="do-stuff-start"
      aria-pressed={on}
      aria-label={on ? 'Stop doing stuff' : ready > 0 ? `Do stuff, ${ready} ready` : 'Do stuff'}
      title={`${on ? 'Stop doing stuff' : 'Do stuff'} (${chord})`}
      onClick={() => {
        const s = useDoStuffStore.getState();
        if (s.on) s.stop();
        else s.start();
      }}
      className={cn(
        'titlebar-hole flex shrink-0 cursor-pointer items-center gap-[7px] font-medium whitespace-nowrap text-foreground',
        place === 'dock'
          ? 'h-9 min-w-0 flex-1 rounded-[9px] text-[13px] leading-[18px]'
          : 'h-7 rounded-[7px] text-[12px] leading-[17px]'
      )}
    >
      {work.working ? (
        <RelayRow label="The AI is working" data-do-key-bolt="" />
      ) : (
        <Zap aria-hidden data-do-key-bolt="" className="size-3.5 shrink-0" />
      )}
      <span data-do-key-word="">do stuff</span>
      {ready > 0 && (
        <AiChip aria-hidden data-do-key-ready="" style={{ height: 18, paddingInline: 7 }}>
          {ready} ready
        </AiChip>
      )}
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
  /** Open rows in "today". */
  today: readonly string[];
  /** Rows in the handed-off lane the agent does not hold yet. */
  handOff: readonly string[];
  /** Open rows in "whatever". */
  letGo: readonly string[];
  /** Today's open rows going back to the braindump ("later"). */
  unschedule: readonly string[];
  /** Where every row is going, for the grid. */
  marks: ReadonlyMap<string, Mark>;
  /** Braindump rows coming onto today (do it now and today). */
  arriving: readonly { id: string; title: string }[];
  /**
   * Rows done in the walked lanes, counted rather than drawn: a ticked row
   * leaves its lane, so nothing slides past the rows still to do.
   */
  doneHere: Readonly<Record<'now' | 'today', number>>;
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
function usePlan(dumpRows: readonly RowItem[]): Plan {
  const moved = useDoStuffStore((s) => s.moved);
  // Any agent at all, OpenClaw or a connected app (lib/agents-store.ts): the
  // lane is offered when someone could take the row.
  const targets = useHandOffTargets();
  const handTo = useDoStuffStore((s) => s.handTo);
  const canDelegate = targets.length > 0;
  const items = usePlannerStore((s) => s.items);
  const tasks = usePlannerStore((s) => s.tasks);
  const tz = usePlannerStore((s) => s.userTimezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const away = useAwayStore((s) => s.periods);
  const stored = usePrepPacksStore((s) => s.packs);
  const doneIds = useDoStuffStore((s) => s.doneIds);
  const todayStr = toDateStr(new Date(), tz);

  return useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    // One do stuff (Kirby, 2026-10-13): today's open one-shot rows at no fixed
    // time join the braindump's, after it. A row at a time stays where it is.
    const inDump = new Set(dumpRows.map((r) => r.item.id));
    const onToday = tasks.filter(
      (t) =>
        !inDump.has(t.id) &&
        t.startDate === todayStr &&
        (t.isScheduled || !!t.timeBucket) &&
        !t.startTime &&
        // Open, or done during this run: a today row ticked on the walk stays
        // on the list so "N done here" counts it, as a braindump row does.
        // One done before the run was never the plan's to count.
        (t.status === 'pending' || doneIds.includes(t.id)) &&
        !isRecurring(t)
    );
    const todayIds = new Set(onToday.map((t) => t.id));
    const rows: RowItem[] = [...dumpRows, ...onToday.map((t) => ({ itemType: 'task' as const, item: t }))];
    const inactiveIds = inactiveItemIdsOn(
      rows.map((r) => byId.get(r.item.id)).filter((i) => i !== undefined),
      todayStr,
      { userTimezone: tz, routines, seasons, away }
    );
    const lanes: Record<Lane, RowItem[]> = { done: [], now: [], today: [], calendar: [], handoff: [], leave: [], archive: [] };
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
        onToday: todayIds.has(row.item.id),
      };
      // A done row keeps its lane here; the walked lanes count theirs below.
      const lane = laneOf(row.item, f, moved);
      facts.set(row.item.id, f);
      laneById.set(row.item.id, lane);
      lanes[lane].push(row);
    }
    capNow(lanes, isOpen, moved);
    for (const r of lanes.today) laneById.set(r.item.id, 'today');
    // The walk goes through do it now, then today. A row done there leaves
    // the lane for a count under it (the polish round, 2026-10-16): a struck
    // row that stayed put sat between the card and the rows still to do.
    const doneHere = { now: 0, today: 0 };
    for (const k of ['now', 'today'] as const) {
      const open = lanes[k].filter(isOpen);
      doneHere[k] = lanes[k].length - open.length;
      lanes[k] = open;
    }
    const today = lanes.today.filter((r) => isOpen(r) && !todayIds.has(r.item.id)).map((r) => r.item.id);
    const letGo = lanes.archive.filter(isOpen).map((r) => r.item.id);
    const unschedule = lanes.leave.filter((r) => isOpen(r) && todayIds.has(r.item.id)).map((r) => r.item.id);
    const arriving = [...lanes.now, ...lanes.today]
      .filter((r) => isOpen(r) && !todayIds.has(r.item.id))
      .map((r) => ({ id: r.item.id, title: r.item.title }));
    const days = placeOnDays(
      lanes.calendar.filter(isOpen).map((r) => r.item),
      todayStr
    );
    const handOff = lanes.handoff
      .filter((r) => isOpen(r) && !facts.get(r.item.id)?.handedOff)
      .map((r) => r.item.id);
    const prepCandidates = (['now', 'today', 'leave', 'calendar'] as const).flatMap((lane) =>
      lanes[lane]
        .filter((r) => isOpen(r) && r.itemType === 'task' && !facts.get(r.item.id)?.handedOff)
        .map((r) => {
          const item = byId.get(r.item.id);
          return item ? prepItemFor(item, items) : { id: r.item.id, title: r.item.title };
        })
    );
    const target = targets.find((t) => sameAssignee(t.assignee, handTo)) ?? targets[0] ?? null;
    const marks = new Map<string, Mark>();
    for (const [id, lane] of laneById) marks.set(id, { lane, day: days.get(id), onToday: todayIds.has(id) });
    return {
      lanes,
      facts,
      laneById,
      days,
      today,
      handOff,
      letGo,
      unschedule,
      marks,
      arriving,
      doneHere,
      target,
      targets,
      todayStr,
      packs,
      prepCandidates,
    };
  }, [dumpRows, tasks, moved, canDelegate, targets, handTo, items, tz, routines, seasons, away, todayStr, stored, doneIds]);
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

  const commit = { days: plan.days, today: plan.today, handOff: plan.handOff, letGo: plan.letGo, unschedule: plan.unschedule };
  const pending = commitCount({ ...commit, to: null, left });
  const detail = commitLines({ ...commit, to: plan.target, left }).join(', ');
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
          onClick={() => makeItSo({ ...commit, to: plan.target?.assignee })}
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
  action,
  onFold,
}: {
  lane: Lane;
  count: number;
  action?: React.ReactNode;
  /** Folds an unfolded lane back to its peek; absent on the lane being walked. */
  onFold?: () => void;
}) {
  const def = laneDef(lane);
  return (
    <div
      className="flex flex-col"
      data-lane-head={lane}
      data-testid={`do-stuff-lane-${lane}`}
    >
      <div className="flex h-[30px] items-center gap-2 px-2 text-[13px]">
        <Dot color={def.color} />
        <span className="font-semibold">{def.label}</span>
        <span className="font-num text-[12.5px] text-muted-foreground">{count}</span>
        {def.note && (
          <span className="text-[12px] text-muted-foreground" data-testid="do-stuff-lane-note">
            {def.note}
          </span>
        )}
        {(action || onFold) && (
          <span className="ml-auto flex items-center gap-1">
            {action}
            {onFold && (
              <button
                type="button"
                onClick={onFold}
                aria-label={`Fold ${def.label}`}
                aria-expanded
                data-testid={`do-stuff-fold-${lane}`}
                className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ChevronDown aria-hidden className="size-3.5" />
              </button>
            )}
          </span>
        )}
      </div>
      {/* The tinted hairline. When the mode opens it draws in after the rows
          land and one glint runs along it (useSort, and do-stuff-rule in
          globals.css; off under either motion veto). */}
      <div
        aria-hidden
        className="do-stuff-rule mx-1 h-[1.5px] origin-left rounded-full"
        style={{ '--rule': def.color } as React.CSSProperties}
      />
    </div>
  );
}

/**
 * A lane folded to one line (L1, Kirby's pick, 2026-10-16): its name, how many,
 * and the first few titles, so the list says what is there without asking to
 * be read. Only the lane being walked is open; a click unfolds any other for
 * the rest of the run. Its rule is still drawn, so the start's sort lands the
 * same way.
 */
function LanePeek({
  lane,
  count,
  titles,
  doneHere,
  onOpen,
  action,
}: {
  lane: Lane;
  count: number;
  titles: readonly string[];
  doneHere: number;
  onOpen: () => void;
  /** The lane's own header action (who it goes to, review), kept in reach while folded. */
  action?: React.ReactNode;
}) {
  const def = laneDef(lane);
  const peek = [titles.slice(0, 3).join(', '), doneHere > 0 && `${doneHere} done`].filter(Boolean).join(' · ');
  return (
    <div className="flex flex-col" data-lane-head={lane} data-testid={`do-stuff-lane-${lane}`} data-folded>
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={onOpen}
          aria-expanded={false}
          aria-label={`${def.label}, ${count}. Unfold`}
          data-testid={`do-stuff-peek-${lane}`}
          className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-[7px] px-2 text-left text-[13px] hover:bg-accent/60"
        >
          <Dot color={def.color} />
          <span className="shrink-0 font-semibold">{def.label}</span>
          <span className="font-num shrink-0 text-[12.5px] text-muted-foreground">{count}</span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{peek}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 -rotate-90 text-muted-foreground" />
        </button>
        {action && <span className="shrink-0 pr-2">{action}</span>}
      </div>
      <div
        aria-hidden
        className="do-stuff-rule mx-1 h-[1.5px] origin-left rounded-full"
        style={{ '--rule': def.color } as React.CSSProperties}
      />
    </div>
  );
}

/* ── who the handed-off lane goes to ──────────────────────────────────── */

/**
 * "to OpenClaw", in the handed-off lane's header: who "make it so" hands the
 * lane to (lib/agent-assignees.ts). A menu once there is more than one agent
 * to pick from, OpenClaw and every connected app that may change the planner;
 * the pick is remembered for the next run. An app with no wake
 * (lib/agent-wake.ts) says it waits to be opened, so nobody expects work to
 * start that will not.
 */
const waitsToBeOpened = (t: AgentAssignee) => t.kind !== 'openclaw' && !t.wake;

function HandToPicker({ target, targets }: { target: AgentAssignee; targets: readonly AgentAssignee[] }) {
  const setHandTo = useDoStuffStore.getState().setHandTo;
  if (targets.length < 2) {
    return (
      <span
        data-testid="do-stuff-hand-to"
        className="text-xs text-muted-foreground"
        title={waitsToBeOpened(target) ? `${target.name} picks this up the next time you open it` : undefined}
      >
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
            {waitsToBeOpened(t) && (
              <span className="text-xs text-muted-foreground" data-testid="do-stuff-hand-to-later">
                when opened
              </span>
            )}
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
      {/* Already on today: it joined the plan from the grid, not the braindump. */}
      {facts.onToday && (
        <span
          className="whitespace-nowrap rounded-full border border-border px-1.5 text-[11px] leading-[16px] text-muted-foreground"
          data-testid="do-stuff-today-tag"
        >
          today
        </span>
      )}
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

/**
 * The current item's card arrives after the sort has landed (SORT_SETTLE_MS):
 * the row glides with the others, and only then does its card draw in around
 * it and its actions rise. On done it is a new row's card, in the same place
 * (the done row has left), so its content rises where the last one was.
 */
function useCardArrival(ref: React.RefObject<HTMLDivElement | null>, id: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return;
    const delay = sortDelay();
    const chrome = el.querySelector<HTMLElement>('[data-next-chrome]');
    const notch = el.querySelector<HTMLElement>('[data-next-notch]');
    const actions = el.querySelector<HTMLElement>('[data-next-actions]');
    const rise = [
      { transform: 'translate(0, 6px)', clipPath: 'inset(100% 0 0 0)' },
      { transform: 'none', clipPath: 'inset(0)' },
    ];
    const ease = 'cubic-bezier(.2,.8,.2,1)';
    if (delay > 0) {
      // Never an opacity on the notch or anything holding lime: the chrome is
      // a plain surface, the notch scales in.
      chrome?.animate([{ opacity: 0, transform: 'scale(.98)' }, { opacity: 1, transform: 'none' }], {
        duration: 240,
        delay,
        easing: ease,
        fill: 'backwards',
      });
      notch?.animate([{ transform: 'scaleY(0)' }, { transform: 'none' }], {
        duration: 240,
        delay: delay + 80,
        easing: ease,
        fill: 'backwards',
      });
      actions?.animate(rise, { duration: 220, delay: delay + 120, easing: 'ease-out', fill: 'backwards' });
    } else {
      el.querySelector<HTMLElement>('[data-next-body]')?.animate(rise, { duration: 260, easing: ease });
      notch?.animate([{ transform: 'scaleY(0)' }, { transform: 'none' }], { duration: 240, easing: ease });
    }
  }, [ref, id]);
}

function NextCard({ row, trailing, slim }: { row: RowItem; trailing: React.ReactNode; slim?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = row.item.id;
  useWalkFocus(ref, id);
  useCardArrival(ref, id);
  const steps = useCanFirstSteps(id);
  // The desk key only where a desk can open (the phone's router has none),
  // and a toggle: at the desk the same key is the way back to the day.
  const deskHosted = useDeskHosted();
  const desk = useDoStuffStore((s) => s.desk);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!plainKey(e)) return;
    const k = e.key.toLowerCase();
    if (k === 'enter' && e.target === e.currentTarget) doneNext(id);
    else if (k === 's') skipNext(id);
    else if (k === 't') putOnToday(id);
    else if (k === 'd' && deskHosted) {
      if (desk) closeDesk();
      else openDesk();
    }
    else if (k === 'f' && openFirstSteps(id)) {
      /* first steps, where the AI can break it down */
    } else return;
    e.preventDefault();
  };
  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="do-stuff-next"
      data-slim={slim || undefined}
      aria-label={`${slim ? 'Now' : 'Up next'}: ${row.item.title}`}
      className={cn(
        'relative isolate rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
        !slim && 'my-1 pb-2'
      )}
    >
      {/* While today's schedule holds the current item (do-stuff-slot.tsx),
          this is a row with a lime notch: the slot has the actions. */}
      {!slim && (
        <span
          aria-hidden
          data-next-chrome
          className="absolute inset-0 -z-10 rounded-[10px] border border-border bg-surface-2 shadow-elev-sm"
        />
      )}
      <span
        aria-hidden
        data-next-notch
        className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full bg-primary"
      />
      <div data-next-body>
        <TaskRow row={row} context="braindump" trailing={trailing} />
      </div>
      {!slim && (
        <div data-next-actions className="flex items-center gap-1 pl-[30px] pr-2">
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
          {steps && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openFirstSteps(id)}
              data-testid="do-stuff-first-steps"
              aria-keyshortcuts="F"
              className="text-muted-foreground"
            >
              first steps <Cap>F</Cap>
            </Button>
          )}
          {deskHosted && (
            <Button
              size="sm"
              variant="ghost"
              onClick={desk ? closeDesk : openDesk}
              data-testid={desk ? 'do-stuff-close-desk' : 'do-stuff-open-desk'}
              aria-keyshortcuts="D"
              className="text-muted-foreground"
            >
              {desk ? 'back to the day' : 'desk'} <Cap>D</Cap>
            </Button>
          )}
          <PocketButton />
        </div>
      )}
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
 * The number keys: 1 to 7 move the row under the pointer, or else the row
 * that has focus, to that lane. The pointer wins because the card takes focus
 * on every step of the walk (useWalkFocus): with focus first, hovering a row
 * in "later" and pressing 4 moved the card's item instead. Focus wins only
 * when the user put it there by keyboard (a Tab since the pointer last
 * moved). Never while typing or with a modifier held, and never when focus is
 * somewhere other than the list (a dialog, the dock). F opens that row's first
 * steps (components/sidebar/first-steps.tsx).
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
  // Whether focus was last moved by the keyboard: set on Tab, cleared when
  // the pointer moves.
  const byKeyboard = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') byKeyboard.current = true;
      if (e.defaultPrevented || !plainKey(e)) return;
      const lane = laneForDigit(e.key);
      const steps = e.key.toLowerCase() === 'f';
      if (!lane && !steps) return;
      const list = listRef.current;
      if (!list) return;
      const active = document.activeElement as HTMLElement | null;
      let focused: string | undefined;
      if (active && active !== document.body) {
        if (!list.contains(active)) return;
        focused = active.closest<HTMLElement>('[data-lane-row]')?.dataset.laneRow;
      }
      const id = focused && byKeyboard.current ? focused : (hoveredRef.current ?? focused);
      if (steps) {
        if (id && factsRef.current.has(id) && openFirstSteps(id)) e.preventDefault();
        return;
      }
      if (!lane) return;
      const f = id ? factsRef.current.get(id) : undefined;
      if (!id || !f || !laneOffered(lane, f)) return;
      e.preventDefault();
      useDoStuffStore.getState().move(id, lane);
    };
    const onPointer = () => {
      byKeyboard.current = false;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointermove', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointermove', onPointer);
    };
  }, [listRef, hoveredRef]);
}

/**
 * When rows leave or join (a done row leaving its lane, a move), the rest
 * glide to where they now stand instead of jumping. The current item's row is
 * left out: its card stays put and its content rises (useCardArrival). Before
 * useSort in the list, so it measures the rows before the sort transforms them.
 */
function useReflow(listRef: React.RefObject<HTMLDivElement | null>, order: string, still: string | undefined) {
  const tops = useRef<Map<string, number> | null>(null);
  const lastOrder = useRef(order);
  // Measured after every commit, so the tops it glides from are the ones on
  // screen the moment before the rows changed (a progress line appearing
  // above the lanes moves them too); it only animates when the rows changed.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const base = list.getBoundingClientRect().top;
    // Rows, lane labels and the done counts: every piece that moves on its
    // own, never a section, which would carry its rows twice.
    const keyOf = (el: HTMLElement) => {
      if (el.dataset.laneRow !== undefined) return `r:${el.dataset.laneRow}`;
      const lane = el.closest<HTMLElement>('[data-lane]')?.dataset.lane ?? '';
      return el.dataset.laneHead !== undefined ? `h:${lane}` : `d:${lane}`;
    };
    const els = [...list.querySelectorAll<HTMLElement>('[data-lane-row], [data-lane-head], [data-done-here]')];
    const now = new Map(els.map((el) => [keyOf(el), el.getBoundingClientRect().top - base]));
    const prev = tops.current;
    tops.current = now;
    const changed = lastOrder.current !== order;
    lastOrder.current = order;
    if (!prev || !changed || prefersReducedMotion()) return;
    for (const el of els) {
      const id = keyOf(el);
      const was = prev.get(id);
      if (id === `r:${still}` || typeof el.animate !== 'function') continue;
      if (was === undefined) {
        // A done count appearing rises into the room the done row left.
        if (id.startsWith('d:')) {
          el.animate(
            [
              { transform: 'translate(0, 4px)', clipPath: 'inset(100% 0 0 0)' },
              { transform: 'none', clipPath: 'inset(0)' },
            ],
            { duration: 220, delay: 120, easing: 'ease-out', fill: 'backwards' }
          );
        }
        continue;
      }
      const dy = was - now.get(id)!;
      if (Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(0, ${dy}px)` }, { transform: 'none' }], {
        duration: 280,
        easing: 'cubic-bezier(.2,.8,.2,1)',
      });
    }
  });
}

/** The column's widen to half the window (braindump-pane.tsx, duration-300). */
const WIDEN_MS = 300;
const GLIDE_MS = 420;
const LANE_STAGGER_MS = 40;
const LABEL_MS = 220;
const LABEL_STAGGER_MS = 50;

/**
 * Sort, then label (Kirby's pick, 2026-10-14, over the ripple, whose labels
 * landed on rows that had not moved yet). In order, never overlapping: the
 * column widens with every row held where it stood in the braindump; then the
 * rows glide to their lanes together, a light stagger by lane; then, once they
 * have landed, each lane's label rises into the gap it left and its rule draws
 * left to right, with one glint along it. Once, when the mode opens, and not
 * under either motion veto. The label is revealed with a clip, never an
 * opacity: the do-it-for-me dot is lime.
 */
function useSort(listRef: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const from = takeShuffleFrom();
    const list = listRef.current;
    if (!from || !list || prefersReducedMotion() || typeof list.animate !== 'function') return;
    const moves: { el: HTMLElement; dy: number; lane: number }[] = [];
    const arrivals: { el: HTMLElement; lane: number }[] = [];
    const heads: HTMLElement[] = [];
    for (const el of list.querySelectorAll<HTMLElement>('[data-lane-head], [data-lane-row]')) {
      if (el.dataset.laneHead !== undefined) {
        heads.push(el);
        continue;
      }
      const top = from.get(el.dataset.laneRow ?? '');
      const lane = Math.max(0, heads.length - 1);
      if (top === undefined) arrivals.push({ el, lane });
      else moves.push({ el, dy: top - el.getBoundingClientRect().top, lane });
    }
    if (moves.length === 0) return;
    // A row the braindump never showed (today's, from the grid) has nowhere to
    // glide from: it rises into its lane as that lane's rows arrive, instead
    // of sitting under the rows still on their way.
    for (const { el, lane } of arrivals) {
      el.animate(
        [
          { transform: 'translate(0, 6px)', clipPath: 'inset(100% 0 0 0)' },
          { transform: 'none', clipPath: 'inset(0)' },
        ],
        {
          duration: LABEL_MS,
          delay: WIDEN_MS + lane * LANE_STAGGER_MS + GLIDE_MS * 0.5,
          easing: 'ease-out',
          fill: 'backwards',
        }
      );
    }
    for (const { el, dy, lane } of moves) {
      el.animate([{ transform: `translate(0, ${dy}px)` }, { transform: 'none' }], {
        duration: GLIDE_MS,
        delay: WIDEN_MS + lane * LANE_STAGGER_MS,
        easing: 'cubic-bezier(.2,.8,.2,1)',
        fill: 'backwards',
      });
    }
    // The labels start as the last lane's rows settle, not after the tail of
    // the ease, which reads as a pause.
    const landed = WIDEN_MS + Math.max(...moves.map((m) => m.lane)) * LANE_STAGGER_MS + GLIDE_MS * 0.85;
    heads.forEach((el, i) => {
      const delay = landed + i * LABEL_STAGGER_MS;
      el.animate(
        [
          { transform: 'translate(0, 6px)', clipPath: 'inset(100% 0 0 0)' },
          { transform: 'none', clipPath: 'inset(0)' },
        ],
        { duration: LABEL_MS, delay, easing: 'ease-out', fill: 'backwards' }
      );
      const rule = el.querySelector<HTMLElement>('.do-stuff-rule');
      if (!rule) return;
      rule.animate([{ transform: 'scaleX(0)' }, { transform: 'none' }], {
        duration: 360,
        delay: delay + 80,
        easing: 'cubic-bezier(.2,.8,.2,1)',
        fill: 'backwards',
      });
      rule.style.setProperty('--glint-delay', `${delay + 440}ms`);
      rule.dataset.glint = '';
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
function usePrepOnStart(candidates: readonly PrepItem[], todayStr: string) {
  const { canPrep } = useAICapabilities();
  // Who else could take the handed-off lane: asked once each start.
  useEffect(() => {
    void useAgentsStore.getState().load();
  }, []);
  const userId = usePlannerStore((s) => s.userId);
  const candidatesRef = useRef(candidates);
  const todayRef = useRef(todayStr);
  useEffect(() => {
    candidatesRef.current = candidates;
    todayRef.current = todayStr;
  }, [candidates, todayStr]);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    const packs = usePrepPacksStore.getState();
    void packs.load(userId).then(() => {
      if (live && canPrep) void usePrepPacksStore.getState().prepare(candidatesRef.current, { today: todayRef.current });
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
  // The walk: do it now, then today when do it now is through.
  const next = nextNow(plan.lanes.now, isOpen, skipped) ?? nextNow(plan.lanes.today, isOpen, skipped);
  const slot = useDoStuffStore((s) => s.slot);
  const order = LANES.map((l) => plan.lanes[l.key].map((r) => r.item.id).join(',')).join('|');
  // A row that leaves the list under the pointer (done, let go) fires no
  // mouseleave: the next digit must not move a row that is gone. A row that
  // only changed lanes keeps the pointer, so 2 then 3 on one row still works.
  useEffect(() => {
    const id = hoveredRef.current;
    if (id && !order.split(/[,|]/).includes(id)) hoveredRef.current = null;
  }, [order]);
  useReflow(listRef, order, next?.item.id);
  useSort(listRef);
  useLaneKeys(listRef, hoveredRef, plan.facts);
  usePrepOnStart(plan.prepCandidates, plan.todayStr);
  const prepError = usePrepPacksStore((s) => s.error);
  const docked = useDoStuffStore((s) => s.docked);
  const doneCount = useDoStuffStore((s) => s.doneCount);
  const preparing = usePrepPacksStore((s) => Object.keys(s.preparing).length);
  const left = plan.lanes.now.filter(isOpen).length;

  // What make it so would write, for the dock's key, which has no rows of its
  // own. Republished whenever the plan changes; stop() clears it.
  useEffect(() => {
    useDoStuffStore.setState({
      commit: {
        days: plan.days,
        today: plan.today,
        handOff: plan.handOff,
        letGo: plan.letGo,
        unschedule: plan.unschedule,
        to: plan.target ? { assignee: plan.target.assignee, name: plan.target.name } : null,
        left,
      },
      marks: plan.marks,
      arriving: plan.arriving,
    });
  }, [plan.days, plan.today, plan.handOff, plan.letGo, plan.unschedule, plan.marks, plan.arriving, plan.target, left]);

  // The one pack open, by item id. ↑ ↓ walk every open row with a pack, in
  // the lanes' order: a pack follows its row out of "ready" (moved to do it
  // now, or the current card), so its chip must still open it.
  const [peek, setPeek] = useState<string | null>(null);
  const packed = LANES.flatMap((l) => plan.lanes[l.key]).filter((r) => isOpen(r) && plan.packs.has(r.item.id));
  const peekIndex = packed.findIndex((r) => r.item.id === peek);
  const openPeek = peekIndex >= 0 ? peek : null;
  const go = (dir: -1 | 1) => {
    if (packed.length === 0) return;
    const i = (Math.max(0, peekIndex) + dir + packed.length) % packed.length;
    setPeek(packed[i].item.id);
  };

  // The phone deals every pack in the ready lane in a deck, once there is more than one.
  const [deckOpen, setDeckOpen] = useState(false);
  const deckCards = plan.lanes.done
    .filter((r) => isOpen(r) && plan.packs.has(r.item.id))
    .map((r) => ({ itemId: r.item.id, title: r.item.title, stored: plan.packs.get(r.item.id)! }));

  const pending = plan.days.size + plan.today.length + plan.handOff.length + plan.letGo.length + plan.unschedule.length;
  // Do it now's next, for the up-next card on today (do-stuff-today.tsx).
  const nextId = next?.item.id;
  const nextTitle = next?.item.title;
  useEffect(() => {
    useDoStuffStore.setState({ next: nextId && nextTitle !== undefined ? { id: nextId, title: nextTitle } : null });
  }, [nextId, nextTitle]);
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
    nav: packed.length > 1 ? { index: peekIndex, count: packed.length, go } : undefined,
    onClose: () => setPeek(null),
  });

  // L1: the lane being walked is open, every other folds to a peek until it
  // is asked for. Unfolded lanes stay open for the run (memory only, like the
  // mode). With nothing left to walk, do it now stays the open one.
  const walking: Lane = next && plan.laneById.get(next.item.id) === 'today' ? 'today' : 'now';
  const [unfolded, setUnfolded] = useState<ReadonlySet<Lane>>(() => new Set());
  const setFold = (lane: Lane, open: boolean) =>
    setUnfolded((prev) => {
      const nextSet = new Set(prev);
      if (open) nextSet.add(lane);
      else nextSet.delete(lane);
      return nextSet;
    });

  let shown = 0;
  return (
    <div ref={listRef} data-do-stuff-list className="flex flex-col gap-1" data-testid="do-stuff-list">
      {/* With the dock carrying the key there is no strip: what it said is a
          quiet line above the lanes, and only while there is something to say. */}
      {docked && (doneCount > 0 || preparing > 0) && (
        <p className="px-2 pb-1 text-xs text-muted-foreground" data-testid="do-stuff-progress">
          {[doneCount > 0 && `${doneCount} done`, left > 0 && `${left} to do now`, preparing > 0 && 'getting things ready…']
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {prepError && (
        <p className="px-2 pb-1 text-xs text-muted-foreground" data-testid="prep-pack-error">
          {prepError}
        </p>
      )}
      {LANES.map((l) => {
        const list = plan.lanes[l.key];
        const doneHere = l.key === 'now' || l.key === 'today' ? plan.doneHere[l.key] : 0;
        if (list.length === 0 && doneHere === 0) return null;
        const index = shown++;
        const open = list.filter(isOpen);
        const action =
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
          ) : undefined;
        if (l.key !== walking && !unfolded.has(l.key)) {
          return (
            <section key={l.key} className={cn(index > 0 && 'pt-1')} data-lane={l.key}>
              <LanePeek
                lane={l.key}
                count={open.length}
                titles={open.map((r) => r.item.title)}
                doneHere={doneHere}
                onOpen={() => setFold(l.key, true)}
                action={action}
              />
            </section>
          );
        }
        return (
          <section key={l.key} className={cn(index > 0 && 'pt-2')} data-lane={l.key}>
            <LaneHeader
              lane={l.key}
              count={open.length}
              onFold={l.key === walking ? undefined : () => setFold(l.key, false)}
              action={action}
            />
            <div className="pt-1">
              {list.map((r) => {
                const inner =
                  r === next ? (
                    <NextCard row={r} trailing={trailing(r)} slim={slot} />
                  ) : (
                    <TaskRow row={r} context="braindump" trailing={trailing(r)} />
                  );
                return (
                  <LaneRow
                    key={r.item.id}
                    id={r.item.id}
                    lane={l.key}
                    facts={plan.facts.get(r.item.id)!}
                    hoveredRef={hoveredRef}
                  >
                    {/* Any row with a pack, the card included, opens its peek.
                        It anchors to a plain div: neither forwards a ref. */}
                    {plan.packs.has(r.item.id) && !touch ? (
                      <PackPeek open={openPeek === r.item.id} {...card(r)}>
                        <div>{inner}</div>
                      </PackPeek>
                    ) : (
                      inner
                    )}
                    {touch && openPeek === r.item.id && <PackInline {...card(r)} />}
                  </LaneRow>
                );
              })}
              {doneHere > 0 && (
                <p
                  className="flex items-center gap-1.5 px-2 pt-1 text-xs text-muted-foreground"
                  data-testid="do-stuff-done-here"
                  data-done-here
                >
                  <Check aria-hidden className="size-3" />
                  {doneHere} done here
                </p>
              )}
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
