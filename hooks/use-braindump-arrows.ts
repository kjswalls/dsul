'use client';

import { ArrowLeftToLine, ArrowRightToLine, type LucideIcon } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { layoutDef, type LayoutTheme } from '@/lib/layout-themes';
import { useLookStore } from '@/lib/look-store';

/**
 * The two arrows that move a row between the braindump and the day, drawn as
 * one mirrored pair: each points at the side it lands on, into a bar. Move to
 * Braindump points at the braindump, Move to today points away from it.
 */
export interface BraindumpArrows {
  /** Move to Braindump / Send to sidebar. */
  toBraindump: LucideIcon;
  /** Move to today, from a braindump row. */
  toDay: LucideIcon;
}

const LEFT: BraindumpArrows = { toBraindump: ArrowLeftToLine, toDay: ArrowRightToLine };
const RIGHT: BraindumpArrows = { toBraindump: ArrowRightToLine, toDay: ArrowLeftToLine };

/**
 * Which way the pair points under a layout. Console puts the braindump in a
 * pane on the right (`sidebar: 'pane-right'`), so the pair flips there; every
 * other layout keeps it on the left.
 */
export function braindumpArrowsFor(layout: LayoutTheme, mobile = false): BraindumpArrows {
  // The phone ignores layouts: its braindump is a tab, and the arrows keep the
  // default way round.
  if (mobile) return LEFT;
  return layoutDef(layout).slots.sidebar === 'pane-right' ? RIGHT : LEFT;
}

export function useBraindumpArrows(): BraindumpArrows {
  const mobile = useIsMobile();
  const layout = useLookStore((s) => s.layout);
  return braindumpArrowsFor(layout, mobile);
}
