'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { format } from 'date-fns';
import { Clock, ListTodo, Repeat } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { MENU_ROW, PANEL } from '@/components/shell/bulk-edit-menu';
import { GridComposer } from '@/components/planner/slot-composer';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMediaQuery } from '@/hooks/use-media-query';
import { usePlannerStore } from '@/lib/planner-store';
import { useSelectionStore } from '@/lib/selection-store';
import { useUIStore } from '@/lib/ui-store';
import { getItemTypeConfig } from '@/lib/item-registry';
import { LANE_PX, PANE_MIN_H, PANE_OFFSET, PANE_TRIM } from '@/lib/schedule-constants';
import type { LanePlan } from '@/lib/schedule-lanes';
import type { Priority } from '@dsul/types';
import { MAX_TRAVEL_PX } from '@/lib/click-away';
import {
  addableTypes,
  clearHoveredSlot,
  composerIsOpen,
  gridScope,
  isHolding,
  minAtY,
  rowScope,
  setHoveredSlot,
  slotStart,
  sweepRange,
  useSlotComposer,
  type SlotTarget,
} from '@/lib/slot-add';

/**
 * Adding on a schedule grid (Day × Schedule, and each Week × Schedule column).
 *
 * The layer lies UNDER the blocks, across the whole events field, so it hears
 * the pointer only where nothing is drawn: a block's pane, its resize edges and
 * its menu all stay the block's. On empty grid:
 *
 *   hover        a dashed slot with its time, where a click would add
 *   click        the composer, in that slot, at the type's default length
 *   drag         sweep out a length in quarter hours, then the composer
 *   right-click  New task / habit / ‹type› here, or in Anytime
 *
 * With a row selected or the item panel open, a plain click lets go of it
 * (lib/click-away.ts) and does nothing else; the slot doesn't show while it
 * would only mean that. The next click adds. A drag and the right-click menu
 * add either way, since neither is a click on nothing.
 *
 * Mouse and pen only. A finger on the grid scrolls it, and a long press is a
 * drag, so touch keeps both.
 *
 * Modifier clicks never add: ⌘/Ctrl-click and Shift-click build selections,
 * and on a Mac Ctrl-click is the right-click, which the menu takes.
 */

type Located = { min: number; lane?: { key: string; leftPct: number; rightPct: number; label: string } };

type Press = {
  pointerId: number;
  x: number;
  y: number;
  at: Located;
  sweeping: boolean;
  /** A composer was open: this press is what puts it away, and only that. */
  composerWasOpen: boolean;
  /** Something was held: this press lets go of it, and only that. */
  holding: boolean;
};

