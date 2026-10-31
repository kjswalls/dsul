'use client';

import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { POINTER_ACTIVATION_DISTANCE_PX } from '@/lib/dnd/sensors';
import type { Point } from '@/lib/atlas-camera';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';

/**
 * A card's position drag on Your map: Atlas's own pointer handlers, never
 * dnd-kit (design D6), so there is no drag ghost, collision pass or
 * handleDragEnd to touch.
 *
 * - starts only past POINTER_ACTIVATION_DISTANCE_PX, so a click is a click;
 * - ignores a Mac's Ctrl+click (the context menu's gesture) and every button
 *   but the primary one;
 * - ignores a press that starts on a control or an item row, which have their
 *   own meaning;
 * - moves only this card's own transform while dragging (local state), and
 *   commits once, on pointerup (atlas-store `place`: one write per drag);
 * - swallows the click that ends a drag, so a drop never opens or ticks.
 */

/**
 * The camera's scale, read at the moment it is needed: a card never takes the
 * camera as a prop, so a pan or zoom re-renders only the world node.
 */
const zoomNow = () => useAtlasUiStore.getState().camera.z || 1;

const INTERACTIVE = 'button, a[href], input, textarea, select, [role="checkbox"], [data-item-id], [role="menuitem"]';

export function useAtlasPointer({
  at,
  onCommit,
}: {
  /** The card's world position at rest. */
  at: Point;
  onCommit: (to: Point) => void;
}) {
  const [drag, setDrag] = useState<Point | null>(null);
  const press = useRef<{ x: number; y: number; id: number; active: boolean } | null>(null);
  const swallowClick = useRef(false);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    // A click still owed to an earlier drag (one that never came: a cancel, a
    // capture that sent it elsewhere) must not eat this press's click.
    swallowClick.current = false;
    // A Mac's Ctrl+click is a right-click: the menu's, never a drag.
    if (e.ctrlKey) return;
    const target = e.target as Element | null;
    if (target?.closest?.(INTERACTIVE)) return;
    // No stopPropagation: document-level outside-press listeners (the omnibar
    // panel, Radix layers) must still hear it, and the surface already refuses
    // to pan from a press on a card.
    press.current = { x: e.clientX, y: e.clientY, id: e.pointerId, active: false };
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const p = press.current;
      if (!p || p.id !== e.pointerId) return;
      // A press whose up this card never heard (Space+drag handed it to the
      // surface's pan): a mouse moving with no button down is not a drag.
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        press.current = null;
        return;
      }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (!p.active) {
        if (Math.hypot(dx, dy) < POINTER_ACTIVATION_DISTANCE_PX) return;
        p.active = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // jsdom and some synthetic pointers can't capture; the drag still works.
        }
      }
      const z = zoomNow();
      setDrag({ x: at.x + dx / z, y: at.y + dy / z });
    },
    [at.x, at.y]
  );

  const end = useCallback(
    (e: ReactPointerEvent<HTMLElement>, commit: boolean) => {
      const p = press.current;
      if (!p || p.id !== e.pointerId) return;
      press.current = null;
      if (!p.active) return;
      // Only a pointerup is followed by a click; a pointercancel is not.
      if (commit) swallowClick.current = true;
      const z = zoomNow();
      const to = { x: at.x + (e.clientX - p.x) / z, y: at.y + (e.clientY - p.y) / z };
      setDrag(null);
      if (commit) onCommit(to);
    },
    [at.x, at.y, onCommit]
  );

  const onClickCapture = useCallback((e: ReactMouseEvent) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  return {
    /** Where to draw the card: the drag's position while dragging, else `at`. */
    pos: drag ?? at,
    dragging: drag !== null,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => end(e, true),
      onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => end(e, false),
      onClickCapture,
    },
  };
}
