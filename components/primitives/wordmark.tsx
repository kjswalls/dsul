'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { WORDMARK_CHARS, WORDMARK_FILL_COUNT, takeNextFlavor, type WordmarkFlavor } from '@/lib/wordmark-flavors';
import { wordmarkFontVars } from './wordmark-fonts';
import './wordmark.css';

/** Long enough for every flavor's entrance to finish before letters may overflow their boxes. */
const SETTLE_MS = 900;
/** Past the slowest collapse (serif: 320ms plus 91ms of stagger), then back to classic. */
const REST_MS = 450;
/** How long the return-to-classic sweep runs: the last initial's delay plus its settle. */
const RESTORE_MS = 760;
const GLYPHS = '!<>-_/[]{}=+*^?#01%$';

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
    setFlavor(f);
    setOpen(true);
    setSettled(false);
    settleTimer.current = setTimeout(() => setSettled(true), SETTLE_MS);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (f === 'scramble' && !reduce) scramble();
  };

  const leave = () => {
    if (!open) return;
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
        role="img"
        aria-label="dsul, do stuff unlimited"
        data-flavor={flavor}
        data-open={open || undefined}
        data-settled={settled || undefined}
        data-restoring={restoring || undefined}
        className={cn('wordmark', wordmarkFontVars)}
        style={{ '--wm-fill-count': WORDMARK_FILL_COUNT } as React.CSSProperties}
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
          {WORDMARK_CHARS.map((c) => (
            <span
              key={c.index}
              className={cn('wordmark-char', !c.initial && 'wordmark-fill')}
              data-scrambling={scrambled?.[c.index] ? true : undefined}
              style={
                {
                  '--wm-i': c.index,
                  ...(c.initial ? null : { '--wm-fi': c.fillIndex }),
                } as React.CSSProperties
              }
            >
              {scrambled?.[c.index] ?? c.ch}
            </span>
          ))}
        </span>
        <span className="wordmark-dot" aria-hidden />
      </span>
    </div>
  );
}