function hasModifier(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/**
 * What a lane seeds onto the item made in it: its project or its priority.
 * The "No project" / "No priority" lanes seed nothing, which is what they mean.
 */
function laneSeed(lane: Located['lane']): { project?: string; priority?: Priority } {
  if (!lane) return {};
  if (lane.key.startsWith('project:')) return { project: lane.label };
  const p = lane.key.startsWith('priority:') ? lane.key.slice('priority:'.length) : null;
  return p && p !== 'none' ? { priority: p as Priority } : {};
}

/** Lanes the layer can seed. Any other axis draws the slot across the field. */
const seedsLane = (key: string) => key.startsWith('project:') || key.startsWith('priority:') || key.startsWith('none:project');

export function SlotLayer({
  date,
  dateStr,
  gridStartHour,
  gridEndHour,
  hourPx,
  lanePlan,
  formatTime,
  disabled,
  compact,
}: {
  date: Date;
  dateStr: string;
  gridStartHour: number;
  gridEndHour: number;
  hourPx: number;
  lanePlan?: LanePlan;
  /** Minutes → the user's clock (12h/24h), with am/pm. */
  formatTime: (min: number, meridiem?: boolean) => string;
  /** A drag of an existing item is under way: the layer stands aside. */
  disabled?: boolean;
  /** A week column: the composer's hint stays one short line. */
  compact?: boolean;
}) {
  const isMobile = useIsMobile();
  const coarse = useMediaQuery('(pointer: coarse)');
  const layerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Located | null>(null);
  const [sweep, setSweep] = useState<{ startMin: number; duration: number; lane?: Located['lane'] } | null>(null);
  const press = useRef<Press | null>(null);
  const lastPress = useRef<Press | null>(null);
  const swallowClick = useRef(false);
  const [menuSlot, setMenuSlot] = useState<Located | null>(null);
  const itemTypes = usePlannerStore((s) => s.itemTypes);
  const scope = gridScope(compact ? 'week' : 'day', dateStr);
  const target = useSlotComposer((s) => (s.target?.kind === 'grid' && s.target.scope === scope ? s.target : null));
  const open = useSlotComposer((s) => s.open);
  // Reactive only for the slot's visibility; every decision reads isHolding() at the press.
  const holding = useSelectionStore((s) => s.selectedIds.size > 0);
  const panelOpen = useUIStore((s) => s.activeDialog?.type === 'edit-item');
  // A view switch under a resting pointer fires no pointerleave.
  useEffect(() => () => clearHoveredSlot(scope), [scope]);

  const pointerOnly = !(isMobile || coarse);
  const y = (min: number) => ((min - gridStartHour * 60) / 60) * hourPx;

  const locate = (e: { clientX: number; clientY: number }): Located | null => {
    const el = layerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const min = minAtY(e.clientY - r.top, gridStartHour, hourPx);
    if (lanePlan?.mode !== 'lanes' || r.width === 0) return { min };
    const pct = ((e.clientX - r.left) / r.width) * 100;
    const lane =
      lanePlan.lanes.find((l) => pct >= l.leftPct && pct <= 100 - l.rightPct) ??
      lanePlan.lanes[lanePlan.lanes.length - 1];
    if (lane && !seedsLane(lane.key)) return { min };
    return { min, lane: lane && { key: lane.key, leftPct: lane.leftPct, rightPct: lane.rightPct, label: lane.label } };
  };

  const slotTarget = (at: Located, extra: Partial<Extract<SlotTarget, { kind: 'grid' }>> = {}): SlotTarget => ({
    kind: 'grid',
    scope,
    dateStr,
    startMin: slotStart(at.min, gridStartHour, gridEndHour),
    duration: getItemTypeConfig(extra.type ?? 'task').schedule.defaultBlockMinutes,
    lane: at.lane && { key: at.lane.key, leftPct: at.lane.leftPct, rightPct: at.lane.rightPct },
    ...laneSeed(at.lane),
    ...extra,
  });

  /** Left and right edges of a slot: the lane's band when there are lanes, the field otherwise. */
  const band = (lane?: { leftPct: number; rightPct: number }) => ({
    left: lane ? `calc(${lane.leftPct}% + ${LANE_PX}px)` : LANE_PX,
    right: lane ? `calc(${lane.rightPct}% + 4px)` : 4,
  });

  const box = (startMin: number, duration: number) => ({
    top: y(startMin) + PANE_OFFSET,
    height: Math.max((duration / 60) * hourPx - PANE_TRIM, PANE_MIN_H),
  });

  if (disabled || !pointerOnly) {
    // Touch and an active drag: nothing of ours, and no slot left behind.
    return target ? (
      <GridComposer
        target={target}
        timeLabel={rangeLabel(target.startMin, target.duration, formatTime)}
        style={{ ...box(target.startMin, target.duration), ...band(target.lane), zIndex: 16 }}
        hintBelow={!compact}
      />
    ) : null;
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || hasModifier(e) || e.pointerType === 'touch') {
      press.current = null;
      return;
    }
    const at = locate(e);
    if (!at) return;
    // A click that never came (the press ended off the layer) must not eat the next one.
    swallowClick.current = false;
    press.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      at,
      sweeping: false,
      composerWasOpen: composerIsOpen(),
      holding: isHolding(),
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    const p = press.current;
    if (p && p.pointerId === e.pointerId && (e.buttons & 1) === 1) {
      if (!p.sweeping && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MAX_TRAVEL_PX) {
        p.sweeping = true;
        layerRef.current?.setPointerCapture(e.pointerId);
        setHover(null);
      }
      if (p.sweeping) {
        // A mouse drag is a text-selection drag too; the sweep is the only thing it draws.
        window.getSelection()?.removeAllRanges();
        const at = locate(e);
        if (at) setSweep({ ...sweepRange(p.at.min, at.min, gridStartHour, gridEndHour), lane: p.at.lane });
      }
      return;
    }
    const at = locate(e);
    if (!at) return;
    const startMin = slotStart(at.min, gridStartHour, gridEndHour);
    if (!hover || slotStart(hover.min, gridStartHour, gridEndHour) !== startMin || hover.lane?.key !== at.lane?.key) {
      setHover(at);
      setHoveredSlot(slotTarget(at));
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    press.current = null;
    if (!p || p.pointerId !== e.pointerId) return;
    if (!p.sweeping) {
      lastPress.current = p;
      return;
    }
    lastPress.current = null;
    layerRef.current?.releasePointerCapture(e.pointerId);
    const at = locate(e);
    const range = sweepRange(p.at.min, at?.min ?? p.at.min, gridStartHour, gridEndHour);
    setSweep(null);
    // The click that ends a drag lands here too; it is the drag's, not a click.
    swallowClick.current = true;
    open(slotTarget(p.at, { startMin: range.startMin, duration: range.duration }));
  };

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    const p = lastPress.current;
    lastPress.current = null;
    if (!p || e.detail > 1 || hasModifier(e)) return;
    if (p.composerWasOpen || p.holding) return;
    open(slotTarget(p.at));
    setHover(null);
  };

  const onLeave = () => {
    if (press.current?.sweeping) return;
    setHover(null);
    setHoveredSlot(null);
  };

  const showSlot = hover && !sweep && !target && !holding && !panelOpen;
  const hoverStart = hover ? slotStart(hover.min, gridStartHour, gridEndHour) : 0;
  const hoverLen = getItemTypeConfig('task').schedule.defaultBlockMinutes;
  const menuStart = menuSlot ? slotStart(menuSlot.min, gridStartHour, gridEndHour) : 0;
  const addFromMenu = (type: string) => {
    if (!menuSlot) return;
    open(slotTarget(menuSlot, { type, duration: getItemTypeConfig(type).schedule.defaultBlockMinutes }));
  };

  return (
    <>
      <ContextMenu
        onOpenChange={(next) => {
          if (next) setHover(null);
        }}
      >
        <ContextMenuTrigger
          asChild
          onContextMenu={(e) => {
            setMenuSlot(locate(e));
          }}
        >
          <div
            ref={layerRef}
            data-testid="slot-layer"
            data-slot-date={dateStr}
            data-slot-scope={scope}
            className="absolute inset-0"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              press.current = null;
              setSweep(null);
            }}
            onPointerLeave={onLeave}
            onClick={onClick}
          />
        </ContextMenuTrigger>
        <ContextMenuContent
          className={PANEL}
          data-testid="slot-context-menu"
          // The composer takes the focus as it opens; the menu must not take it back.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <ContextMenuLabel className="truncate px-2 py-1 text-2xs font-normal text-muted-foreground">
            {format(date, 'EEE MMM d')}, {formatTime(menuStart)}
          </ContextMenuLabel>
          {addableTypes(itemTypes).map((t) => (
            <ContextMenuItem
              key={t.name}
              className={MENU_ROW}
              data-testid={`slot-menu-new-${t.name}`}
              onSelect={() => addFromMenu(t.name)}
            >
              {t.name === 'habit' ? (
                <Repeat className="size-3.5 text-muted-foreground" />
              ) : (
                <ListTodo className="size-3.5 text-muted-foreground" />
              )}
              <span className="flex-1">
                {t.name === 'habit' ? `New habit at ${formatTime(menuStart)}` : `New ${t.label.toLowerCase()} here`}
              </span>
              {t.name === 'habit' && <span className="text-2xs text-muted-foreground">repeats</span>}
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem
            className={MENU_ROW}
            data-testid="slot-menu-anytime"
            onSelect={() => open({ kind: 'row', scope: rowScope('anytime', dateStr), dateStr, bucket: 'anytime' })}
          >
            <Clock className="size-3.5 text-muted-foreground" />
            New task in Anytime
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {showSlot && (
        <div
          aria-hidden
          data-testid="slot-ghost"
          className="pointer-events-none absolute z-[1] flex items-start gap-1.5 rounded-[5px] border border-dashed px-2.5 pt-[7px]"
          style={{
            ...box(hoverStart, hoverLen),
            ...band(hover.lane),
            borderColor: 'color-mix(in oklab, var(--foreground) 28%, transparent)',
            background: 'color-mix(in oklab, var(--foreground) 3%, transparent)',
          }}
        >
          <span className="font-num text-2xs leading-none text-muted-foreground">+ {formatTime(hoverStart)}</span>
        </div>
      )}

      {sweep && (
        <div
          aria-hidden
          data-testid="slot-sweep"
          className="pointer-events-none absolute z-[16] flex items-start gap-2 rounded-[5px] border px-2.5 pt-[7px] shadow-[var(--sched-shadow)]"
          style={{
            top: y(sweep.startMin) + PANE_OFFSET,
            height: Math.max((sweep.duration / 60) * hourPx - PANE_TRIM, 12),
            ...band(sweep.lane),
            borderColor: 'color-mix(in oklab, var(--input), var(--foreground) 40%)',
            background: 'color-mix(in oklab, var(--foreground) 5%, var(--sched-pane))',
          }}
        >
          {/* The sweep's rail: the drop line's lime, at full strength, in the lane. */}
          <span
            className="absolute top-[-3px] w-[2px] rounded-[1px] bg-[var(--accent-8)] shadow-[0_0_6px_var(--accent-8)]"
            style={{ left: 5 - LANE_PX - 1, height: `calc(100% + 6px)` }}
          />
          <span className="font-num text-2xs leading-none text-foreground">
            {rangeLabel(sweep.startMin, sweep.duration, formatTime)}
          </span>
        </div>
      )}

      {target && (
        <GridComposer
          target={target}
          timeLabel={rangeLabel(target.startMin, target.duration, formatTime)}
          style={{ ...box(target.startMin, target.duration), ...band(target.lane), zIndex: 16 }}
          hintBelow={!compact}
        />
      )}
    </>
  );
}

/** "3:30–4:00 pm": the block's own range, am/pm once. */
function rangeLabel(startMin: number, duration: number, formatTime: (min: number, meridiem?: boolean) => string) {
  return `${formatTime(startMin, false)}–${formatTime(startMin + duration)}`;
}
