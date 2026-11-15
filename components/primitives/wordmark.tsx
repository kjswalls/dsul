'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  WORDMARK_CHARS,
  WORDMARK_FILL_COUNT,
  WORDMARK_TEXT,
  takeNextFlavor,
  unrollTimings,
  type FillTiming,
  type WordmarkFlavor,
} from '@/lib/wordmark-flavors';
import { wordmarkFontVars } from './wordmark-fonts';
import './wordmark.css';

/** Long enough for every flavor's entrance to finish before letters may overflow their boxes. */
const SETTLE_MS = 900;
/** Past the slowest collapse (serif: 320ms plus 91ms of stagger), then back to classic. */
const REST_MS = 450;
/** How long the return-to-classic sweep runs: the last initial's delay plus its settle. */
const RESTORE_MS = 760;
const GLYPHS = '!<>-_/[]{}=+*^?#01%$';

interface Unroll {
  /** Each growing letter's natural width in px, by fillIndex (0 when unknown). */
  widths: number[];
  timings: FillTiming[];
}

/**
 * Reads the growing letters' natural widths in `flavor`, off a hidden copy of
 * the mark ([data-measuring] in wordmark.css), so the live letters' running
 * transitions are never touched. Also hands back the face in use, so the
 * caller can measure again once a not-yet-loaded flavor face arrives.
 */
function measureUnroll(mark: HTMLElement, flavor: WordmarkFlavor): Unroll & { font: string } {
  const probe = mark.cloneNode(true) as HTMLElement;
  probe.removeAttribute('role');
  probe.removeAttribute('aria-label');
  probe.setAttribute('aria-hidden', 'true');
  delete probe.dataset.open;
  delete probe.dataset.settled;
  delete probe.dataset.restoring;
  probe.dataset.flavor = flavor;
  probe.dataset.measuring = '';
  mark.after(probe);
  try {
    const widths = Array.from(probe.querySelectorAll<HTMLElement>('.wordmark-fill'), (el) =>
      // Rounded up to a hundredth so a letter is never clipped by a rounding.
      Math.ceil(el.getBoundingClientRect().width * 100) / 100,
    );
    const cs = getComputedStyle(probe);
    const font = cs.fontFamily ? `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}` : '';
    return { widths, timings: unrollTimings(widths), font };
  } finally {
    probe.remove();
  }
}

const EVEN_UNROLL: Unroll = {
  widths: Array(WORDMARK_FILL_COUNT).fill(0),
  timings: unrollTimings(Array(WORDMARK_FILL_COUNT).fill(0)),
};

/**
 * The app's name, drawn. One component so the login card and the sidebar can't
 * drift into two logos.
 *
 * Lowercase "dsul" and one lime dot after it, as the Braindump header options
 * drew it. The dot is the Display trigger's own mark, 6px of --primary (lime in
 * both themes), raised a pixel off the baseline so it reads as part of the word
 * rather than a status light. It is the accent, so nothing that mounts this
 * may dim it through a parent's opacity.
 *
 * Hovering it (tapping, on touch) spells out "do stuff unlimited": the four
 * letters stay put and the rest of each word grows out of them behind a
 * left-to-right shimmer, in the next flavor of lib/wordmark-flavors.ts. At rest
 * it is always classic. The styles, and why each flavor moves the way it does,
 * are in wordmark.css.
 */
