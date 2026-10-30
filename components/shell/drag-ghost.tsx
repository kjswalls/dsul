'use client';

import { useLayoutEffect, useRef } from 'react';
import { DragOverlay, useDndContext, type DropAnimation, type Modifier } from '@dnd-kit/core';
import { usePlannerStore } from '@/lib/planner-store';
import { useDragStore } from '@/lib/drag-store';
import { useSelectionStore } from '@/lib/selection-store';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { useTimeFormat } from '@/lib/use-time-format';
import { formatClock } from '@/components/views/day-schedule';
import { prefersReducedMotion } from '@/lib/zen-transition';
import { ghostShapeFor, ghostSize, ghostTransform, type GhostShape } from '@/lib/dnd/ghost-shape';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * The thing under the pointer while a row or block is dragged (Kirby's pick B,
 * 2026-10-30). It picks up as an exact twin of what was grabbed — a clone of
 * the grabbed element, at its size — and over another place takes the shape it
 * would land as there (lib/dnd/ghost-shape.ts): a row never wider than the list
 * under it, or a block snapped to the hour on a schedule grid. It used to be one
 * fixed card for every source, wider and taller than any row.
 *
 * The clone is markup only: its test ids, item ids and dnd markers are stripped
 * (a second `item-card` would answer every test that counts rows), and it is
 * inert. The grabbed element itself draws as a hollow slot while the twin is
 * away (`.drag-source`, globals.css), so only one copy of the row is ever lit.
 *
 * Its own subscriber, like before: mounting the ghost never waits on an AppShell
 * render. useDndContext re-renders this on every move, which DragOverlay does
 * anyway; the clone is taken once per drag, never per render.
 */

/** Attributes a twin must not carry: identity, test hooks, dnd and settle markers. */
const STRIP_ATTRS = /^(id|data-testid|data-item-id|data-block-id|data-dnd-.*|data-settle-.*|data-reorder-.*|tabindex|role|aria-.*)$/;

/** Exported for tests/unit/drag-ghost.test.tsx. */
export function scrub(el: Element) {
  for (const a of [...el.attributes]) if (STRIP_ATTRS.test(a.name)) el.removeAttribute(a.name);
  for (const child of el.children) scrub(child);
}

/** The grabbed element, cloned once when the drag starts. */
function CloneTwin({ node }: { node: HTMLElement }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const clone = node.cloneNode(true) as HTMLElement;
    scrub(clone);
    clone.classList.remove('drag-source');
    clone.style.width = '100%';
    clone.style.height = '100%';
    clone.style.margin = '0';
    host.current?.replaceChildren(clone);
  }, [node]);
  return <div ref={host} className="h-full w-full" />;
}

/** A row drawn from a block carried to a list: TaskRow's box, checkbox and title. */
function RowTwin({ title }: { title: string }) {
  return (
    <div className="flex h-full w-full items-center gap-3 rounded-[5px] px-2">
      <span className="h-4 w-4 flex-shrink-0 rounded-[5px] bg-surface-3 inset-ring inset-ring-muted-foreground/45" />
      <span className="min-w-0 flex-1 truncate font-content text-content text-foreground">{title}</span>
    </div>
  );
}

/** A block at the hour it would land on: the schedule pane's plate, rail and time. */
function BlockTwin({ title, time, accent }: { title: string; time: string; accent: string }) {
  return (
    <div className="relative flex h-full w-full items-start gap-2 overflow-hidden rounded-[5px] border border-border bg-[var(--sched-pane)] px-2.5 py-1.5">
      <span aria-hidden className="absolute bottom-0 left-0 top-0 w-[2px]" style={{ background: accent }} />
      <span className="min-w-0 flex-1 truncate font-content text-content text-foreground">{title}</span>
      <span className="flex-shrink-0 font-num text-2xs text-muted-foreground">{time}</span>
    </div>
  );
}

/**
 * Where the target is NOW. dnd-kit's `over.rect` is the rect it measured, which
 * a scroll since (the canvas auto-scrolling under a drag, the schedule growing
 * to the whole day as the drag starts) leaves behind; the ghost has to sit on
 * the hour the user can see. Every droppable carries `data-dnd-id`
 * (lib/dnd/CONTRACT.md).
 */
