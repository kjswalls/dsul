'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Crosshair, ExternalLink, Maximize2, Pin, PinOff } from 'lucide-react';
import { ContainerContextMenu } from '@/components/planner/container-context-menu';
import { ItemMenuRow } from '@/components/planner/item-context-menu';
import { AtlasRow } from '@/components/views/atlas/atlas-row';
import { AtlasTileStrip } from '@/components/views/atlas/atlas-tile-strip';
import { AtlasReason } from '@/components/views/atlas/atlas-reason';
import { AtlasCardDrop } from '@/components/views/atlas/atlas-card-drop';
import { MOMENTUM_BANDS, bandLabel } from '@/lib/atlas-momentum';
import type { AtlasBand } from '@/lib/atlas-positions';
import { useAtlasPointer } from '@/components/views/atlas/use-atlas-pointer';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { touchDay, type AtlasCard as AtlasCardModel, type AtlasMember } from '@/lib/atlas-model';
import { ATLAS_CARD_H, ATLAS_CARD_W } from '@/lib/atlas-seed';
import { formatDay } from '@/lib/active';
import { formatCueTime, type TimeFormat } from '@/lib/reminders/copy';
import { usePlannerStore } from '@/lib/planner-store';
import type { Point, Rect } from '@/lib/atlas-camera';
import { cn } from '@/lib/utils';

/** How long a ticked row stays where it was before the card re-picks. */
const TICK_HOLD_MS = 1500;
/** The view holds a computed layout this long after a tick (and while the pointer is on a card). */
export const ATLAS_TICK_HOLD_MS = TICK_HOLD_MS;

/**
 * The glide between layouts, and the spring back from a drop that meant
 * nothing: transform only, never opacity (D8). Off while dragging and under
 * reduced motion.
 */
export const ATLAS_GLIDE_MS = 550;
export const ATLAS_GLIDE = `transform ${ATLAS_GLIDE_MS}ms cubic-bezier(.2,.8,.2,1)`;
/** A card a filter hides scales down this long, then unmounts. */
export const ATLAS_LEAVE_MS = 150;

