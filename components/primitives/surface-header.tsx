'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The double-card header: a flat `surface-3` capsule framing a shadowed 37px
 * `surface-2` row-pill. Dims from Figma — gray 406×50 r10 at rest, and `below`
 * grows it; pill 385×37 r10, inset (10,6), shadow `--shadow-elev-sm`; title
 * Inter Medium 13.
 *
 * Extracted because the mobile redesign gave it a second home rather than a
 * second copy. On desktop it heads the sidebar's Braindump; on a phone the two
 * DATELESS tabs (Braindump, Beacon) wear it INSTEAD of the dated header card —
 * a calendar above a surface with no date was the thing the one-card header set
 * out to remove, so it must not come back as a second header stacked on this.
 */
export function SurfaceHeader({
  icon,
  title,
  className,
  children,
  below,
}: {
  /** Leading glyph. Beacon runs without one — the artboard gives it the title alone. */
  icon?: ReactNode;
  /**
   * The heading's content. A string for Beacon; the Braindump passes a live
   * count with its name kept as screen-reader-only text, so the heading still
   * names the surface to assistive tech after the visible word went.
   */
  title: ReactNode;
  /** Outer capsule only — the phone shell insets it off the screen edge. */
  className?: string;
  /** Trailing controls, laid out in the row-pill after the title. */
  children?: ReactNode;
  /**
   * Content under the row-pill, inside the capsule — the braindump's Display
   * shelf. Rendered bare, with no wrapper and no spacing of its own: a caller
   * that passes nothing (Beacon) renders exactly as it did, the pill stays the
   * capsule's first child, and whatever goes here owns its padding and its own
   * absence, since an element that renders null is still a truthy prop.
   */
  below?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'shrink-0 rounded-[10px] bg-surface-3 px-[10px] py-[6px] shadow-[var(--shadow-elev-bar)]',
        className
      )}
    >
      <div className="flex h-[37px] items-center gap-2 rounded-[10px] bg-surface-2 px-[15px] shadow-[var(--shadow-elev-sm)]">
        {icon}
        {/* No leading-none beside the truncate: `truncate` is overflow:hidden,
            and a line box exactly 12px tall (--text-sm) is shorter than Inter's
            1.21em glyph box, so the tail of "Braindump"'s p was being clipped.
            The theme's own 17px line height clears the descender and still sits
            well inside the 37px pill. */}
        <h2 className="min-w-0 flex-1 truncate font-sans text-sm font-medium text-foreground">
          {title}
        </h2>
        {children}
      </div>
      {below}
    </div>
  );
}
