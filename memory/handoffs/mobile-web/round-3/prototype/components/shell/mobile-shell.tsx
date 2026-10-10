'use client';

// PROTOTYPE (mobile web round 3): the iOS app's chrome (large-title top row with the
// layout capsule, capture bar, floating tab pill + Search circle, sheets) around the
// web's real Today views. ?density=compact uses the iOS minimized dock and tighter rows.
import { memo } from 'react';
import { format, startOfWeek, addDays, isSameDay } from 'date-fns';
import { usePlannerStore } from '@/lib/planner-store';
import { Sun, Sparkles, LayoutGrid, Search, Plus, Inbox, ChevronsUpDown, List, Rows3, Clock } from 'lucide-react';
import { MobileViewRouter } from '@/components/mobile/mobile-view-router';
import { Braindump } from '@/components/sidebar/braindump';
import { useViewStore } from '@/lib/view-store';
import { cn } from '@/lib/utils';

const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const compact = q.get('density') === 'compact';
const sheet = q.get('sheet') === '1';
const strip = q.get('strip') === '1';
const minimized = q.get('min') === '1';

const raised = 'bg-[var(--paper-3)] shadow-[0_1px_2px_rgb(0_0_0/6%),0_4px_14px_rgb(0_0_0/7%)] dark:shadow-[0_1px_2px_rgb(0_0_0/40%),0_6px_18px_rgb(0_0_0/35%)]';
const LAYOUT_ICON = { list: List, buckets: Rows3, schedule: Clock } as const;
const LAYOUT_NAME = { list: 'List', buckets: 'Buckets', schedule: 'Schedule' } as const;

function TopRow() {
  const layout = useViewStore((s) => s.layout) as keyof typeof LAYOUT_ICON;
  const Icon = LAYOUT_ICON[layout] ?? Rows3;
  const today = new Date();
  return (
    <div className="flex-none">
      <div className="flex items-center justify-between pt-[max(10px,env(safe-area-inset-top))] pb-2 pl-5 pr-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-[17px] font-semibold leading-6 text-foreground">Today</span>
          <span className="text-[12px] text-muted-foreground">{format(today, 'EEE, MMM d')} · {LAYOUT_NAME[layout]}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex h-[34px] items-center gap-1.5 rounded-full bg-surface-3 px-3 text-foreground">
            <Icon className="size-[17px]" strokeWidth={1.75} />
            <ChevronsUpDown className="size-[13px] text-muted-foreground" strokeWidth={2} />
          </span>
          <span className="flex size-[30px] items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-muted-foreground">KI</span>
        </div>
      </div>
      {strip && (
        <div className="flex justify-between px-4 pb-1">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => {
            const d0 = addDays(startOfWeek(today, { weekStartsOn: 0 }), i);
            const n = d0.getDate();
            const on = isSameDay(d0, today);
            return (
              <div key={i} className="flex w-11 flex-col items-center gap-1 text-[12px] text-muted-foreground">
                <span className={cn(on && 'font-semibold text-foreground')}>{d}</span>
                <span className={cn('flex size-[34px] items-center justify-center rounded-full text-[16px]', on ? 'bg-[var(--lime-solid)] font-semibold text-[var(--lime-ink)]' : 'text-foreground/80')}>{n}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TABS = [
  { k: 'today', label: 'Today', Icon: Sun },
  { k: 'ask', label: 'Ask', Icon: Sparkles },
  { k: 'organize', label: 'Organize', Icon: LayoutGrid },
];
const lime = 'text-[var(--lime-ink)] dark:text-[var(--lime-solid)]';
const Plus2 = () => (<span className="flex size-6 flex-none items-center justify-center rounded-full bg-[var(--lime-solid)] text-[var(--lime-ink)]"><Plus className="size-[15px]" strokeWidth={2.5} /></span>);

function Count() {
  const n = usePlannerStore((st) => (st.items as { isScheduled?: boolean }[]).filter((i) => !i.isScheduled).length);
  return (
    <span className="flex h-[38px] items-center gap-1.5 rounded-full bg-surface-3 px-3 text-[15px] font-semibold tabular-nums text-foreground">
      <Inbox className="size-[15px]" strokeWidth={1.75} />{n}
    </span>
  );
}

function Dock() {
  const fade = 'bg-gradient-to-b from-transparent to-background to-[40px]';
  if (minimized) {
    return (
      <div className={cn('absolute inset-x-0 bottom-0 z-10 flex items-center gap-2.5 px-3 pt-6 pb-[max(20px,env(safe-area-inset-bottom))]', fade)}>
        <span className="flex size-[54px] flex-none items-center justify-center rounded-full bg-[var(--lime-solid)] text-[var(--lime-ink)] shadow-[0_1px_2px_rgb(0_0_0/6%),0_4px_14px_rgb(0_0_0/7%)]"><Sun className="size-5" strokeWidth={1.75} /></span>
        <span className={cn('flex h-[54px] min-w-0 flex-1 items-center gap-2.5 rounded-full pl-4 pr-2', raised)}>
          <Plus2 />
          <span className="flex-1 truncate text-[16px] text-muted-foreground">Capture</span>
          <Count />
        </span>
        <span className={cn('flex size-[54px] flex-none items-center justify-center rounded-full text-foreground', raised)}><Search className="size-[19px]" strokeWidth={1.75} /></span>
      </div>
    );
  }
  return (
    <div className={cn('absolute inset-x-0 bottom-0 z-10 flex flex-col gap-2 px-3 pt-8 pb-[max(20px,env(safe-area-inset-bottom))]', fade)}>
      <span className={cn('flex h-[50px] items-center gap-2.5 rounded-full pl-4 pr-1.5', raised)}>
        <Plus2 />
        <span className="flex-1 truncate text-[16px] text-muted-foreground">Get it out of your head</span>
        <Count />
      </span>
      <div className="flex items-center gap-2.5">
        <div className={cn('flex h-[62px] flex-1 rounded-full p-[5px]', raised)}>
          {TABS.map(({ k, label, Icon }) => (
            <span key={k} className={cn('flex flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[11.5px] font-medium text-muted-foreground', k === 'today' && 'bg-[var(--lime-solid)] font-semibold text-[var(--lime-ink)]')}>
              <Icon className="size-[19px]" strokeWidth={1.75} />
              {label}
            </span>
          ))}
        </div>
        <span className={cn('flex size-[62px] flex-none items-center justify-center rounded-full text-foreground', raised)}><Search className="size-[19px]" strokeWidth={1.75} /></span>
      </div>
    </div>
  );
}

export const MobileShell = memo(function MobileShell() {
  return (
    <div
      className="mobile-ground relative flex flex-col overflow-hidden bg-background md:hidden"
      data-density={compact ? 'compact' : 'comfortable'}
      style={{ height: '100dvh', ['--canvas' as string]: 'var(--background)' }}
    >
      <TopRow />
      <div className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', minimized ? 'pb-[84px]' : 'pb-[136px]')}>
        <MobileViewRouter />
      </div>
      <Dock />
      {sheet && (
        <>
                    <div className="absolute inset-x-0 bottom-0 z-50 flex h-[52%] flex-col rounded-t-[22px] bg-[var(--paper-3)] shadow-[0_-6px_30px_rgb(0_0_0/30%)]">
            <div className="mx-auto mt-2 mb-1 h-[5px] w-10 flex-none rounded-full bg-muted-foreground/40" />
            <div className="min-h-0 flex-1 overflow-hidden">
              <Braindump variant="mobile" />
            </div>
          </div>
        </>
      )}
    </div>
  );
});
