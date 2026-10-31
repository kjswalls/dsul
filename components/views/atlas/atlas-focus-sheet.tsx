'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import Link from 'next/link';
import { CalendarCheck, ExternalLink, LayoutGrid } from 'lucide-react';
import { AtlasRow } from '@/components/views/atlas/atlas-row';
import { AtlasTileStrip } from '@/components/views/atlas/atlas-tile-strip';
import { touchLine } from '@/components/views/atlas/atlas-card';
import { useAtlasUiStore, type AtlasSheet } from '@/lib/atlas-ui-store';
import { atlasSheetSections, type AtlasCard, type AtlasMember } from '@/lib/atlas-model';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { formatDay } from '@/lib/active';
import { formatCueTime } from '@/lib/reminders/copy';
import { usePlannerStore } from '@/lib/planner-store';
import { canPutOnToday, putNextOnToday } from '@/lib/atlas-verbs';
import { useOpenConsole } from '@/lib/console-door';
import { prefersReducedMotion } from '@/lib/zen-transition';
import type { Viewport } from '@/lib/atlas-camera';
import { cn } from '@/lib/utils';
import { ATLAS_EASE_EXIT, ATLAS_EASE_OUT, ATLAS_MOTION, ATLAS_SHEET_RISE_TOTAL_MS } from '@/lib/atlas-motion';

/**
 * The grow and the shrink (lib/atlas-motion.ts): out of the card on the settle
 * curve, back into it a little quicker on an exit curve, so a close gets out
 * of the way.
 */
const SHEET_OPEN_MS = ATLAS_MOTION.sheetOpenMs;
const SHEET_CLOSE_MS = ATLAS_MOTION.sheetCloseMs;
/** How long a row ticked in the sheet stays in its group before it moves. */
const TICK_HOLD_MS = 1500;
/** Done rows shown before "Show n more": a project keeps every one-off ever filed in it. */
const DONE_CAP = 20;

type Box = AtlasSheet['from'];
type Phase = 'from' | 'open' | 'leaving';
type Group = 'next' | 'later' | 'done' | 'milestones';

/** Organize's section for each card kind (lib/console-door.ts opens it). */
export const CONSOLE_SECTION: Record<AtlasCard['kind'], string> = {
  project: 'projects',
  routine: 'routines',
  season: 'seasons',
  goal: 'goals',
};

/** Where the open sheet sits in the Atlas root: centred, at most 620 by 620. */
export function sheetTarget(viewport: Viewport): Box {
  const width = Math.max(0, Math.min(620, viewport.w - 40));
  const height = Math.max(0, Math.min(620, viewport.h - 48));
  return { x: Math.max(0, (viewport.w - width) / 2), y: 24, width, height };
}

/**
 * The focus sheet (design PR1c): a card grown into a sheet over the map, with
 * every member grouped as Next up, Later and Done, real rows that tick and
 * open in the rail, and the card's actions.
 *
 * Its state is Atlas-local (lib/atlas-ui-store.ts, design D3), never a
 * ui-store `activeDialog` slot: that one slot holds the open item, so a sheet
 * there would close the item, and opening a row from the sheet would close the
 * sheet. Escape is the Atlas root's (atlas-view.tsx), which closes this first
 * and leaves an open item where it is.
 *
 * It grows from the card's rect and shrinks back into it, by left, top, width
 * and height, never opacity (D8); reduced motion jumps. The scrim behind is a
 * colour, not a fade. It sits outside the transformed world, so the camera
 * never scales it, and outside the surface, so the wheel scrolls it instead of
 * panning the map.
 */