/** Momentum's part of a card: its column, the app's, and the stored pin. */
export interface AtlasCardMomentum {
  band: AtlasBand;
  appBand: AtlasBand;
  pinned: boolean;
}

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
  onOpenSheet,
  glide = false,
  leaving = false,
  reason,
  momentumBand,
  momentumAppBand,
  pinned = false,
  onPin,
  onDrag,
  axis = null,
  diamond = false,
  dayAt,
  laneLabel,
  onTick,
  handoff,
}: {
  card: AtlasCardModel;
  at: Point;
  expanded: boolean;
  todayStr: string;
  milestoneIds: ReadonlySet<string>;
  onMove: (key: string, to: Point) => void;
  onToggleExpanded: (key: string) => void;
  onCenter: (rect: Rect) => void;
  /** Grow this card into the focus sheet (double-click, Enter, or Focus). */
  onOpenSheet: (key: string, el: HTMLElement) => void;
  /** Glide to a new place (a layout switch, a spring back). */
  glide?: boolean;
  /** Hidden by a filter: scales down, then the view unmounts it. */
  leaving?: boolean;
  /** The "why" line, in every layout but Your map. */
  reason?: string | null;
  /** Momentum only: the column it is drawn in and the app's own. */
  momentumBand?: AtlasBand;
  momentumAppBand?: AtlasBand;
  /** Momentum only: a pin is stored (Unpin is offered). */
  pinned?: boolean;
  /** Momentum only: pin to a column, or null to hand it back. */
  onPin?: (key: string, band: AtlasBand | null) => void;
  /** Where the card is while dragging (null at the end), to light a lane. */
  onDrag?: (key: string, pos: Point | null) => void;
  axis?: 'x' | null;
  /** Timeline: the goal's diamond above the header, at its target day. */
  diamond?: boolean;
  /** Timeline: the day under the diamond for a top-left x, while dragging. */
  dayAt?: (x: number) => string | null;
  /** The column or lane it is drawn in (computed layouts), for a screen reader. */
  laneLabel?: string;
  /** A row on this card was ticked (the view holds a computed layout). */
  onTick?: (key: string) => void;
  /**
   * In the far zoom's handoff band (PR3): the card shrinks toward its
   * cluster by the world's `--atlas-handoff`, transform only, no glide.
   */
  handoff?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const commit = useCallback((to: Point) => onMove(card.key, to), [onMove, card.key]);
  const drag = useCallback((pos: Point | null) => onDrag?.(card.key, pos), [onDrag, card.key]);
  const { pos, dragging, handlers } = useAtlasPointer({ at, onCommit: commit, onDrag: onDrag ? drag : undefined, axis });
  const momentum = !!momentumBand && !!onPin;

  const held = useTickHold(card);
  const holdRow = held.hold;
  const onRowTicked = useCallback(
    (id: string) => {
      holdRow(id);
      onTick?.(card.key);
    },
    [holdRow, onTick, card.key]
  );
  // Unpin removes its own chip and the card glides to the app's column: focus
  // goes to the card first, so a keyboard user is never dropped on <body>.
  const unpin = useCallback(() => {
    ref.current?.focus({ preventScroll: true });
    onPin?.(card.key, null);
  }, [onPin, card.key]);
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
  // In Momentum the reason line says what the app read (with the server's
  // activity), so the footer keeps only a routine's usual time and never
  // contradicts it.
  const footerRight = touchLine(card, timeFormat, !momentumAppBand);
  // Momentum draws the square from its own band (the activity side channel
  // knows more than the store); every other layout from the store's touch.
  const resting = momentumAppBand ? momentumAppBand === 'resting' : card.resting;

  const openSheet = () => {
    if (ref.current) onOpenSheet(card.key, ref.current);
  };

  const center = () => {
    const h = ref.current?.offsetHeight ?? 0;
    onCenter({ x: at.x, y: at.y, w: ATLAS_CARD_W, h });
  };

  return (
    <article
      ref={ref}
      data-atlas-card={card.key}
      data-atlas-kind={card.kind}
      data-resting={resting ? 'true' : undefined}
      data-all-done={card.allDone ? 'true' : undefined}
      data-click-away-ignore=""
      role="group"
      tabIndex={0}
      aria-label={
        laneLabel
          ? ATLAS_COPY.cardInLane(ATLAS_COPY.cardLabel(card.name, card.kindLabel), laneLabel)
          : ATLAS_COPY.cardLabel(card.name, card.kindLabel)
      }
      {...handlers}
      onPointerEnter={held.onEnter}
      onPointerLeave={held.onLeave}
      onDoubleClick={(e) => {
        // A double-click on a row, the tick box or a control is theirs.
        const t = e.target as Element;
        if (t.closest?.('[data-testid="atlas-row"], button, a, input, [role="checkbox"]')) return;
        openSheet();
      }}
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
      data-leaving={leaving ? 'true' : undefined}
      data-pinned={pinned ? 'true' : undefined}
      style={{
        width: ATLAS_CARD_W,
        transform: `translate(${pos.x}px, ${pos.y}px)${leaving ? ' scale(.96)' : handoff ? ' scale(var(--atlas-handoff, 1))' : ''}`,
        // Transform only (D8). A hidden card scales down quickly; the glide
        // carries a layout switch or a spring back; nothing animates mid-drag.
        transition: dragging || handoff ? 'none' : leaving ? `transform ${ATLAS_LEAVE_MS}ms ease-out` : glide ? ATLAS_GLIDE : undefined,
        pointerEvents: leaving ? 'none' : undefined,
        // The cluster sits at a collapsed card's middle, so a taller
        // (expanded) card still shrinks onto its tiles.
        transformOrigin: handoff && !leaving ? `${ATLAS_CARD_W / 2}px ${ATLAS_CARD_H / 2}px` : undefined,
      }}
    >
      {/* The drop target (PR4): a braindump row, or a row from another card,
          files into this card's container. */}
      <AtlasCardDrop kind={card.kind} id={card.id} name={card.name} disabled={leaving} />
      {diamond && (
        <span
          aria-hidden
          data-testid="atlas-card-diamond"
          className="pointer-events-none absolute -top-[15px] left-1/2 flex -translate-x-1/2 flex-col items-center"
        >
          <i className="size-[11px] rotate-45 rounded-[2px]" style={{ background: card.color }} />
          {dragging && dayAt && (
            <span className="absolute bottom-full mb-1 whitespace-nowrap rounded-md border border-border bg-card px-1.5 py-0.5 text-2xs tabular-nums text-foreground shadow-[var(--shadow-elev-sm)]" data-testid="atlas-drag-day">
              {(() => {
                const day = dayAt(pos.x);
                return day ? ATLAS_COPY.dragTarget(formatDay(day)) : null;
              })()}
            </span>
          )}
        </span>
      )}
      <ContainerContextMenu
        kind={card.kind}
        id={card.id}
        extra={
          <>
            <ItemMenuRow
              icon={<Crosshair className="size-3.5" />}
              label={ATLAS_COPY.centerHere}
              testId="container-menu-center"
              onSelect={center}
            />
            {momentum &&
              MOMENTUM_BANDS.filter((b) => b !== momentumBand).map((b) => (
                <ItemMenuRow
                  key={b}
                  icon={<Pin className="size-3.5" />}
                  label={ATLAS_COPY.pinTo(bandLabel(b))}
                  testId={`container-menu-pin-${b}`}
                  onSelect={() => onPin!(card.key, b === momentumAppBand ? null : b)}
                />
              ))}
            {momentum && pinned && (
              <ItemMenuRow
                icon={<PinOff className="size-3.5" />}
                label={ATLAS_COPY.unpin}
                testId="container-menu-unpin"
                onSelect={unpin}
              />
            )}
          </>
        }
      >
        <header className="flex items-center gap-2 pl-3.5 pr-2 pt-3" data-testid="atlas-card-header">
          <span
            aria-hidden
            data-testid="atlas-card-square"
            className="size-[9px] flex-none rounded-[3px]"
            style={
              resting
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
          the card, so the pointer keeps the card hovered on its way up. */}
      <div
        data-testid="atlas-card-hoverbar"
        className="invisible absolute -top-8 right-1.5 flex gap-0.5 rounded-[10px] border border-border bg-card p-0.5 shadow-[var(--shadow-elev-sm)] after:absolute after:inset-x-0 after:top-full after:h-2 group-hover/card:visible group-focus-within/card:visible"
      >
        <button
          type="button"
          data-testid="atlas-card-focus"
          aria-label={ATLAS_COPY.focusLabel(card.name)}
          onClick={openSheet}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-[7px] px-2 py-1 text-2xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Maximize2 className="size-3" aria-hidden />
          {ATLAS_COPY.focus}
        </button>
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
                onTicked={onRowTicked}
                drag={card.kind}
                containerId={card.id}
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

        {reason !== undefined && (
          <AtlasReason
            text={reason}
            pinned={momentum && pinned}
            name={card.name}
            onUnpin={momentum ? unpin : undefined}
          />
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
export function touchLine(card: AtlasCardModel, timeFormat: TimeFormat, withTouch = true): string {
  const t = card.touch;
  const day = touchDay(t);
  const parts: string[] = [];
  if (!withTouch) return card.usualTime ? ATLAS_COPY.usually(formatCueTime(card.usualTime, timeFormat)) : '';
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
