'use client';

import { Braindump } from '@/components/sidebar/braindump';
import { useSidebarStore } from '@/lib/sidebar-store';
import { cn } from '@/lib/utils';

const PANE_W = 'w-[300px]';

/**
 * The layout slot `sidebar: 'pane-right'` (lib/layout-themes.ts): the braindump
 * as a narrow fixed pane on the right of the canvas, without the left column's
 * sash, peek or wordmark. The capture dock is not in here — a layout that
 * moves the braindump also moves capture (`capture: 'prompt-bottom'`).
 *
 * It answers to the same open flag as the left column, so ⌘[ / Ctrl+[ and the
 * palette's toggle still show and hide it; the status line carries its click
 * target. The Braindump inside is the same component with the same droppable,
 * so a drag onto it pauses or unschedules exactly as it does on the left.
 */
export function BraindumpPane({ covered = false }: { covered?: boolean }) {
  const open = useSidebarStore((s) => s.leftSidebarOpen);
  // `covered`: the right column (an item, or Ask) overlays this pane below
  // 1180px, so it leaves the tab order the way <main> does (desktop-shell's
  // `inert`).
  const away = !open || covered;
  return (
    <aside
      data-tour="left-sidebar"
      data-testid="braindump-pane"
      aria-hidden={away || undefined}
      inert={away}
      className={cn(
        'relative flex h-full flex-shrink-0 overflow-hidden transition-[width] duration-300 ease-out',
        open ? cn(PANE_W, 'border-l border-border') : 'w-0'
      )}
    >
      <div className={cn('flex min-h-0 flex-1 flex-col pt-4 pr-3 pb-3 pl-3', PANE_W)}>
        <Braindump />
      </div>
    </aside>
  );
}
