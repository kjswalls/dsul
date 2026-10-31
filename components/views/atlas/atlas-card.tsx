'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Crosshair, ExternalLink } from 'lucide-react';
import { ContainerContextMenu } from '@/components/planner/container-context-menu';
import { ItemMenuRow } from '@/components/planner/item-context-menu';
import { AtlasRow } from '@/components/views/atlas/atlas-row';
import { AtlasTileStrip } from '@/components/views/atlas/atlas-tile-strip';
import { useAtlasPointer } from '@/components/views/atlas/use-atlas-pointer';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { touchDay, type AtlasCard as AtlasCardModel, type AtlasMember } from '@/lib/atlas-model';
import { ATLAS_CARD_W } from '@/lib/atlas-seed';
import { formatDay } from '@/lib/active';
import { formatCueTime, type TimeFormat } from '@/lib/reminders/copy';
import { usePlannerStore } from '@/lib/planner-store';
import type { Point, Rect } from '@/lib/atlas-camera';
import { cn } from '@/lib/utils';

/** How long a ticked row stays where it was before the card re-picks. */
const TICK_HOLD_MS = 1500;

/**
 * Card design A: a 9px square in the container's colour, the name and kind, a
 * tile strip, the next step as a row you can tick, and a footer.
 *
 * The accent never dims (design D8): a resting card's square is HOLLOW (a ring
 * in the container colour), never faded, and nothing on the card carries an
 * opacity. The footer's "resting" comes only from a known old touch or a known
 * pause; a card whose activity is unknown reads neutral (rule 13).
 *
 * ContainerContextMenu wraps the header only, so a row's ItemContextMenu is
 * never nested inside it and the body stays free for the position drag.
 */
