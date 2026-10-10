'use client';

// PROTOTYPE (mobile web round 2): the real header and the real Today views, with the
// iOS structure's dock (capture bar + Today / Ask / Organize + Search) drawn in the web
// dock's own vocabulary: the surface-3 well, radius-10 keys, key-rest shadows.
// ?density=compact tightens rows and folds the dock to one row.
import { memo } from 'react';
import { Sun, Sparkles, LayoutGrid, Search, Plus, Inbox } from 'lucide-react';
import { MobileHeader } from '@/components/mobile/mobile-header';
import { MobileViewRouter } from '@/components/mobile/mobile-view-router';
import { Braindump } from '@/components/sidebar/braindump';
import { cn } from '@/lib/utils';

const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const compact = q.get('density') === 'compact';
const sheet = q.get('sheet') === '1';

const TABS = [
  { k: 'today', label: 'Today', Icon: Sun },
  { k: 'ask', label: 'Ask', Icon: Sparkles },
  { k: 'organize', label: 'Organize', Icon: LayoutGrid },
];

function Key({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('flex items-center justify-center rounded-[10px] bg-[var(--paper-3)] shadow-[var(--shadow-key-rest)]', className)}>
      {children}
    </span>
  );
}

function Capture({ inline }: { inline?: boolean }) {
  return (
    <Key className={cn('h-12 min-w-0 flex-1 justify-start gap-3 pl-4 pr-1.5', inline && 'h-11 gap-2 pl-3')}>
      <Plus className="size-[18px] shrink-0 text-[var(--lime-ink)] dark:text-[var(--lime-solid)]" />
      <span className="min-w-0 flex-1 truncate text-[15px] text-muted-foreground">{inline ? 'Add' : 'Get it out of your head'}</span>
      <span className="flex h-9 items-center gap-1.5 rounded-[8px] bg-surface-3 px-2.5 text-[13px] font-semibold tabular-nums text-foreground">
        <Inbox className="size-[15px]" />6
      </span>
    </Key>
  );
}

function Dock() {
  if (compact) {
    return (
      <div className="px-[10px] pt-2 pb-3">
        <div className="flex items-center gap-1.5 rounded-[10px] bg-surface-3 p-[8px] shadow-[var(--shadow-elev-bar)]">
          <div className="flex h-11 items-center rounded-[10px] bg-surface-3">
            {TABS.map(({ k, Icon }) => (
              <span key={k} className={cn('flex h-11 w-10 items-center justify-center rounded-[10px] text-muted-foreground', k === 'today' && 'bg-[var(--paper-3)] text-[var(--lime-ink)] shadow-[var(--shadow-key-rest)] dark:text-[var(--lime-solid)]')}>
                <Icon className="size-[19px]" strokeWidth={1.75} />
              </span>
            ))}
          </div>
          <Capture inline />
          <Key className="size-11 shrink-0"><Search className="size-[18px]" /></Key>
        </div>
      </div>
    );
  }
  return (
    <div className="px-[10px] pt-2 pb-3">
      <div className="flex flex-col gap-2 rounded-[10px] bg-surface-3 p-[10px] shadow-[var(--shadow-elev-bar)]">
        <Capture />
        <div className="flex gap-2">
          {TABS.map(({ k, label, Icon }) => (
            <span
              key={k}
              className={cn(
                'flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-[10px] text-[11px] font-medium text-muted-foreground',
                k === 'today' && 'bg-[var(--paper-3)] text-foreground shadow-[var(--shadow-key-rest)]'
              )}
            >
              <Icon className={cn('size-[18px]', k === 'today' && 'text-[var(--lime-ink)] dark:text-[var(--lime-solid)]')} strokeWidth={1.75} />
              {label}
            </span>
          ))}
          <Key className="h-12 w-12 shrink-0"><Search className="size-[18px]" /></Key>
        </div>
      </div>
    </div>
  );
}

export const MobileShell = memo(function MobileShell() {
  return (
    <div
      className="mobile-ground relative flex flex-col bg-background md:hidden"
      data-density={compact ? 'compact' : 'comfortable'}
      style={{ height: '100dvh', ['--canvas' as string]: 'var(--background)' }}
    >
      <MobileHeader settingsHref="/settings/day" onOpenBugReport={() => {}} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <MobileViewRouter />
      </div>
      {sheet ? null : <Dock />}
      {sheet && (
        <>
          <div className="absolute inset-0 z-40 bg-black/30" />
          <div className="absolute inset-x-0 bottom-0 z-50 flex h-[56%] flex-col rounded-t-[14px] bg-background shadow-[0_-8px_30px_rgb(0_0_0/25%)]">
            <div className="mx-auto mt-2 mb-1 h-1.5 w-10 rounded-full bg-muted-foreground/40" />
            <div className="min-h-0 flex-1 overflow-hidden">
              <Braindump variant="mobile" />
            </div>
          </div>
        </>
      )}
    </div>
  );
});
