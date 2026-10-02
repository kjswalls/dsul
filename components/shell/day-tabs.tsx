'use client';

import { useSyncExternalStore } from 'react';
import { addDays, format, startOfWeek } from 'date-fns';
import { usePlannerStore } from '@/lib/planner-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useViewStore } from '@/lib/view-store';
import { useUIStore } from '@/lib/ui-store';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { formatKeys, isApplePlatform } from '@/lib/commands/keys';
import { SCOPE_OPTIONS } from '@/lib/view-options';
import { goToDate } from '@/lib/nav-commands';
import type { SlotVariant } from '@/lib/layout-themes';
import { cn } from '@/lib/utils';

type TabsVariant = Exclude<SlotVariant<'tabs'>, 'none'>;

const noSubscribe = () => () => {};

const WEEK_STARTS = { sunday: 0, monday: 1, saturday: 6 } as const;

/** A day's tab name: plain, or as the file it would be saved as. */
function dayName(date: Date, variant: TabsVariant, selected: boolean): string {
  if (variant === 'md') return `${format(date, 'yyyy-MM-dd')}.md`;
  if (variant === 'txt') return `${format(date, 'EEE, MMM d')}.txt`;
  return format(date, selected ? 'EEE d MMM' : 'EEE d');
}

/** A week's, named by the day it starts on. */
function weekName(start: Date, variant: TabsVariant): string {
  if (variant === 'md') return `week-${format(start, 'yyyy-MM-dd')}.md`;
  if (variant === 'txt') return `Week of ${format(start, 'MMM d')}.txt`;
  return `Week of ${format(start, 'd MMM')}`;
}

const TAB =
  'titlebar-hole flex h-9 min-w-0 items-center gap-2 rounded-t-[8px] px-4 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring';
const TAB_OFF = 'text-muted-foreground hover:bg-accent hover:text-foreground';
const TAB_ON = 'bg-canvas text-foreground';

/**
 * The `tabs` slot (lib/layout-themes.ts): a text editor's tab strip across the
 * top of the window. The braindump is the pinned tab, and it opens and closes
 * the braindump's column; then yesterday, the day you are on, and tomorrow (a
 * week either side in week scope). Day and Week sit at the right with the
 * launcher's shortcut.
 *
 * A second door to things the header already does — the date steps through
 * the same goToDate as its chevrons, so the canvas slides the same way —
 * never the only one. The strip itself is the desktop app's window-drag band
 * (it sits in the top 43px), so every control in it is a titlebar-hole, and it
 * starts past the Mac traffic lights as the status-line does.
 */
export function DayTabs({ variant, className }: { variant: TabsVariant; className?: string }) {
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  const weekStartDay = usePlannerStore((s) => s.weekStartDay);
  const scope = useViewStore((s) => s.scope);
  const setScope = useViewStore((s) => s.setScope);
  const paneOpen = useSidebarStore((s) => s.leftSidebarOpen);
  const togglePane = useSidebarStore((s) => s.toggleLeftSidebar);
  const searchKeys = useShortcutKeys('system_search');
  // Dates and the platform are the client's: nothing date-shaped renders on the
  // server, so the first client render matches it.
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);

  const week = scope === 'week';
  const anchor = week ? startOfWeek(selectedDate, { weekStartsOn: WEEK_STARTS[weekStartDay] ?? 0 }) : selectedDate;
  const span = week ? 7 : 1;
  const tabs = [-1, 0, 1].map((offset) => {
    const date = addDays(anchor, offset * span);
    return {
      offset,
      date,
      label: week ? weekName(date, variant) : dayName(date, variant, offset === 0),
    };
  });
  const ext = variant === 'md' ? '.md' : variant === 'txt' ? '.txt' : '';
  const hint = mounted ? formatKeys(searchKeys, isApplePlatform()).join(' ') : '';

  return (
    <div
      data-testid="day-tabs"
      data-tabs-variant={variant}
      className={cn(
        'flex h-11 flex-shrink-0 items-end gap-0.5 pr-3 font-mono text-[12.5px] font-medium',
        'pl-[max(0.75rem,calc(env(titlebar-area-x,0px)_-_23px))]',
        className
      )}
    >
      <button
        type="button"
        data-testid="day-tabs-braindump"
        aria-pressed={paneOpen}
        onClick={togglePane}
        title={paneOpen ? 'Close the braindump' : 'Open the braindump'}
        className={cn(TAB, paneOpen ? TAB_ON : TAB_OFF)}
      >
        <span aria-hidden className={cn('size-1.5 flex-none rounded-full', paneOpen ? 'bg-success-text' : 'bg-muted-foreground/50')} />
        braindump{ext && <span className="text-muted-foreground">{ext}</span>}
      </button>

      <div role="tablist" aria-label={week ? 'Weeks' : 'Days'} className="ml-3.5 flex min-w-0 items-end gap-0.5">
        {mounted &&
          tabs.map((t) => (
            <button
              key={t.offset}
              type="button"
              role="tab"
              aria-selected={t.offset === 0}
              data-testid={t.offset === 0 ? 'day-tab-current' : t.offset < 0 ? 'day-tab-prev' : 'day-tab-next'}
              onClick={() => t.offset !== 0 && goToDate(t.date, t.offset > 0 ? 'left' : 'right')}
              className={cn(TAB, t.offset === 0 ? TAB_ON : TAB_OFF)}
            >
              <span className="truncate">{t.label}</span>
            </button>
          ))}
      </div>

      <div className="ml-auto flex h-9 flex-none items-center gap-0.5 text-xs text-muted-foreground">
        {SCOPE_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={o.value === scope}
            onClick={() => setScope(o.value)}
            className={cn(
              'titlebar-hole rounded-[6px] px-2.5 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              o.value === scope && 'bg-accent text-foreground'
            )}
          >
            {o.label}
          </button>
        ))}
        {hint && (
          <button
            type="button"
            onClick={() => useUIStore.getState().openDialog({ type: 'launcher' })}
            title="Search and commands"
            className="titlebar-hole ml-2 rounded-[6px] px-2 py-1 text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {hint}
          </button>
        )}
      </div>
    </div>
  );
}
