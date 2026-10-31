'use client';

import { useEffect, useRef, type ReactNode, type RefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { ATLAS_HANDOFF_ZOOM, handoffCardScale, panBy, zoomAt } from '@/lib/atlas-camera';
import { ATLAS_GRID_PITCH } from '@/lib/atlas-relay-grid';

/**
 * The dot grid's pitch in world pixels: the far zoom's grid (26px), so the
 * board's dots and the Relay grid's cells line up through the handoff.
 */
const DOT_PITCH = ATLAS_GRID_PITCH;
/** Ctrl+wheel (a trackpad pinch) zoom speed. */
const WHEEL_ZOOM = 0.01;
/**
 * The most one wheel event may zoom, in pixel-delta terms: a mouse notch
 * (deltaY 100 to 120) zooms about 1.5x, while a pinch's small deltas pass
 * untouched.
 */
const WHEEL_ZOOM_STEP = 40;
/** Pixels per line, for a wheel that reports lines (Firefox's mouse wheel). */
const WHEEL_LINE_PX = 16;

/**
 * The pan and zoom surface: the dot grid, the pointer pans, the wheel, and
 * the one transformed node (`.atlas-world`) that holds the cards.
 *
 * - Plain wheel and two-finger scroll PAN; Ctrl+wheel (a trackpad pinch, or
 *   Ctrl with a mouse wheel; ⌘ too on a Mac) ZOOMS at the pointer, as in Figma.
 *   The wheel is a native non-passive listener: React's onWheel is passive, so
 *   preventDefault there is ignored and a pinch would also zoom the page or the
 *   Electron window.
 * - A drag on bare canvas, a middle-button drag, or Space+drag pans.
 *
 * The camera is read by two small subscribers (the dots and the world), so a
 * pan or zoom re-renders those two nodes and never a card.
 */
/**
 * One wheel event on the board: pan, or zoom at the pointer with Ctrl/⌘.
 * `el` is the box the pointer is measured against. Shared with the minimap's
 * corner, which sits over the board but outside the surface.
 */
export function atlasWheel(e: WheelEvent, el: HTMLElement) {
  e.preventDefault();
  const { camera, setCamera } = useAtlasUiStore.getState();
  // Lines (Firefox's mouse wheel) and pages become pixels first.
  const k = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? el.clientHeight || 1 : 1;
  const deltaX = e.deltaX * k;
  const deltaY = e.deltaY * k;
  if (e.ctrlKey || e.metaKey) {
    const r = el.getBoundingClientRect();
    const d = Math.max(-WHEEL_ZOOM_STEP, Math.min(WHEEL_ZOOM_STEP, deltaY));
    setCamera(zoomAt(camera, { x: e.clientX - r.left, y: e.clientY - r.top }, Math.exp(-d * WHEEL_ZOOM)));
    return;
  }
  // Shift turns a mouse wheel's vertical scroll sideways, as everywhere.
  const dx = e.shiftKey && deltaX === 0 ? deltaY : deltaX;
  const dy = e.shiftKey && deltaX === 0 ? 0 : deltaY;
  setCamera(panBy(camera, -dx, -dy));
}

export function AtlasSurface({
  rootRef,
  inert,
  far,
  children,
}: {
  /** The Atlas root, focused on a bare-canvas press so its keys keep working. */
  rootRef: RefObject<HTMLDivElement | null>;
  /** While the focus sheet is up: the map behind takes no focus and no press. */
  inert?: boolean;
  /** The far zoom (PR3), drawn above the dots and under the cards. */
  far?: ReactNode;
  children: ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ id: number; x: number; y: number } | null>(null);
  const space = useRef(false);

  // Space held: the next drag pans wherever it starts. Ignored while typing.
  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !typing(e.target)) space.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') space.current = false;
    };
    // A keyup that lands in another window or tab never reaches us; a held
    // Space must not outlive the focus, or every press would pan.
    const drop = () => {
      space.current = false;
    };
    const hidden = () => {
      if (document.visibilityState !== 'visible') drop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', drop);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', drop);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => atlasWheel(e, el);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // React bubbles through portals: a press on a card's context menu (portalled
    // to <body>) reaches this handler too. It is not a press on the board, and
    // capturing it here would steal the row's click, so the menu never chose.
    if (!e.currentTarget.contains(e.target as Node)) return;
    const onCard = (e.target as Element).closest?.('[data-atlas-card]');
    const middle = e.button === 1;
    const bare = e.button === 0 && !onCard && !e.ctrlKey;
    if (!middle && !bare && !(e.button === 0 && space.current)) return;
    if (bare) rootRef.current?.focus({ preventScroll: true });
    if (middle) e.preventDefault();
    pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers can't always capture; panning still follows moves.
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (dx === 0 && dy === 0) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const { camera, setCamera } = useAtlasUiStore.getState();
    setCamera(panBy(camera, dx, dy));
  };

  const endPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pan.current?.id === e.pointerId) pan.current = null;
  };

  return (
    <div
      ref={surfaceRef}
      data-testid="atlas-surface"
      inert={inert}
      className="absolute inset-0 touch-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      {/* The canvas draws the grid below the handoff zoom; with no canvas
          (an empty board) the CSS dots stay at every zoom. */}
      <AtlasDots yieldBelowHandoff={far != null} />
      {far}
      <AtlasWorld>{children}</AtlasWorld>
    </div>
  );
}

/**
 * The dot grid, scaled and shifted with the camera. CSS only, no canvas.
 * Below the handoff zoom the far zoom's canvas draws the same grid (its free
 * cells, thinned as it zooms out), so this one steps aside.
 */
function AtlasDots({ yieldBelowHandoff }: { yieldBelowHandoff: boolean }) {
  const { x, y, z } = useAtlasUiStore((s) => s.camera);
  if (yieldBelowHandoff && z < ATLAS_HANDOFF_ZOOM) return null;
  const pitch = DOT_PITCH * z;
  return (
    <div
      aria-hidden
      data-testid="atlas-dots"
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: 'radial-gradient(circle, var(--border) 1.1px, transparent 1.4px)',
        backgroundSize: `${pitch}px ${pitch}px`,
        backgroundPosition: `${x}px ${y}px`,
      }}
    />
  );
}

/**
 * The ONLY node that carries the camera's transform. In the handoff band it
 * also carries `--atlas-handoff`, the scale each card shrinks to toward its
 * cluster (a card in the band reads it), so a zoom there re-renders no card.
 */
function AtlasWorld({ children }: { children: ReactNode }) {
  const { x, y, z } = useAtlasUiStore((s) => s.camera);
  const band = z < ATLAS_HANDOFF_ZOOM;
  return (
    <div
      className="atlas-world absolute left-0 top-0 origin-top-left"
      data-testid="atlas-world"
      data-handoff={band ? 'true' : undefined}
      style={{
        transform: `translate(${x}px, ${y}px) scale(${z})`,
        ...(band ? ({ '--atlas-handoff': handoffCardScale(z) } as Record<string, number>) : null),
      }}
    >
      {children}
    </div>
  );
}
