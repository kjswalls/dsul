'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import type { Rect, Viewport } from '@/lib/atlas-camera';
import {
  ATLAS_MINIMAP_H,
  ATLAS_MINIMAP_IDLE_MS,
  ATLAS_MINIMAP_W,
  cameraForMiniPoint,
  minimapFrame,
  minimapNeeded,
  viewportInMini,
  worldToMini,
} from '@/lib/atlas-minimap';
import { toneColor } from '@/lib/atlas-tones';
import type { AtlasColors } from '@/components/views/atlas/use-atlas-colors';
import type { FarCluster } from '@/components/views/atlas/atlas-far-canvas';
import { cn } from '@/lib/utils';

/**
 * The minimap (design PR3, the cards mock): the far zoom in miniature, a
 * tile per item in its Aurora tone, with the viewport as a rounded frame.
 * Bottom left: bottom right is the "?" help bubble.
 *
 * It shows while the camera moves and hides ATLAS_MINIMAP_IDLE_MS after; M
 * (the toggle_atlas_minimap command) pins it; a pointer resting on its corner
 * brings it back (pointer only, under `(hover: hover) and (pointer: fine)`).
 * A click or drag flies the camera there. It exists only when some of the
 * board is off screen, and writes nothing.
 *
 * Shown and hidden by `visibility` and a small transform, never opacity: it
 * can hold a lime container's tiles, and lime is never faded through a
 * parent's opacity (CLAUDE.md, D8).
 */
export function AtlasMinimap({
  content,
  clusters,
  viewport,
  colors,
  reduced,
}: {
  /** The board's content rects (world), what the minimap frames. */
  content: readonly Rect[];
  clusters: readonly FarCluster[];
  viewport: Viewport;
  colors: AtlasColors;
  reduced: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pinned = useAtlasUiStore((s) => s.minimapPinned);
  const camera = useAtlasUiStore((s) => s.camera);
  const needed = minimapNeeded(content, camera, viewport);
  const [awake, setAwake] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragging = useRef<number | null>(null);

  // Wake on every camera move, and sleep a while after the last one.
  useEffect(
    () =>
      useAtlasUiStore.subscribe((s, prev) => {
        if (s.camera === prev.camera) return;
        setAwake(true);
        if (idle.current) clearTimeout(idle.current);
        idle.current = setTimeout(() => {
          idle.current = null;
          if (dragging.current === null) setAwake(false);
        }, ATLAS_MINIMAP_IDLE_MS);
      }),
    []
  );
  useEffect(
    () => () => {
      if (idle.current) clearTimeout(idle.current);
    },
    []
  );

  const shown = needed && (pinned || awake);

  const draw = useCallback(() => {
    const el = canvasRef.current;
    const ctx = el?.getContext('2d');
    const f = minimapFrame(content);
    if (!el || !ctx || !f) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = ATLAS_MINIMAP_W * dpr;
    el.height = ATLAS_MINIMAP_H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, ATLAS_MINIMAP_W, ATLAS_MINIMAP_H);
    const t = 4;
    const gap = 1.5;
    for (const c of clusters) {
      const n = Math.min(c.tiles, 64);
      if (n === 0) continue;
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const { x: cx, y: cy } = worldToMini(f, { x: c.x, y: c.y });
      const tone = colors.tones.get(c.color) ?? 'teal';
      ctx.fillStyle = toneColor(tone, colors.mode, 1);
      for (let i = 0; i < n; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = cx + (col - (cols - 1) / 2) * (t + gap) - t / 2;
        const y = cy + (row - (rows - 1) / 2) * (t + gap) - t / 2;
        // Canvas drawing at an alpha, not a parent's opacity (D8).
        ctx.globalAlpha = c.resting ? 0.35 : i < c.lit ? 1 : 0.28;
        ctx.beginPath();
        ctx.rect(x, y, t, t);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    const cam = useAtlasUiStore.getState().camera;
    const v = viewportInMini(f, cam, viewport);
    ctx.strokeStyle = colors.sub;
    ctx.fillStyle = colors.frameFill;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const r = 4;
    ctx.moveTo(v.x + r, v.y);
    ctx.arcTo(v.x + v.w, v.y, v.x + v.w, v.y + v.h, r);
    ctx.arcTo(v.x + v.w, v.y + v.h, v.x, v.y + v.h, r);
    ctx.arcTo(v.x, v.y + v.h, v.x, v.y, r);
    ctx.arcTo(v.x, v.y, v.x + v.w, v.y, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }, [content, clusters, colors, viewport]);

  // Drawn only while it can be seen (a camera move re-renders this component).
  useEffect(() => {
    if (needed) draw();
  }, [needed, shown, camera, draw]);

  const flyTo = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const f = minimapFrame(content);
    const r = e.currentTarget.getBoundingClientRect();
    if (!f) return;
    const ui = useAtlasUiStore.getState();
    ui.setCamera(cameraForMiniPoint(f, ui.camera, { x: e.clientX - r.left, y: e.clientY - r.top }, viewport));
  };

  if (!needed) return null;
  return (
    <div
      className="atlas-minimap-zone absolute bottom-3 left-3 z-20"
      style={{ width: ATLAS_MINIMAP_W, height: ATLAS_MINIMAP_H }}
      data-testid="atlas-minimap-zone"
    >
      <div
        data-testid="atlas-minimap"
        data-shown={shown ? 'true' : undefined}
        data-pinned={pinned ? 'true' : undefined}
        title={ATLAS_COPY.minimapHint}
        className={cn(
          'atlas-minimap size-full overflow-hidden rounded-[14px] border border-border bg-card shadow-[var(--shadow-elev-sm)]',
          shown ? 'visible translate-y-0 scale-100' : 'invisible translate-y-2 scale-[.98]',
          !reduced && 'transition-[translate,scale,visibility] duration-150'
        )}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={ATLAS_COPY.minimapLabel}
          className="block size-full cursor-pointer touch-none"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            dragging.current = e.pointerId;
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // Synthetic pointers can't always capture; the move still flies.
            }
            flyTo(e);
          }}
          onPointerMove={(e) => {
            if (dragging.current === e.pointerId) flyTo(e);
          }}
          onPointerUp={(e) => {
            if (dragging.current === e.pointerId) dragging.current = null;
          }}
          onPointerCancel={() => {
            dragging.current = null;
          }}
        />
      </div>
    </div>
  );
}