export function AtlasFocusSheet({
  cards,
  viewport,
  todayStr,
  milestoneIds,
  rootRef,
}: {
  cards: readonly AtlasCard[];
  viewport: Viewport;
  todayStr: string;
  milestoneIds: ReadonlySet<string>;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const sheet = useAtlasUiStore((s) => s.sheet);
  // `seq` counts opens, so a sheet reopened during the shrink starts fresh
  // (its Done collapsed, no hold) instead of reusing the leaving body.
  const [view, setView] = useState<{ sheet: AtlasSheet; phase: Phase; seq: number } | null>(null);
  const reduce = prefersReducedMotion();

  // Follow the store during render (React's "adjust state when a prop
  // changes"), so the first frame already sits on the card's rect.
  if (sheet && view?.sheet !== sheet) {
    setView({ sheet, phase: reduce ? 'open' : 'from', seq: (view?.seq ?? 0) + 1 });
  } else if (!sheet && view && view.phase !== 'leaving') {
    setView(reduce ? null : { ...view, phase: 'leaving' });
  }

  const phase = view?.phase;
  const key = view ? `${view.sheet.kind}:${view.sheet.id}` : null;

  // Grow: one frame on the card's rect, then the target.
  useEffect(() => {
    if (phase !== 'from') return;
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setView((v) => (v && v.phase === 'from' ? { ...v, phase: 'open' } : v)))
    );
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  // Shrink: back into the card, then gone.
  useEffect(() => {
    if (phase !== 'leaving') return;
    const t = setTimeout(() => setView((v) => (v && v.phase === 'leaving' ? null : v)), SHEET_CLOSE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // On close, focus goes back to the card if it was in the sheet (or
  // nowhere), so the map's keys keep working. The surface stops being inert
  // in the same commit, so the card can take it.
  const prevSheet = useRef<AtlasSheet | null>(null);
  useEffect(() => {
    const prev = prevSheet.current;
    prevSheet.current = sheet;
    if (!prev || sheet) return;
    const active = document.activeElement;
    const inSheet = !!active?.closest('[data-testid="atlas-focus-sheet"]');
    // A press on the scrim leaves focus on the root (the nearest focusable
    // ancestor), which counts as nowhere too.
    if (!inSheet && active && active !== document.body && active !== rootRef.current) return;
    const cardEl = rootRef.current?.querySelector<HTMLElement>(`[data-atlas-card="${prev.kind}:${prev.id}"]`);
    (cardEl ?? rootRef.current)?.focus({ preventScroll: true });
  }, [sheet, rootRef]);

  const card = useMemo(() => (key ? (cards.find((c) => c.key === key) ?? null) : null), [cards, key]);
  const titleId = useId();

  // The card went away (trashed elsewhere, its extension switched off): so does the sheet.
  useEffect(() => {
    if (sheet && !card) useAtlasUiStore.getState().closeSheet();
  }, [sheet, card]);

  // A move into the sheet as it opens, so Escape and Tab start there.
  const sheetRef = useRef<HTMLElement>(null);
  const sheetId = view?.sheet;
  useEffect(() => {
    if (!sheetId) return;
    sheetRef.current?.focus({ preventScroll: true });
  }, [sheetId]);

  // Focus stays in the sheet while it is open. Its content moves under the
  // focused element (Put next step on Today hides itself, a ticked row
  // changes group when its hold ends, Show n more goes), and a removed
  // element drops focus to <body>, where the root's Escape never hears it
  // and Tab starts over at the top of the page. So: remember the row focus
  // was on, and when focus has fallen to nowhere, put it back on that row
  // (its box, if the box had it), or on the sheet.
  const focusInside = useRef(false);
  const lastRow = useRef<{ id: string; check: boolean } | null>(null);
  const keepFocus = useCallback(() => {
    const el = sheetRef.current;
    const active = document.activeElement;
    if (!focusInside.current || !el || (active && active !== document.body)) return;
    if (!useAtlasUiStore.getState().sheet) return;
    const r = lastRow.current;
    const row = r
      ? Array.from(el.querySelectorAll<HTMLElement>('[data-item-id]')).find((n) => n.dataset.itemId === r.id)
      : undefined;
    const check = r?.check ? row?.querySelector<HTMLElement>('[data-testid="atlas-row-check"]') : null;
    (check ?? row ?? el).focus({ preventScroll: true });
  }, []);
  const onSheetFocus = (e: FocusEvent<HTMLElement>) => {
    focusInside.current = true;
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>('[data-item-id]');
    lastRow.current = row?.dataset.itemId
      ? { id: row.dataset.itemId, check: !!t.closest('[data-testid="atlas-row-check"]') }
      : null;
  };
  const onSheetBlur = (e: FocusEvent<HTMLElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to) {
      focusInside.current = !!sheetRef.current?.contains(to);
      return;
    }
    // Nowhere: a click on something unfocusable outside (focus has left), or
    // a browser that blurs an element as it is removed (it has not).
    const from = e.target as HTMLElement;
    queueMicrotask(() => {
      if (from.isConnected) focusInside.current = false;
      else keepFocus();
    });
  };

  // When focus is on <body> anyway (the item opened as an overlay made the
  // page inert), Escape still closes the sheet, and claims the key so the
  // item panel's window listener leaves the item alone (D3). Capture phase,
  // so it runs before that listener whichever registered first. Focus inside
  // the root is the root's own handler (atlas-view.tsx).
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return;
      e.preventDefault();
      useAtlasUiStore.getState().closeSheet();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [sheet]);

  if (!view || !card) return null;

  const box = view.phase === 'open' ? sheetTarget(viewport) : view.sheet.from;
  const open = view.phase === 'open';
  const leaving = view.phase === 'leaving';
  const ms = leaving ? SHEET_CLOSE_MS : SHEET_OPEN_MS;
  const ease = leaving ? ATLAS_EASE_EXIT : ATLAS_EASE_OUT;
  const transition = reduce
    ? 'none'
    : ['left', 'top', 'width', 'height', 'border-radius'].map((p) => `${p} ${ms}ms ${ease}`).join(', ');

  return (
    <>
      <div
        aria-hidden
        data-testid="atlas-sheet-scrim"
        // A press on the scrim closes the sheet and only the sheet.
        data-click-away-ignore=""
        // Keep focus where it is until the close hands it back to the card.
        onMouseDown={(e) => e.preventDefault()}
        // The second click of a double-click on Focus lands here once the
        // sheet is up; it must not shut what the first one opened.
        onClick={(e) => {
          if (e.detail > 1) return;
          useAtlasUiStore.getState().closeSheet();
        }}
        className={cn('absolute inset-0 z-20', open && 'backdrop-blur-[2px]')}
        style={{
          background: open ? 'var(--scrim)' : 'transparent',
          transition: reduce ? 'none' : `background-color ${ATLAS_MOTION.scrimMs}ms ${ATLAS_EASE_OUT}`,
          pointerEvents: view.phase === 'leaving' ? 'none' : undefined,
        }}
      />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        tabIndex={-1}
        onFocus={onSheetFocus}
        onBlur={onSheetBlur}
        data-testid="atlas-focus-sheet"
        data-atlas-sheet={card.key}
        data-phase={view.phase}
        data-click-away-ignore=""
        className="absolute z-[21] flex flex-col overflow-hidden border border-border bg-card text-card-foreground shadow-[var(--shadow-elev-panel)] outline-none"
        // The corners ease from the card's 16px to the sheet's 20px with the box.
        style={{ left: box.x, top: box.y, width: box.width, height: box.height, borderRadius: open ? 20 : 16, transition }}
      >
        <SheetBody
          key={view.seq}
          card={card}
          todayStr={todayStr}
          milestoneIds={milestoneIds}
          titleId={titleId}
          keepFocus={keepFocus}
        />
      </section>
    </>
  );
}

function SheetBody({
  card,
  todayStr,
  milestoneIds,
  titleId,
  keepFocus,
}: {
  card: AtlasCard;
  todayStr: string;
  milestoneIds: ReadonlySet<string>;
  titleId: string;
  keepFocus: () => void;
}) {
  const timeFormat = usePlannerStore((s) => s.timeFormat);
  // The blocks rise only as the sheet opens (the body remounts per open), so
  // one that mounts later (a Done group after a tick) is simply there.
  const [rising, setRising] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setRising(false), ATLAS_SHEET_RISE_TOTAL_MS);
    return () => clearTimeout(t);
  }, []);
  const openConsole = useOpenConsole();
  const [allDone, setAllDone] = useState(false);
  const held = useSheetHold();
  const close = useCallback(() => useAtlasUiStore.getState().closeSheet(), []);
  // After every commit: if what had focus is gone, put focus back (see keepFocus).
  useLayoutEffect(() => {
    keepFocus();
  });

  const sections = useMemo(() => held.apply(atlasSheetSections(card), card), [card, held]);
  const doneShown = allDone ? sections.done : sections.done.slice(0, DONE_CAP);
  const doneMore = sections.done.length - doneShown.length;

  // Every row in the sheet, in DOM order, subtasks under their parent, for Shift's range.
  const rowIds = useMemo(() => {
    const ids: string[] = [];
    const add = (m: AtlasMember) => {
      ids.push(m.item.id);
      for (const s of card.subtasks?.[m.item.id] ?? []) ids.push(s.item.id);
    };
    if (sections.next) add(sections.next);
    sections.later.forEach(add);
    sections.milestones.forEach(add);
    doneShown.forEach(add);
    return ids;
  }, [sections, doneShown, card.subtasks]);

  const touch = touchLine(card, timeFormat);
  const chips = [
    card.targetOn ? ATLAS_COPY.target(formatDay(card.targetOn)) : null,
    // touchLine carries the usual time for a routine already.
    touch || (card.usualTime ? ATLAS_COPY.usually(formatCueTime(card.usualTime, timeFormat)) : null),
  ].filter((c): c is string => !!c);

  const next = sections.next;
  const offerToday = !!next && card.nextOffersToday && canPutOnToday(next, todayStr, milestoneIds);

  const rows = (list: readonly AtlasMember[], group: Group) =>
    list.map((m) => (
      <div key={m.item.id} className="flex flex-col">
        <AtlasRow
          member={m}
          cardKey={card.key}
          cardRowIds={rowIds}
          todayStr={todayStr}
          milestoneIds={milestoneIds}
          onTicked={(id) => held.hold(id, group, list.findIndex((x) => x.item.id === id))}
        />
        {(card.subtasks?.[m.item.id] ?? []).map((s) => (
          <div key={s.item.id} className="pl-6" data-atlas-subtask-of={m.item.id}>
            <AtlasRow
              member={s}
              cardKey={card.key}
              cardRowIds={rowIds}
              todayStr={todayStr}
              milestoneIds={milestoneIds}
            />
          </div>
        ))}
      </div>
    ));

  return (
    // atlas-sheet-body: each block rises a few pixels into place as the sheet
    // opens, staggered, by transform only (globals.css; off under reduced motion).
    <div
      data-rising={rising ? '' : undefined}
      className="atlas-sheet-body flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[22px] pb-[22px] pt-[18px]"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <button
          type="button"
          data-testid="atlas-sheet-back"
          aria-label={ATLAS_COPY.backLabel}
          onClick={close}
          className="rounded-sm text-foreground/80 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {ATLAS_COPY.back}
        </button>
        <span aria-hidden>/</span>
        <span>{card.kindLabel}</span>
      </div>

      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          data-testid="atlas-sheet-square"
          className="size-3 flex-none rounded-[4px]"
          style={
            card.resting
              ? { boxShadow: `inset 0 0 0 1.5px ${card.color}`, background: 'var(--card)' }
              : { background: card.color }
          }
        />
        <h2 id={titleId} className="m-0 min-w-0 flex-1 truncate text-[19px] font-semibold tracking-[-0.01em]">{card.name}</h2>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="atlas-sheet-props">
          {chips.map((c) => (
            <span key={c} className="rounded-full border border-border px-2 py-0.5 text-2xs text-muted-foreground">
              {c}
            </span>
          ))}
        </div>
      )}

      {card.kind !== 'goal' && <AtlasTileStrip card={card} reduced={prefersReducedMotion()} />}

      {/* No next step and nothing to say about it (an ended goal, a paused
          gate): no Next up at all; its members are in Later. */}
      {(next || card.allDone || card.members.length === 0) && (
        <SheetGroup title={ATLAS_COPY.nextUp} testId="atlas-sheet-next">
          {next ? (
            rows([next], 'next')
          ) : (
            <p className="px-[7px] py-1 text-xs text-muted-foreground">
              {card.allDone ? ATLAS_COPY.allDone : ATLAS_COPY.noMembers}
            </p>
          )}
        </SheetGroup>
      )}

      {sections.later.length > 0 && (
        <SheetGroup title={ATLAS_COPY.later} testId="atlas-sheet-later">
          {rows(sections.later, 'later')}
        </SheetGroup>
      )}

      {sections.milestones.length > 0 && (
        <SheetGroup title={ATLAS_COPY.milestonesHeading} testId="atlas-sheet-milestones">
          {rows(sections.milestones, 'milestones')}
        </SheetGroup>
      )}

      {sections.done.length > 0 && (
        <SheetGroup title={ATLAS_COPY.done} testId="atlas-sheet-done">
          {rows(doneShown, 'done')}
          {doneMore > 0 && (
            <button
              type="button"
              data-testid="atlas-sheet-more-done"
              onClick={() => setAllDone(true)}
              className="self-start rounded-md px-[7px] py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {ATLAS_COPY.showMoreDone(doneMore)}
            </button>
          )}
        </SheetGroup>
      )}

      <div className="mt-1 flex flex-wrap gap-2" data-testid="atlas-sheet-actions">
        {offerToday && next && (
          <SheetButton
            testId="atlas-sheet-today"
            onClick={() => putNextOnToday(next.item.id, todayStr, milestoneIds)}
            icon={<CalendarCheck className="size-3.5" aria-hidden />}
          >
            {ATLAS_COPY.putOnToday}
          </SheetButton>
        )}
        <Link
          href={`/${card.kind}/${card.id}`}
          data-testid="atlas-sheet-open-page"
          // Leaving the planner unmounts Atlas; the sheet must not spring back
          // open on the way home. A modified click opens a new tab and keeps it.
          onClick={(e: MouseEvent) => {
            if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) close();
          }}
          className={SHEET_BUTTON}
        >
          {ATLAS_COPY.open}
          <ExternalLink className="size-3" aria-hidden />
        </Link>
        <SheetButton
          testId="atlas-sheet-organize"
          onClick={() => openConsole({ section: CONSOLE_SECTION[card.kind], focusId: card.id })}
          icon={<LayoutGrid className="size-3.5" aria-hidden />}
        >
          {ATLAS_COPY.openInOrganize}
        </SheetButton>
        <button
          type="button"
          data-testid="atlas-sheet-done-button"
          onClick={close}
          aria-keyshortcuts="Escape"
          className="ml-auto inline-flex items-center gap-1.5 rounded-[9px] bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:bg-foreground/90"
        >
          {ATLAS_COPY.closeSheet}
          <kbd aria-hidden className="rounded-[5px] border border-background/30 px-1 font-mono text-[10px] font-semibold">
            {ATLAS_COPY.escKey}
          </kbd>
        </button>
      </div>
    </div>
  );
}

