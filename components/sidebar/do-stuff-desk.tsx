'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button, ButtonKey } from '@/components/ui/button';
import { DaySchedule, deriveTimedEntries } from '@/components/views/day-schedule';
import { ItemConversation } from '@/components/ai/item-conversation';
import { openFirstSteps, useCanFirstSteps } from '@/components/sidebar/first-steps';
import { Cap } from '@/components/sidebar/do-stuff';
import { closeDesk, commitCount, doneNext, finishRun, putOnToday, skipNext, useDoStuffStore } from '@/lib/do-stuff';
import { PackInPanel } from '@/components/sidebar/prep-pack';
import { freeStretch, spanLabel, sprintFor } from '@/lib/do-stuff-walk';
import { SprintButton, SprintRing } from '@/components/sidebar/sprint-ring';
import { PocketButton } from '@/components/sidebar/do-stuff-pocket';
import { NowCapsule } from '@/components/sidebar/now-capsule';
import { dayLabel } from '@/lib/do-stuff-plan';
import { usePlannerStore } from '@/lib/planner-store';
import { useDayItems } from '@/hooks/use-day-items';
import { useNowMinutes } from '@/lib/use-now-minutes';
import { isRowCompletedOn } from '@/lib/sort-rows';
import { isRowDone, toggleRowDone } from '@/lib/item-toggle';
import { toDateStr } from '@/lib/recurrence';
import { prefersReducedMotion } from '@/lib/zen-transition';
import type { Item, Task } from '@/lib/planner-types';
import { cn } from '@/lib/utils';
import { isPopperUp } from '@/lib/popper-up';

/** The jot box grows with what is typed, from two lines to about six. */
const JOT_ROWS_MIN = 2;
const JOT_ROWS_MAX = 6;

/**
 * The Desk (Kirby's pick, 2026-10-16; memory/plans/power-mode.md, the polish
 * round): while doing stuff, the canvas becomes a room for the current item.
 * The item is set large on the left with what helps to do it (its notes, its
 * steps, a jot box that lands in its notes, and its conversation, so the
 * person's model or OpenClaw can be asked about it right here), and today's
 * real day column stays on the right, the walk's slot in it. It replaces the
 * canvas's view (components/views/view-router.tsx, the desk's one host); the
 * braindump and its lanes stay beside it, at the user's own width.
 *
 * It follows the walk: done or skip, and the next item takes the desk. Esc or
 * "back to the day" closes it; stopping the mode closes it too. Always today
 * (openDesk brings the canvas to today first, and leaving today closes it),
 * so every tick names today.
 */
export function DoStuffDesk({ activeId }: { activeId: string | null }) {
  const next = useDoStuffStore((s) => s.next);
  const item = usePlannerStore((s) => (next ? s.items.find((i) => i.id === next.id) : undefined));
  const paneRef = useRef<HTMLDivElement>(null);

  // Esc goes back to the day, unless something on top (a dialog, a menu, a
  // popover) or a field being typed in takes it first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Radix renders every popover and menu inside this wrapper; while one is
      // up it owns Escape (item-dialog.tsx has the same rule).
      if (isPopperUp()) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) {
        t.blur();
        e.preventDefault();
        return;
      }
      e.preventDefault();
      closeDesk();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Always today: the header's ‹ › stays live, and the day column follows the
  // canvas's date. Leaving today closes the desk, which shows the day asked
  // for, rather than a desk whose kicker and ticks describe a day it is not.
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  const tz = usePlannerStore((s) => s.userTimezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    if (toDateStr(selectedDate, tz) !== toDateStr(new Date(), tz)) closeDesk();
  }, [selectedDate, tz]);

  // The room takes the focus as it opens: a screen reader lands on it, and the
  // keys (↵ S T F, Esc) work from the start without a click first.
  useEffect(() => {
    paneRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(320px,38%)]" data-testid="do-stuff-desk">
      <div
        ref={paneRef}
        tabIndex={-1}
        role="region"
        aria-label="Desk"
        data-desk-pane
        className="min-h-0 overflow-y-auto outline-none"
      >
        {/* `next` set but no item (deleted elsewhere, a frame before the plan
            republishes) is nothing, not "nothing to do": the plan says that. */}
        {item ? (
          <DeskItem key={item.id} item={item} />
        ) : next === null ? (
          <EndOfWalk />
        ) : null}
      </div>
      {/* The column sets the day's width, as the phone's screen does: it is
          its own `canvas` container, so the rows' columns size to it rather
          than to the whole canvas, and Radix's table layout (which grows to the
          widest row's min-content) is a block here. `data-dense` gives its
          canvas-containers the phone's gutter (globals.css). */}
      <div
        className="@container/canvas flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-border [&_[data-slot=scroll-area-viewport]>div]:!block"
        data-testid="do-stuff-desk-day"
        data-dense
      >
        <DaySchedule activeId={activeId} hideAnytime />
      </div>
    </div>
  );
}