export function Wordmark({ className, ...props }: React.ComponentProps<'div'>) {
  const [flavor, setFlavor] = useState<WordmarkFlavor>('classic');
  const [open, setOpen] = useState(false);
  const [settled, setSettled] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [scrambled, setScrambled] = useState<Record<number, string> | null>(null);
  const [unroll, setUnroll] = useState<Unroll>(EVEN_UNROLL);
  const markRef = useRef<HTMLSpanElement>(null);
  /** Bumped on every open, so a late font load only re-measures the open it belongs to. */
  const openSeq = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const restTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const restoreTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const raf = useRef(0);
  const lastPointer = useRef('mouse');

  useEffect(
    () => () => {
      clearTimeout(settleTimer.current);
      clearTimeout(restTimer.current);
      clearTimeout(restoreTimer.current);
      cancelAnimationFrame(raf.current);
    },
    [],
  );

  const stopScramble = () => {
    cancelAnimationFrame(raf.current);
    setScrambled(null);
  };

  // Decode: each growing letter shows random glyphs until its turn, left to right.
  const scramble = () => {
    const start = performance.now();
    const fills = WORDMARK_CHARS.filter((c) => !c.initial && c.ch !== ' ');
    const tick = (now: number) => {
      const t = now - start;
      const next: Record<number, string> = {};
      for (const c of fills) {
        if (t < 140 + c.fillIndex * 38) next[c.index] = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      if (Object.keys(next).length === 0) {
        setScrambled(null);
        return;
      }
      setScrambled(next);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  const enter = () => {
    if (open) return;
    clearTimeout(restTimer.current);
    clearTimeout(restoreTimer.current);
    setRestoring(false);
    const f = takeNextFlavor();
    const seq = ++openSeq.current;
    const mark = markRef.current;
    if (mark) {
      const { font, ...measured } = measureUnroll(mark, f);
      setUnroll(measured);
      // A flavor's face loads on its first use, so the first measure may be
      // the fallback's. Measure again once the face is in; the letters then
      // ease to their true widths instead of sitting at the fallback's.
      const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
      if (font && fonts && !fonts.check(font, WORDMARK_TEXT)) {
        // Waits on `ready`, not the load alone: a face that fails (a local()
        // fallback the machine lacks) rejects the load while the real face
        // is still on its way.
        fonts
          .load(font, WORDMARK_TEXT)
          .catch(() => {})
          .then(() => fonts.ready)
          .then(() => {
            if (openSeq.current !== seq || !markRef.current) return;
            const { widths, timings } = measureUnroll(markRef.current, f);
            setUnroll({ widths, timings });
          })
          .catch(() => {});
      }
    }
    setFlavor(f);
    setOpen(true);
    setSettled(false);
    settleTimer.current = setTimeout(() => setSettled(true), SETTLE_MS);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (f === 'scramble' && !reduce) scramble();
  };

  const leave = () => {
    if (!open) return;
    openSeq.current++;
    clearTimeout(settleTimer.current);
    stopScramble();
    setOpen(false);
    setSettled(false);
    // The swap back to classic changes the face and size under the four
    // initials in one frame, so it is dressed as a sweep: the initials settle
    // in left to right from a soft blur behind a shine (wordmark.css,
    // [data-restoring]). Classic has nothing to hide and just rests.
    const wasClassic = flavor === 'classic';
    restTimer.current = setTimeout(() => {
      setFlavor('classic');
      if (wasClassic) return;
      setRestoring(true);
      restoreTimer.current = setTimeout(() => setRestoring(false), RESTORE_MS);
    }, REST_MS);
  };

  return (
    <div className={cn('flex items-center', className)} {...props}>
      <span
        ref={markRef}
        role="img"
        aria-label="dsul, do stuff unlimited"
        data-flavor={flavor}
        data-open={open || undefined}
        data-settled={settled || undefined}
        data-restoring={restoring || undefined}
        className={cn('wordmark', wordmarkFontVars)}
        // Touch and pen get the tap toggle below instead: a pen's contact fires
        // pointerenter too, which would open the mark only for the click to shut it.
        onPointerEnter={(e) => e.pointerType === 'mouse' && enter()}
        onPointerLeave={(e) => e.pointerType === 'mouse' && leave()}
        onPointerDown={(e) => (lastPointer.current = e.pointerType)}
        onClick={() => {
          if (lastPointer.current !== 'touch' && lastPointer.current !== 'pen') return;
          if (open) leave();
          else enter();
        }}
      >
        <span className="wordmark-word" aria-hidden>
          {WORDMARK_CHARS.map((c) => {
            const w = c.initial ? 0 : unroll.widths[c.fillIndex];
            const t = c.initial ? undefined : unroll.timings[c.fillIndex];
            return (
              <span
                key={c.index}
                className={cn('wordmark-char', !c.initial && 'wordmark-fill')}
                data-scrambling={scrambled?.[c.index] ? true : undefined}
                style={
                  {
                    '--wm-i': c.index,
                    ...(t && {
                      '--wm-fi': c.fillIndex,
                      ...(w > 0 && { '--wm-w': `${w}px` }),
                      '--wm-in-delay': t.in.delay.toFixed(4),
                      '--wm-in-dur': t.in.duration.toFixed(4),
                      '--wm-in-ease': t.in.ease,
                      '--wm-out-delay': t.out.delay.toFixed(4),
                      '--wm-out-dur': t.out.duration.toFixed(4),
                      '--wm-out-ease': t.out.ease,
                    }),
                  } as React.CSSProperties
                }
              >
                {scrambled?.[c.index] ?? c.ch}
              </span>
            );
          })}
        </span>
        <span className="wordmark-dot" aria-hidden />
      </span>
    </div>
  );
}