function liveRect(id: string) {
  const el = document.querySelector(`[data-dnd-id="${CSS.escape(id)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // The braindump's droppable is the whole pane, padding and all; a row there
  // is as wide as the braindump's own rows.
  if (id === 'sidebar') {
    const row = el.querySelector('[data-testid="item-card"]');
    if (row) return { left: r.left, top: r.top, width: row.getBoundingClientRect().width, height: r.height };
  }
  return r;
}

function blockMinutes(item: Item): number {
  return item.duration ?? getItemTypeConfig(itemTypeName(item)).schedule.defaultBlockMinutes;
}

/**
 * Settles on the landing: the overlay glides so the ghost's corner meets the
 * row or block where it landed, and the ghost takes that element's size on the
 * way, since it may have changed shape. dnd-kit's own config form can only
 * animate the overlay's transform, and the overlay's size is not the ghost's
 * (see `DragGhost`), so this is the function form, with the same side effect:
 * the landed element is hidden until the ghost arrives on it.
 */
const SETTLE_MS = 170;
/** Hour to hour on a grid, the snapped ghost steps rather than jumps. */
const SNAP_TRANSITION = 'transform 90ms ease-out';
const SETTLE_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const settleOnLanding: DropAnimation = ({ active, dragOverlay, transform }) => {
  const face = dragOverlay.node.querySelector<HTMLElement>('[data-testid="drag-ghost"]');
  if (!face || prefersReducedMotion() || typeof face.animate !== 'function') return;
  const from = face.getBoundingClientRect();
  const to = active.rect;
  const dx = to.left - from.left;
  const dy = to.top - from.top;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && from.width === to.width && from.height === to.height) return;

  const prevOpacity = active.node.style.opacity;
  active.node.style.opacity = '0';
  const opts = { duration: SETTLE_MS, easing: SETTLE_EASE, fill: 'forwards' as const };
  const move = dragOverlay.node.animate(
    [
      { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` },
      { transform: `translate3d(${transform.x + dx}px, ${transform.y + dy}px, 0)` },
    ],
    opts
  );
  face.animate(
    [
      { width: `${from.width}px`, height: `${from.height}px` },
      { width: `${to.width}px`, height: `${to.height}px` },
    ],
    opts
  );
  return new Promise<void>((resolve) => {
    move.onfinish = () => {
      active.node.style.opacity = prevOpacity;
      resolve();
    };
  });
};

export function DragGhost() {
  const { activeNode, activeNodeRect, activatorEvent, over } = useDndContext();
  const activeId = useDragStore((s) => s.activeId);
  const input = useDragStore((s) => s.input);
  // Count travels only when the dragged row is itself part of a multi-selection.
  const groupCount = useSelectionStore((s) =>
    activeId && s.selectedIds.has(activeId) && s.selectedIds.size >= 2 ? s.selectedIds.size : 0
  );
  const item = usePlannerStore((s) => (activeId ? s.items.find((i) => i.id === activeId) ?? null : null));
  const getProjectColor = usePlannerStore((s) => s.getProjectColor);
  const timeFormat = useTimeFormat();

  // What was grabbed: a schedule block's pane or a row, and its size (the twin's home size).
  const fromBlock = activeNode?.dataset.slot === 'pane';
  const home = activeNodeRect ? { width: activeNodeRect.width, height: activeNodeRect.height } : null;
  const durationMin = item ? blockMinutes(item) : 60;

  const shape: GhostShape =
    home && item
      ? ghostShapeFor({
          overId: over ? String(over.id) : null,
          overRect: over ? liveRect(String(over.id)) ?? over.rect : null,
          home,
          fromBlock,
          durationMin,
        })
      : { kind: 'home' };

  // Places the ghost for the shape this render chose; DragOverlay applies it in
  // the same render, so the ghost and its position never disagree.
  const snap: Modifier = ({ transform, activeNodeRect, overlayNodeRect, activatorEvent: ev }) => {
    // The overlay is placed at the rect it MOUNTED on (dnd-kit's initial rect),
    // not where the grabbed element is now: a canvas that scrolled since has
    // moved the element, and undoing its current rect would put a snapped block
    // that far off its hour.
    const rect = overlayNodeRect ?? activeNodeRect;
    if (!rect) return transform;
    const grabX =
      ev && 'clientX' in ev && typeof (ev as PointerEvent).clientX === 'number'
        ? (ev as PointerEvent).clientX - rect.left
        : rect.width / 2;
    return { ...transform, ...ghostTransform({ shape, transform, homeRect: rect, grabX }) };
  };

  const size = home ? ghostSize(shape, home, fromBlock) : null;
  const touch = input === 'touch' && activatorEvent !== null;

  let body: React.ReactNode = null;
  if (item && activeNode) {
    if (shape.kind === 'block') {
      body = (
        <BlockTwin
          title={item.title}
          time={formatClock(shape.hour * 60, timeFormat)}
          accent={item.project ? getProjectColor(item.project) : 'var(--primary)'}
        />
      );
    } else if (shape.kind === 'row' && fromBlock) {
      body = <RowTwin title={item.title} />;
    } else {
      body = <CloneTwin node={activeNode} />;
    }
  }

  // The overlay itself stays the grabbed element's size for the whole drag, and
  // the ghost is drawn at its shape's size inside it. dnd-kit measures the
  // overlay for collisions, so resizing it would move the point it hit-tests
  // from (a block an hour tall would aim half an hour lower than the pointer).
  // The second, empty child is what keeps dnd-kit measuring the overlay rather
  // than its single child (getMeasurableNode).
  return (
    <DragOverlay
      modifiers={[snap]}
      dropAnimation={settleOnLanding}
      transition={shape.kind === 'block' ? SNAP_TRANSITION : undefined}
    >
      {body && size && (
        <>
          <div
            data-testid="drag-ghost"
            data-ghost-shape={shape.kind}
            aria-hidden
            className={cn('drag-ghost absolute left-0 top-0', touch && 'drag-ghost-touch')}
            style={{ width: size.width, height: size.height }}
          >
            {/* Group drag: the rows behind as offset card edges, and the count. */}
            {groupCount > 1 && <span aria-hidden className="drag-ghost-stack" />}
            <div className="drag-ghost-face relative h-full w-full">{body}</div>
            {groupCount > 1 && (
              <span className="absolute -right-2 -top-2 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-medium text-primary-foreground shadow-soft-sm">
                {groupCount}
              </span>
            )}
          </div>
          <span aria-hidden className="hidden" />
        </>
      )}
    </DragOverlay>
  );
}