const SHEET_BUTTON =
  'inline-flex items-center gap-1.5 rounded-[9px] border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent';

function SheetButton({
  testId,
  onClick,
  icon,
  children,
}: {
  testId: string;
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button type="button" data-testid={testId} onClick={onClick} className={SHEET_BUTTON}>
      {icon}
      {children}
    </button>
  );
}

function SheetGroup({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <section data-testid={testId} className="flex flex-col">
      <h3 className="mb-0.5 mt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {title}
      </h3>
      <div className="-mx-[7px] flex flex-col">{children}</div>
    </section>
  );
}

/**
 * Holds a row ticked in the sheet in its group, at its place, for
 * TICK_HOLD_MS, so the row below never slides under a second click. The row
 * draws its new state from the card meanwhile.
 */
function useSheetHold() {
  const [held, setHeld] = useState<{ id: string; group: Group; index: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const hold = useCallback((id: string, group: Group, index: number) => {
    setHeld({ id, group, index: Math.max(0, index) });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHeld(null);
    }, TICK_HOLD_MS);
  }, []);
  const apply = useCallback(
    (s: ReturnType<typeof atlasSheetSections>, card: AtlasCard): ReturnType<typeof atlasSheetSections> => {
      if (!held) return s;
      const member = card.members.find((m) => m.item.id === held.id);
      if (!member) return s;
      const strip = (list: AtlasMember[]) => list.filter((m) => m.item.id !== held.id);
      const out = {
        next: s.next?.item.id === held.id ? null : s.next,
        later: strip(s.later),
        done: strip(s.done),
        milestones: strip(s.milestones),
      };
      if (held.group === 'next') {
        // The new next step waits at the head of Later until the hold ends.
        if (out.next) out.later = [out.next, ...out.later];
        out.next = member;
      } else {
        const list = out[held.group];
        out[held.group] = [...list.slice(0, held.index), member, ...list.slice(held.index)];
      }
      return out;
    },
    [held]
  );
  return useMemo(() => ({ hold, apply }), [hold, apply]);
}
