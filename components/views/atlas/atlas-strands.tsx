'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ATLAS_CARD_H, ATLAS_CARD_W } from '@/lib/atlas-seed';
import type { Point, Rect } from '@/lib/atlas-camera';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import {
  frameBox,
  isHotStrand,
  parseTranslate,
  strandPath,
  strandsToDraw,
  type AtlasFrameSpec,
  type AtlasStrandLink,
} from '@/lib/atlas-strands';

/**
 * How long after a change the strands keep following the cards: the glide
 * (ATLAS_GLIDE_MS, 550) and a little slack. Imported as a number rather than
 * from atlas-card, which would make this module depend on the card's.
 */
const FOLLOW_MS = 650;

/** At rest: ink, by colour (a solid mix with the ground), never by opacity. */
const REST_STROKE = 'color-mix(in oklch, var(--muted-foreground) 70%, var(--background))';

const linkId = (l: AtlasStrandLink) => `${l.from}\n${l.to}`;

/**
 * The strands and season frames on Atlas's card layer, in world coordinates,
 * under the cards (lib/atlas-strands.ts says what each layout draws).
 *
 * Nothing here re-renders a card, and a moving card re-renders nothing here:
 * the paths' `d` and the frames' boxes are written straight to the DOM from
 * each card's live transform, in one rAF loop that runs only while something
 * can be moving (a glide after a layout change, a drag while a press is held,
 * a spring back after Escape) and stops after it. React renders this layer
 * only when the links, the frames or the hot card change.
 *
 * Hot: the card under the pointer and the card holding focus. A strand with
 * either end hot turns lime (var(--primary)) at full strength, solid, on top
 * of the others. Over ATLAS_STRAND_REST_CAP strands only the hot card's are
 * drawn at all.
 */