export const AtlasCard = memo(function AtlasCard({
  card,
  at,
  expanded,
  todayStr,
  milestoneIds,
  onMove,
  onToggleExpanded,
  onCenter,
}: {
  card: AtlasCardModel;
  at: Point;
  expanded: boolean;
  todayStr: string;
  milestoneIds: ReadonlySet<string>;
  onMove: (key: string, to: Point) => void;
  onToggleExpanded: (key: string) => void;
  onCenter: (rect: Rect) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const commit = useCallback((to: Point) => onMove(card.key, to), [onMove, card.key]);
  const { pos, dragging, handlers } = useAtlasPointer({ at, onCommit: commit });

  const held = useTickHold(card);
  const rows = useMemo(() => {
    const base = expanded ? card.openRows : card.next ? [card.next] : [];
    if (!held.member) return base;
    // The ticked row stays in its slot, drawn with its new state, so a second
    // click lands on it and never on the next item's box.
    if (!expanded) return [held.member];
    const rest = base.filter((m) => m.item.id !== held.member!.item.id);
    return [...rest.slice(0, held.index), held.member, ...rest.slice(held.index)];
  }, [expanded, card.openRows, card.next, held.member, held.index]);
  const rowIds = useMemo(() => rows.map((m) => m.item.id), [rows]);
  const footerLeft =
    card.kind === 'goal'
      ? [ATLAS_COPY.milestones(card.lit, card.total), ATLAS_COPY.feeds(card.feeds ?? 0)].join(' · ')
      : card.total > 0 || card.lit > 0
        ? ATLAS_COPY.count(card.lit, card.total)
        : card.members.length === 0
          ? ATLAS_COPY.noMembers
          : '';
  const timeFormat = usePlannerStore((s) => s.timeFormat);
  const footerRight = touchLine(card, timeFormat);

  const center = () => {
    const h = ref.current?.offsetHeight ?? 0;
    onCenter({ x: at.x, y: at.y, w: ATLAS_CARD_W, h });
  };

  return (
    <article
      ref={ref}
      data-atlas-card={card.key}
      data-atlas-kind={card.kind}
      data-resting={card.resting ? 'true' : undefined}
      data-all-done={card.allDone ? 'true' : undefined}
      data-click-away-ignore=""
      role="group"
      tabIndex={0}
      aria-label={ATLAS_COPY.cardLabel(card.name, card.kindLabel)}
      {...handlers}
      onPointerEnter={held.onEnter}
      onPointerLeave={held.onLeave}
      className={cn(
        'group/card absolute left-0 top-0 flex flex-col rounded-2xl border bg-card text-card-foreground outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring',
        card.allDone ? 'border-dashed border-muted-foreground/60' : 'border-border',
        // Seeding leaves room for a collapsed card; an expanded, hovered or
        // focused one is lifted so the card below never paints over it.
        dragging
          ? 'z-20 cursor-grabbing shadow-[var(--shadow-elev-panel)]'
          : cn('cursor-grab shadow-[var(--shadow-elev-sm)] hover:z-[5] focus-within:z-[5]', expanded && 'z-10')
      )}
      style={{ width: ATLAS_CARD_W, transform: `translate(${pos.x}px, ${pos.y}px)` }}
    >
      <ContainerContextMenu
        kind={card.kind}
        id={card.id}
        extra={
          <ItemMenuRow
            icon={<Crosshair className="size-3.5" />}
            label={ATLAS_COPY.centerHere}
            testId="container-menu-center"
            onSelect={center}
          />
        }
      >
        <header className="flex items-center gap-2 pl-3.5 pr-2 pt-3" data-testid="atlas-card-header">
          <span
            aria-hidden
            data-testid="atlas-card-square"
            className="size-[9px] flex-none rounded-[3px]"
            style={
              card.resting
                ? { boxShadow: `inset 0 0 0 1.5px ${card.color}`, background: 'var(--card)' }
                : { background: card.color }
            }
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{card.name}</span>
          <span className="flex-none text-2xs text-muted-foreground">
            {card.kindLabel}
            {card.targetOn ? ` · ${ATLAS_COPY.target(formatDay(card.targetOn))}` : ''}
          </span>
          {card.openRows.length > 1 && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={expanded ? ATLAS_COPY.collapse : ATLAS_COPY.expand}
              data-testid="atlas-card-expand"
              onClick={() => onToggleExpanded(card.key)}
              className="grid size-6 flex-none place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
            </button>
          )}
        </header>
      </ContainerContextMenu>

      {/* The hover bar: shown on hover or focus within, by visibility, never
          by opacity. Its transparent `after:` block bridges the gap down to
          the card, so the pointer keeps the card hovered on its way up. Focus
          (the sheet) joins it in PR1c. */}
      <div
        data-testid="atlas-card-hoverbar"
        className="invisible absolute -top-8 right-1.5 flex gap-0.5 rounded-[10px] border border-border bg-card p-0.5 shadow-[var(--shadow-elev-sm)] after:absolute after:inset-x-0 after:top-full after:h-2 group-hover/card:visible group-focus-within/card:visible"
      >
        <Link
          href={`/${card.kind}/${card.id}`}
          data-testid="atlas-card-open-page"
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-[7px] px-2 py-1 text-2xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {ATLAS_COPY.open}
          <ExternalLink className="size-3" aria-hidden />
        </Link>
      </div>

      <div className="flex flex-col gap-2 px-3.5 pb-3 pt-2">
        {card.kind === 'goal' ? <MilestoneTrack card={card} /> : <AtlasTileStrip card={card} />}

        {rows.length > 0 ? (
          <div className="-mx-[7px] flex flex-col" data-testid="atlas-card-rows">
            {rows.map((m) => (
              <AtlasRow
                key={m.item.id}
                member={m}
                cardKey={card.key}
                cardRowIds={rowIds}
                todayStr={todayStr}
                milestoneIds={milestoneIds}
                onTicked={held.hold}
              />
            ))}
          </div>
        ) : (
          card.allDone && (
            <p
              data-testid="atlas-card-all-done"
              className="rounded-lg border border-dashed border-muted-foreground/60 px-2 py-1.5 text-xs text-muted-foreground"
            >
              {ATLAS_COPY.allDone}
            </p>
          )
        )}

        {(footerLeft || footerRight) && (
          <footer data-testid="atlas-card-footer" className="flex justify-between gap-2 text-2xs text-muted-foreground">
            <span className="truncate" data-testid="atlas-count">
              {footerLeft}
            </span>
            {footerRight && (
              <span className="flex-none" data-testid="atlas-touch">
                {footerRight}
              </span>
            )}
          </footer>
        )}
      </div>
    </article>
  );
});