/** The room's door, top right: ✕, or Esc. */
function BackToDay({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={closeDesk}
      aria-label="Back to the day"
      aria-keyshortcuts="Escape"
      title="Back to the day (Esc)"
      data-testid="do-stuff-desk-close"
      className={cn(
        'flex size-7 items-center justify-center rounded-[8px] border border-border text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
    >
      <X aria-hidden className="size-3.5" />
    </button>
  );
}

/**
 * The strip above the title says one thing (the room's round two, Kirby,
 * 2026-10-18): how long until the next block, "1h 34m till Standup". While a
 * sprint runs its ring already says "22m left", so the strip stays empty: one
 * clock, not two. The lane and the done count live in the lanes.
 */
function useKicker(): { kicker: string; sprint: { minutes: number; until: string | null } | null } {
  const running = useDoStuffStore((s) => !!s.sprint);
  const tz = usePlannerStore((s) => s.userTimezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nowMin = useNowMinutes(tz);
  const day = useDayItems(new Date());
  const todayStr = toDateStr(new Date(), tz);
  const stretch = useMemo(() => {
    if (nowMin === null) return null;
    const blocks = deriveTimedEntries(day).map((e) => ({
      title: e.item.title,
      startMin: e.startMin,
      duration: e.duration,
      done: isRowCompletedOn({ itemType: e.itemType, item: e.item }, todayStr),
    }));
    return freeStretch(blocks, nowMin);
  }, [day, nowMin, todayStr]);
  const kicker =
    stretch?.until && nowMin !== null && !running && stretch.startMin <= nowMin
      ? `${spanLabel(stretch.endMin - nowMin)} till ${stretch.until.title}`
      : '';
  return { kicker, sprint: nowMin === null ? null : sprintFor(stretch, nowMin) };
}

function DeskItem({ item }: { item: Item }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = item.id;
  const { kicker, sprint } = useKicker();
  const then = useDoStuffStore((s) => s.then);
  const steps = useCanFirstSteps(id);
  const notes = (item as { notes?: string }).notes?.trim();

  // A new item rises in where the last one was; the desk itself never moves.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return;
    el.animate(
      [
        { transform: 'translate(0, 10px)', clipPath: 'inset(100% 0 0 0)' },
        { transform: 'none', clipPath: 'inset(0)' },
      ],
      { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' }
    );
  }, []);

  // ↵ is done, S skip, T today, F first steps: the list card's keys, while
  // nothing is being typed and focus is on the desk's pane or nowhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && t !== document.body && !t.closest('[data-desk-pane]')) return;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 'enter') doneNext(id);
      else if (k === 's') skipNext(id);
      else if (k === 't') putOnToday(id);
      else if (k === 'f' && openFirstSteps(id)) {
        /* first steps */
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  return (
    <div ref={ref} className="mx-auto flex min-h-full max-w-[620px] flex-col gap-5 px-10 pt-10" data-testid="do-stuff-desk-item">
      {/* The strip is always drawn, at a height, so the title stands still
          when the time arrives after hydration or a sprint's ring joins it.
          The exit sits at its right end: the room's door, top right. */}
      <div className="flex min-h-9 items-center gap-3">
        <SprintRing size={36} className="shrink-0 pr-1" />
        <p className="font-num min-w-0 flex-1 truncate text-xs text-muted-foreground" data-testid="do-stuff-desk-kicker">
          {kicker}
        </p>
        <BackToDay className="shrink-0" />
      </div>
      <div className="relative">
        {/* The notch: its own element at full strength (lime is never faded). */}
        <span aria-hidden className="absolute -left-4 bottom-1 top-1 w-[3px] rounded-full bg-primary" />
        <h2 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-balance">{item.title}</h2>
      </div>
      {notes && (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground" data-testid="do-stuff-desk-notes">
          {notes}
        </p>
      )}
      <Steps parentId={id} />
      {/* What the AI got ready for it, where the work happens. */}
      <PackInPanel itemId={id} title={item.title} />
      <Jot item={item} />
      {(steps || sprint) && (
        <div className="flex flex-wrap items-center gap-1">
          {steps && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openFirstSteps(id)}
              data-testid="do-stuff-desk-first-steps"
              aria-keyshortcuts="F"
              className="text-muted-foreground"
            >
              first steps <Cap>F</Cap>
            </Button>
          )}
          <SprintButton offer={sprint} forItem={id} />
        </div>
      )}
      {/* Talk it through: the item's own conversation, with whoever answers
          (the person's model, or OpenClaw), and the agent's side when the
          item is handed off. Nothing at all when nobody can answer. */}
      {/* Ask only: Jot above already writes a note (the description), so no
          Ask / Note switch here, or the desk would have two "note" boxes. */}
      <ItemConversation item={item} mode="inline" className="pt-2" />
      {/* The bar (the room's round two): done and skip wait at the foot of
          the room in the list card's capsule (now-capsule.tsx), with what
          comes up next, so the top of it is the item and nothing else.
          Sticky, so a long conversation never pushes them out of reach.
          "today" left it with the card's (Kirby, 2026-10-24): T still does it. */}
      <div className="sticky bottom-0 mt-auto bg-canvas pb-6 pt-2">
        <div
          className="flex items-center gap-1.5 border-t border-border pt-3"
          data-testid="do-stuff-desk-bar"
        >
          <NowCapsule
            title={item.title}
            onDone={() => doneNext(id)}
            onSkip={() => skipNext(id)}
            testIds={{ done: 'do-stuff-desk-done', skip: 'do-stuff-desk-skip' }}
          />
          <PocketButton />
          {then && (
            <span className="ml-auto min-w-0 truncate pr-2 text-xs text-muted-foreground" data-testid="do-stuff-desk-then">
              next · {then.title}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The end of the walk (the room's round two, 2026-10-18: Receipts' receipt
 * card): what got done, and what make it so is about to do with the rest,
 * one line each, then make it so (↵) and the mode ends. With nothing done and
 * nothing to move, it only says the rest can wait.
 */
const RECEIPT_DONE_SHOWN = 3;

function EndOfWalk() {
  const doneIds = useDoStuffStore((s) => s.doneIds);
  const commit = useDoStuffStore((s) => s.commit);
  const items = usePlannerStore((s) => s.items);
  const tz = usePlannerStore((s) => s.userTimezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStr = toDateStr(new Date(), tz);
  const titleOf = (id: string) => items.find((i) => i.id === id)?.title;
  const done = doneIds.map(titleOf).filter((t): t is string => !!t);
  const pending = commitCount(commit);

  useEffect(() => {
    if (pending === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && t !== document.body && !t.closest('[data-desk-pane]')) return;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName))) return;
      e.preventDefault();
      finishRun();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending]);

  if (done.length === 0 && pending === 0) {
    return (
      <div className="flex h-full flex-col items-start justify-center gap-4 px-10">
        <p className="text-sm text-muted-foreground" data-testid="do-stuff-desk-clear">
          nothing to do now. the rest can wait.
        </p>
        <BackToDay />
      </div>
    );
  }

  const moved: { id: string; title: string; where: string }[] = [];
  if (commit) {
    for (const [id, day] of commit.days) {
      const title = titleOf(id);
      if (title) moved.push({ id, title, where: dayLabel(day, todayStr) });
    }
    for (const id of commit.today) {
      const title = titleOf(id);
      if (title) moved.push({ id, title, where: 'today' });
    }
    for (const id of commit.unschedule) {
      const title = titleOf(id);
      if (title) moved.push({ id, title, where: 'later' });
    }
    for (const id of commit.handOff) {
      const title = titleOf(id);
      if (title) moved.push({ id, title, where: commit.to ? `to ${commit.to.name}` : 'for me' });
    }
  }
  const letGo = (commit?.letGo ?? []).map((id) => ({ id, title: titleOf(id) })).filter((r) => r.title);
  const head = [
    `${done.length} done`,
    moved.length > 0 && `${moved.length} moved`,
    letGo.length > 0 && `${letGo.length} let go`,
  ].filter(Boolean);

  return (
    <div className="mx-auto flex max-w-[620px] flex-col gap-4 px-10 py-10" data-testid="do-stuff-receipt">
      <div className="flex min-h-9 items-center justify-end">
        <BackToDay />
      </div>
      <section className="relative rounded-[16px] border border-border bg-card px-5 pb-4 pt-4 shadow-[var(--shadow-elev-sm)]">
        <span aria-hidden className="absolute -left-px bottom-4 top-4 w-[3px] rounded-r-full bg-primary" />
        <h2 className="mb-3 flex flex-wrap gap-x-3 text-[22px] leading-tight font-semibold" data-testid="do-stuff-receipt-head">
          {head.map((h, i) => (
            <span key={i} className={cn(i > 0 && 'text-muted-foreground')}>
              {i > 0 && '· '}
              {h}
            </span>
          ))}
        </h2>
        <ul className="flex flex-col">
          {done.slice(0, RECEIPT_DONE_SHOWN).map((t, i) => (
            <li key={`d${i}`} className="flex min-w-0 items-center gap-2.5 border-t border-border py-2 text-sm">
              <span aria-hidden className="flex size-[15px] shrink-0 items-center justify-center rounded-[4px] bg-primary text-primary-foreground">
                <Check className="size-2.5" strokeWidth={3} />
              </span>
              <span className="min-w-0 truncate">{t}</span>
            </li>
          ))}
          {done.length > RECEIPT_DONE_SHOWN && (
            <li className="border-t border-border py-2 pl-[25px] text-sm text-muted-foreground">
              and {done.length - RECEIPT_DONE_SHOWN} more
            </li>
          )}
          {moved.map((r) => (
            <li key={`m${r.id}`} className="flex min-w-0 items-center gap-2.5 border-t border-border py-2 text-sm" data-testid="do-stuff-receipt-moved">
              <span aria-hidden className="w-[15px] shrink-0 text-center text-muted-foreground">→</span>
              <span className="min-w-0 truncate">{r.title}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{r.where}</span>
            </li>
          ))}
          {letGo.map((r) => (
            <li key={`l${r.id}`} className="flex min-w-0 items-center gap-2.5 border-t border-border py-2 text-sm">
              <span aria-hidden className="w-[15px] shrink-0 text-center text-muted-foreground">–</span>
              <span className="min-w-0 truncate">{r.title}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">let go</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-center gap-3 border-t border-border pt-3">
          {pending > 0 ? (
            <Button size="sm" onClick={finishRun} data-testid="do-stuff-receipt-commit" aria-keyshortcuts="Enter">
              make it so
              <ButtonKey />
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={finishRun} data-testid="do-stuff-receipt-commit">
              that&rsquo;s it for now
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}

/** The item's subtasks, ticked here as anywhere: per today, through the shared toggle. */
function Steps({ parentId }: { parentId: string }) {
  // From items, not `tasks`: that projection leaves subtasks out.
  const items = usePlannerStore((s) => s.items);
  const toggleTaskStatus = usePlannerStore((s) => s.toggleTaskStatus);
  const toggleHabitStatus = usePlannerStore((s) => s.toggleHabitStatus);
  const tz = usePlannerStore((s) => s.userTimezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const steps = useMemo(
    () =>
      items
        .filter((i) => i.type !== 'habit' && 'parentItemId' in i && i.parentItemId === parentId)
        .map((i) => i as unknown as Task)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [items, parentId]
  );
  if (steps.length === 0) return null;
  const dateStr = toDateStr(new Date(), tz);
  const firstOpen = steps.find((t) => !isRowDone({ itemType: 'task', item: t }, dateStr))?.id;
  return (
    <ul className="flex flex-col gap-1.5" data-testid="do-stuff-desk-steps">
      {steps.map((t) => {
        const done = isRowDone({ itemType: 'task', item: t }, dateStr);
        return (
          <li key={t.id}>
            <button
              type="button"
              role="checkbox"
              aria-checked={done}
              onClick={() =>
                toggleRowDone({ itemType: 'task', item: t }, { date: new Date(), dateStr }, { toggleTaskStatus, toggleHabitStatus })
              }
              className="flex w-full items-center gap-2.5 rounded-[6px] py-1 text-left text-sm outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-[15px] shrink-0 items-center justify-center rounded-[4px] border-[1.5px] border-muted-foreground',
                  done && 'border-primary bg-primary text-primary-foreground',
                  !done && t.id === firstOpen && 'border-primary'
                )}
              >
                {done && <Check className="size-2.5" strokeWidth={3} />}
              </span>
              <span className={cn(done && 'text-muted-foreground line-through')}>{t.title}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The jot box: anything typed here lands at the foot of the item's notes, a
 * line at a time (↵ to keep it, ⇧↵ for a new line), so a thought caught while
 * doing the thing stays with the thing. Only ↵ writes: a blur (Esc out, a
 * click away, first steps opening) keeps the draft where it is, since a
 * half-typed line committed on the way out became a note nobody meant. Esc in
 * the box clears the draft and leaves it.
 */
function Jot({ item }: { item: Item }) {
  const [text, setText] = useState('');
  const updateTask = usePlannerStore((s) => s.updateTask);
  const keep = () => {
    const line = text.trim();
    if (!line) return;
    const notes = (item as { notes?: string }).notes?.trimEnd();
    updateTask(item.id, { notes: notes ? `${notes}\n${line}` : line }, { label: 'Jot' });
    setText('');
  };
  const rows = Math.min(JOT_ROWS_MAX, Math.max(JOT_ROWS_MIN, text.split('\n').length));
  return (
    <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          keep();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setText('');
          e.currentTarget.blur();
        }
      }}
      rows={rows}
      placeholder="jot anything here, it lands in the item's notes"
      aria-label="Jot a note on this item"
      data-testid="do-stuff-desk-jot"
      className="w-full resize-none rounded-[10px] border border-border bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}