export const AtlasStrands = memo(function AtlasStrands({
  links,
  frames,
  positions,
  expanded,
  reduced,
}: {
  links: readonly AtlasStrandLink[];
  frames: readonly AtlasFrameSpec[];
  /** Where each card rests; the fallback when its element can't be read. */
  positions: ReadonlyMap<string, Point>;
  /** Moves when a card opens or closes, so its strands follow its new height. */
  expanded: Readonly<Record<string, boolean>>;
  reduced: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const paths = useRef(new Map<string, SVGPathElement>());
  const boxes = useRef(new Map<string, HTMLDivElement>());
  const cards = useRef(new Map<string, HTMLElement>());
  const positionsRef = useRef(positions);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const hot = useMemo(() => new Set([hover, focus].filter((k): k is string => !!k)), [hover, focus]);

  const drawn = useMemo(() => strandsToDraw(links, hot), [links, hot]);
  // Hot strands last, so they cross over the rest. One keyed list, so a
  // strand turning hot is moved, not remounted, and keeps its curve.
  const ordered = useMemo(
    () => [...drawn.filter((l) => !isHotStrand(l, hot)), ...drawn.filter((l) => isHotStrand(l, hot))],
    [drawn, hot]
  );
  const drawnRef = useRef(ordered);
  const framesRef = useRef(frames);
  useLayoutEffect(() => {
    positionsRef.current = positions;
    drawnRef.current = ordered;
    framesRef.current = frames;
  });

  /** A card's element, cached, re-found once it has left the DOM. */
  const cardEl = useCallback((key: string): HTMLElement | null => {
    const hit = cards.current.get(key);
    if (hit?.isConnected) return hit;
    const world = wrapRef.current?.parentElement;
    const el = world?.querySelector<HTMLElement>(`[data-atlas-card="${key}"]`) ?? null;
    if (el) cards.current.set(key, el);
    else cards.current.delete(key);
    return el;
  }, []);

  /** Write every drawn strand's curve and every frame's box from where the cards are now. */
  const draw = useCallback(() => {
    const seen = new Map<string, Rect | null>();
    const rectOf = (key: string): Rect | null => {
      if (seen.has(key)) return seen.get(key)!;
      const el = cardEl(key);
      let r: Rect | null = null;
      const at = el ? (parseTranslate(getComputedStyle(el).transform) ?? parseTranslate(el.style.transform)) : null;
      const p = at ?? positionsRef.current.get(key) ?? null;
      if (p) r = { x: p.x, y: p.y, w: el?.offsetWidth || ATLAS_CARD_W, h: el?.offsetHeight || ATLAS_CARD_H };
      // A card leaving (a filter took it) or gone: no strand to it.
      if (el?.dataset.leaving === 'true') r = null;
      seen.set(key, r);
      return r;
    };
    for (const l of drawnRef.current) {
      const path = paths.current.get(linkId(l));
      if (!path) continue;
      const a = rectOf(l.from);
      const b = rectOf(l.to);
      path.setAttribute('d', a && b ? strandPath(a, b) : '');
    }
    for (const f of framesRef.current) {
      const box = boxes.current.get(f.key);
      if (!box) continue;
      const r = frameBox(f.members.map(rectOf).filter((x): x is Rect => !!x));
      if (!r) {
        box.style.visibility = 'hidden';
        continue;
      }
      box.style.visibility = '';
      box.style.transform = `translate(${r.x}px, ${r.y}px)`;
      box.style.width = `${r.w}px`;
      box.style.height = `${r.h}px`;
    }
  }, [cardEl]);

  // The follow loop: one rAF at a time, until `until` has passed and no press is held.
  const raf = useRef(0);
  const until = useRef(0);
  const held = useRef(false);
  const tick = useCallback(() => {
    draw();
    if (held.current || performance.now() < until.current) raf.current = requestAnimationFrame(tick);
    else raf.current = 0;
  }, [draw]);
  const follow = useCallback(
    (ms: number) => {
      until.current = Math.max(until.current, performance.now() + ms);
      if (!raf.current) raf.current = requestAnimationFrame(tick);
    },
    [tick]
  );
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // A change to where the cards rest, or to what is linked: draw now, before
  // paint, then follow the glide (under reduced motion there is none).
  useLayoutEffect(() => {
    draw();
    if (!reduced) follow(FOLLOW_MS);
  }, [draw, follow, reduced, links, frames, positions, expanded]);
  // A hot card changing only adds or restyles strands: one draw, no loop.
  useLayoutEffect(() => {
    draw();
  }, [draw, ordered]);

  // Hot ends and held presses, heard on the world (capture, so a card's own
  // handlers can't hide them). Space+drag pans the camera, which moves no card
  // in world space, so only a press on a card starts the loop.
  useEffect(() => {
    const world = wrapRef.current?.parentElement;
    if (!world) return;
    const keyOf = (t: EventTarget | null) =>
      (t instanceof Element ? t.closest<HTMLElement>('[data-atlas-card]')?.dataset.atlasCard : undefined) ?? null;
    const over = (e: Event) => setHover(keyOf(e.target));
    const leave = () => setHover(null);
    const focusIn = (e: Event) => setFocus(keyOf(e.target));
    const focusOut = (e: FocusEvent) => {
      if (!keyOf(e.relatedTarget)) setFocus(null);
    };
    const down = (e: PointerEvent) => {
      if (!keyOf(e.target)) return;
      held.current = true;
      follow(0);
    };
    const up = () => {
      if (!held.current) return;
      held.current = false;
      follow(FOLLOW_MS);
    };
    // Escape mid-drag springs the card back by its glide.
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && raf.current) follow(FOLLOW_MS);
    };
    world.addEventListener('pointerover', over, true);
    world.addEventListener('pointerleave', leave);
    world.addEventListener('focusin', focusIn, true);
    world.addEventListener('focusout', focusOut, true);
    world.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('keydown', key, true);
    return () => {
      world.removeEventListener('pointerover', over, true);
      world.removeEventListener('pointerleave', leave);
      world.removeEventListener('focusin', focusIn, true);
      world.removeEventListener('focusout', focusOut, true);
      world.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [follow]);

  // A card that grows or shrinks on its own (a tick held, a row added) moves
  // its strands' ends: one draw per change, from a ResizeObserver.
  const endKeys = useMemo(() => {
    const s = new Set<string>();
    for (const l of drawn) s.add(l.from).add(l.to);
    for (const f of frames) for (const m of f.members) s.add(m);
    return [...s].sort().join('\n');
  }, [drawn, frames]);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !endKeys) return;
    const ro = new ResizeObserver(() => draw());
    for (const k of endKeys.split('\n')) {
      const el = cardEl(k);
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
  }, [endKeys, cardEl, draw]);

  const setPath = (id: string) => (el: SVGPathElement | null) => {
    if (el) paths.current.set(id, el);
    else paths.current.delete(id);
  };
  const setBox = (key: string) => (el: HTMLDivElement | null) => {
    if (el) boxes.current.set(key, el);
    else boxes.current.delete(key);
  };
  const strokeTransition = reduced ? undefined : 'stroke 150ms ease-out, stroke-width 150ms ease-out';

  return (
    <div ref={wrapRef} aria-hidden data-testid="atlas-strands" className="pointer-events-none absolute left-0 top-0">
      {frames.map((f) => (
        <div
          key={f.key}
          ref={setBox(f.key)}
          data-atlas-frame={f.key}
          className="absolute left-0 top-0 rounded-[28px] border-[1.5px] border-dashed"
          style={{ borderColor: f.color }}
        >
          <div className="absolute -top-[13px] left-[22px] flex items-center gap-2 whitespace-nowrap rounded-full bg-background px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
            <i className="size-[9px] rotate-45 rounded-[2px]" style={{ background: f.color }} />
            <b className="text-foreground">{f.kind}</b>
            <span>{ATLAS_COPY.frameTab(f.name, f.dates)}</span>
          </div>
        </div>
      ))}
      <svg className="absolute left-0 top-0 overflow-visible" width={1} height={1}>
        {ordered.map((l) => {
          const on = isHotStrand(l, hot);
          return (
            <path
              key={linkId(l)}
              ref={setPath(linkId(l))}
              data-atlas-strand={linkId(l)}
              data-hot={on ? 'true' : undefined}
              fill="none"
              stroke={on ? 'var(--primary)' : REST_STROKE}
              strokeWidth={on ? 2 : 1.25}
              strokeDasharray={on ? undefined : '3 5'}
              strokeLinecap="round"
              style={{ transition: strokeTransition }}
            />
          );
        })}
      </svg>
    </div>
  );
});
