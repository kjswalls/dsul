'use client';

import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Sparkles } from 'lucide-react';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { chordLabel, isApplePlatform } from '@/lib/commands/keys';
import { toggleRail } from '@/lib/open-chat';
import { usePanelOverlays, useRailMode } from '@/lib/rail-store';
import { useViewStore } from '@/lib/view-store';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

/** How much of the button the header row has room for: all of it, the spark alone, or none. */
type Fit = 'full' | 'icon' | 'none';

/** The spark alone: the capsule's square controls' size (h-8 w-8). */
const ICON_PX = 32;

/**
 * The room the header row leaves this button, read off the row as laid out:
 * its content width less every other child that takes room (the capsule, a
 * notice, WeekScale) and the gaps between. The button's pill gives way to
 * them, never they to it: it shrinks first and to nothing (`min-w-0`, a shrink
 * weight no sibling has), so they keep their natural widths and what is
 * measured does not depend on what this chose. A fixed canvas breakpoint could not do this:
 * the capsule is ~70px wider while it shows Today, and Notebook's masthead
 * date up to ~90px wider on a long date, so any width that is safe for those
 * hides the button on every ordinary day.
 *
 * `fullPx` is the button's natural width, read whenever it is drawn whole
 * (its scrollWidth, squeezed or not), so a layout's own face and a rebinding's
 * longer chord are what is measured, not a guess.
 */
function useHeaderFit(ref: RefObject<HTMLButtonElement | null>, active: boolean): Fit {
  const [fit, setFit] = useState<Fit>('full');
  const fullPx = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    const pill = el?.parentElement;
    const row = pill?.parentElement;
    if (!active || !el || !pill || !row) return;
    const measure = () => {
      const style = getComputedStyle(row);
      const gap = parseFloat(style.columnGap) || 0;
      const content = row.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      let others = 0;
      for (const child of Array.from(row.children)) {
        if (child === pill) continue;
        const w = child.getBoundingClientRect().width;
        // A child with nothing to say renders no box, and takes no gap either.
        if (w > 0) others += w + gap;
      }
      if (pill.dataset.fit === 'full') fullPx.current = el.scrollWidth;
      const room = content - others;
      setFit(room >= fullPx.current ? 'full' : room >= ICON_PX ? 'icon' : 'none');
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    // The row, the button, and each sibling: a date that grows, Today coming
    // and going, WeekScale arriving with the week, a font that loads late.
    const sizes = new ResizeObserver(measure);
    sizes.observe(row);
    for (const child of Array.from(row.children)) sizes.observe(child);
    const siblings = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => n instanceof Element && sizes.observe(n));
        r.removedNodes.forEach((n) => n instanceof Element && sizes.unobserve(n));
      }
      measure();
    });
    siblings.observe(row, { childList: true });
    return () => {
      sizes.disconnect();
      siblings.disconnect();
    };
    // `fit` re-runs it after a change, so a button drawn whole again is re-read.
  }, [ref, active, fit]);
  return fit;
}

/**
 * The Ask button: "✦ Ask  Ctrl+J" on the canvas's header row, while Ask is
 * closed. Ask starts closed (sidebar-store ASK_OPEN_DEFAULT), and this is the
 * way to it that does not need the chord.
 *
 * WHAT IT DOES is exactly what Ctrl+J does from closed (lib/open-chat.ts
 * `toggleRail`): leave Zen, summon Ask with its box focused, and write
 * `askOpen`, so it stays open across reloads until closed again. The summon
 * notes this button as where focus came from (rail-store `rememberFocus`), so
 * closing Ask by ✕ or Ctrl+J from inside it hands focus back here. It stays
 * mounted, `hidden`, while the column shows, so that hand-back has a node to
 * land on the moment Ask goes. A click focuses it first: Safari leaves a
 * clicked button unfocused, and there would be nothing to note.
 *
 * WHEN it shows: something answers (the AI gate's `canChat`, asked, never
 * re-derived; unknown is no), on the desktop, outside Zen, and only while the
 * right column is not shown, i.e. Ask closed and no item open (rail-store
 * `railMode` is 'hidden'). At or below 1180px that includes an Ask kept open
 * but not summoned this session: the column is hidden there, and this summons
 * it as the overlay Ctrl+J would. The phone has the Ask tab instead.
 *
 * WHERE: the last thing on the canvas's header row (desktop-shell.tsx), on
 * the date's line (`railHeaderRowOffset`, the rail header's own rule, so
 * when Ask opens its header row is where this was). In day scope it takes the
 * row's far end (`ml-auto`, passed in); in the week views WeekScale does, and
 * this sits just past it. It gives way to everything else on the row
 * (useHeaderFit): the spark alone when the words do not fit, nothing when
 * that does not either, so it never overlaps the capsule, a notice or
 * WeekScale, never wraps onto a line of its own and never grows the row the
 * grid's height is measured under.
 *
 * `titlebar-hole`: in Writer the row starts at the window's top, inside the
 * desktop app's 43px drag band, which would swallow its clicks.
 *
 * The chord is the live binding through chordLabel (Ctrl+J; ⌘J on a Mac), in
 * the hint's muted mono, and in the title; never typed by hand. The spark is
 * the rail header's (`text-ai`).
 */
export function AskOpener({ className, rowOffset }: { className?: string; rowOffset: string }) {
  const { canChat } = useAICapabilities();
  const isMobile = useIsMobile();
  const zen = useViewStore((s) => s.zenOpen);
  const columnShown = useRailMode(usePanelOverlays()) !== 'hidden';
  const keys = useShortcutKeys('toggle_right_sidebar');
  const isMac = useMemo(() => isApplePlatform(), []);
  const ref = useRef<HTMLButtonElement>(null);
  const hidden = columnShown || zen;
  const fit = useHeaderFit(ref, canChat && !isMobile && !hidden);

  if (!canChat || isMobile) return null;
  const chord = chordLabel(keys, isMac);

  return (
    // The pill is the capsule's (header-capsule.tsx `data-header-pill`), so a
    // layout that takes the capsule's chrome away (header 'plain', 'masthead';
    // app/globals.css) takes this one's too, and it reads as the quiet words
    // the rest of that row is. It is the row's child: what is hidden, and what
    // gives way.
    <span
      data-header-pill=""
      data-ask-opener-pill=""
      data-fit={fit}
      hidden={hidden || fit === 'none'}
      className={cn(
        'flex min-w-0 shrink-[1000] rounded-[10px] bg-surface-2 shadow-[var(--shadow-elev-sm)]',
        rowOffset,
        className
      )}
    >
      <button
        ref={ref}
        type="button"
        data-ask-opener=""
        onClick={(e) => {
          if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
          toggleRail();
        }}
        aria-label="Open Ask"
        title={`Open Ask (${chord})`}
        className={cn(
          'titlebar-hole flex h-8 min-w-0 items-center gap-1.5 overflow-hidden rounded-[10px] text-sm font-medium whitespace-nowrap text-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          fit === 'icon' ? 'w-8 justify-center' : 'px-2.5'
        )}
      >
        <Sparkles className="size-4 shrink-0 text-ai" aria-hidden />
        {fit === 'full' && (
          <>
            <span>Ask</span>
            <span data-ask-opener-chord="" className="font-mono text-2xs font-normal text-muted-foreground" aria-hidden>
              {chord}
            </span>
          </>
        )}
      </button>
    </span>
  );
}