/** The footer's right side: the touch line, or a routine's usual time. */
function touchLine(card: AtlasCardModel, timeFormat: TimeFormat): string {
  const t = card.touch;
  const day = touchDay(t);
  const parts: string[] = [];
  if (t.kind === 'touched') parts.push(t.days === 0 ? ATLAS_COPY.touchedToday : ATLAS_COPY.touchedAgo(t.days));
  else if (t.kind === 'resting' && day) parts.push(ATLAS_COPY.restingSince(day));
  else if (t.kind === 'paused') parts.push(day ? ATLAS_COPY.pausedTill(day) : ATLAS_COPY.paused);
  else if (t.kind === 'ended') {
    if (t.reason === 'setAside') parts.push(ATLAS_COPY.setAside);
    else if (t.reason === 'achieved') parts.push(day ? ATLAS_COPY.achievedOn(day) : ATLAS_COPY.achieved);
    else if (day) parts.push(ATLAS_COPY.seasonEnded(day));
  }
  if (card.usualTime) parts.push(ATLAS_COPY.usually(formatCueTime(card.usualTime, timeFormat)));
  return parts.join(' · ');
}

/**
 * Holds a row ticked on this card in its slot until TICK_HOLD_MS has passed
 * and the pointer has left the card, whichever is later. The member is
 * re-resolved from the card's current members, so it draws its new state.
 */
function useTickHold(card: AtlasCardModel) {
  const [heldId, setHeldId] = useState<{ id: string; index: number } | null>(null);
  const inside = useRef(false);
  const timeUp = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const hold = useCallback(
    (id: string) => {
      const list = card.openRows;
      const at = Math.max(0, list.findIndex((m) => m.item.id === id));
      setHeldId({ id, index: at });
      timeUp.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        timeUp.current = true;
        if (!inside.current) setHeldId(null);
      }, TICK_HOLD_MS);
    },
    [card.openRows]
  );
  const onEnter = useCallback(() => {
    inside.current = true;
  }, []);
  const onLeave = useCallback(() => {
    inside.current = false;
    if (timeUp.current) setHeldId(null);
  }, []);

  const member: AtlasMember | null = heldId
    ? (card.members.find((m) => m.item.id === heldId.id) ?? null)
    : null;
  return { member, index: heldId?.index ?? 0, hold, onEnter, onLeave };
}

/** A goal's milestones as diamonds with their dates. Information only. */
function MilestoneTrack({ card }: { card: AtlasCardModel }) {
  const list = card.milestones ?? [];
  if (list.length === 0) return null;
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="atlas-milestones">
      {list.map((m) => (
        <li key={m.id} className="flex items-center gap-1 text-2xs text-muted-foreground" data-milestone-next={m.next ? 'true' : undefined}>
          <i
            aria-hidden
            className="size-2 rotate-45 rounded-[2px]"
            style={
              m.done
                ? { background: card.color }
                : { boxShadow: `inset 0 0 0 1.5px ${m.next ? card.color : 'var(--muted-foreground)'}` }
            }
          />
          <span className="sr-only">{m.title}</span>
          {m.day && <span className="tabular-nums">{formatDay(m.day)}</span>}
        </li>
      ))}
    </ol>
  );
}
