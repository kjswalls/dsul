'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Button, ButtonKey } from '@/components/ui/button';
import { DaySchedule, deriveTimedEntries } from '@/components/views/day-schedule';
import { ItemConversation } from '@/components/ai/item-conversation';
import { openFirstSteps, useCanFirstSteps } from '@/components/sidebar/first-steps';
import { closeDesk, doneNext, skipNext, useDoStuffStore } from '@/lib/do-stuff';
import { freeStretch, stretchLabel } from '@/lib/do-stuff-walk';
import { laneDef } from '@/lib/do-stuff-plan';
import { usePlannerStore } from '@/lib/planner-store';
import { useDayItems } from '@/hooks/use-day-items';
import { useNowMinutes } from '@/lib/use-now-minutes';
import { isRowCompletedOn } from '@/lib/sort-rows';
import { isRowDone, toggleRowDone } from '@/lib/item-toggle';
import { toDateStr } from '@/lib/recurrence';
import { prefersReducedMotion } from '@/lib/zen-transition';
import type { Item, Task } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * The Desk (Kirby's pick, 2026-10-16; memory/plans/power-mode.md, the polish
 * round): while doing stuff, the canvas becomes a room for the current item.
 * The item is set large on the left with what helps to do it (its notes, its
 * steps, a jot box that lands in its notes, and its conversation, so the
 * person's model or OpenClaw can be asked about it right here), and today's
 * real day column stays on the right, the walk's slot in it. It replaces the
 * canvas's view (components/views/view-router.tsx); the braindump and its
 * lanes stay beside it.
 *
 * It follows the walk: done or skip, and the next item takes the desk. Esc or
 * "back to the day" closes it; stopping the mode closes it too. Always today
 * (openDesk brings the canvas to today first), so every tick names today.
 */
export function DoStuffDesk({ activeId }: { activeId: string | null }) {
  const next = useDoStuffStore((s) => s.next);
  const item = usePlannerStore((s) => (next ? s.items.find((i) => i.id === next.id) : undefined));

  // Esc goes back to the day, unless something on top (a dialog, a menu) or a
  // field being typed in takes it first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest('[role="dialog"], [role="menu"]')) return;
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

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(260px,38%)]" data-testid="do-stuff-desk">
      <div className="min-h-0 overflow-y-auto">
        {item ? (
          <DeskItem key={item.id} item={item} />
        ) : (
          <div className="flex h-full flex-col items-start justify-center gap-4 px-10">
            <p className="text-sm text-muted-foreground" data-testid="do-stuff-desk-clear">
              nothing to do now. the rest can wait.
            </p>
            <BackToDay />
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-col border-l border-border" data-testid="do-stuff-desk-day">
        <DaySchedule activeId={activeId} />
      </div>
    </div>
  );
}

function BackToDay() {
  return (
    <button
      type="button"
      onClick={closeDesk}
      data-testid="do-stuff-desk-close"
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      back to the day
      <kbd className="rounded-[4px] border border-border px-1 font-sans text-[10.5px]">Esc</kbd>
    </button>
  );
}

/** "do it now · 1h 20m free until Lunch with Ana · 2 done" */
function useKicker(id: string): string {
  const lane = useDoStuffStore((s) => s.marks.get(id)?.lane);
  const doneCount = useDoStuffStore((s) => s.doneCount);
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
  const label = stretch && nowMin !== null ? stretchLabel(stretch, nowMin) : null;
  return [
    lane && laneDef(lane).label,
    label && `${label.lead} ${label.rest}`,
    doneCount > 0 && `${doneCount} done`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function DeskItem({ item }: { item: Item }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = item.id;
  const kicker = useKicker(id);
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

  // ↵ is done, S skip, F first steps: the list card's keys, while nothing is
  // being typed and focus is on the desk or nowhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && t !== document.body && !ref.current?.contains(t)) return;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 'enter') doneNext(id);
      else if (k === 's') skipNext(id);
      else if (k === 'f' && openFirstSteps(id)) {
        /* first steps */
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  return (
    <div ref={ref} className="mx-auto flex max-w-[620px] flex-col gap-5 px-10 py-10" data-testid="do-stuff-desk-item">
      <p className="text-xs text-muted-foreground" data-testid="do-stuff-desk-kicker">
        {kicker}
      </p>
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
      <Jot item={item} />
      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" onClick={() => doneNext(id)} data-testid="do-stuff-desk-done" aria-keyshortcuts="Enter">
          done
          <ButtonKey />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => skipNext(id)} data-testid="do-stuff-desk-skip" className="text-muted-foreground">
          skip
        </Button>
        {steps && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openFirstSteps(id)}
            data-testid="do-stuff-desk-first-steps"
            className="text-muted-foreground"
          >
            first steps
          </Button>
        )}
        <span className="ml-auto">
          <BackToDay />
        </span>
      </div>
      {/* Talk it through: the item's own conversation, with whoever answers
          (the person's model, or OpenClaw), and the agent's side when the
          item is handed off. Nothing at all when nobody can answer. */}
      <ItemConversation item={item} mode="inline" className="pt-2" />
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
              className="flex w-full items-center gap-2.5 rounded-[6px] py-1 text-left text-sm hover:bg-accent/50"
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
 * doing the thing stays with the thing.
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
  return (
    <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          keep();
        }
      }}
      onBlur={keep}
      rows={2}
      placeholder="jot anything here, it lands in the item's notes"
      aria-label="Jot a note on this item"
      data-testid="do-stuff-desk-jot"
      className="min-h-16 w-full resize-none rounded-[10px] border border-border bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}
