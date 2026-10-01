import type { ViewScope } from '@/lib/view-store';
import { cn } from '@/lib/utils';

/**
 * The post-mount loading state for the canvas (every scope × layout, through
 * ViewRouter / MobileViewRouter) and the braindump list. AppShell's pre-mount
 * silhouette is the server-rendered half; this is the half that knows the
 * persisted scope and layout, so its outline is the view about to replace it.
 *
 * It REPLACES the view rather than overlaying it, and that is what keeps the
 * lime rule simple: nothing here dims anything, and nothing here is lime.
 * Bars are `bg-surface-3`, hairlines `border-border` — no accent, success or
 * priority token anywhere (a unit test reads every class to hold that).
 *
 * Shapes are fixed width arrays, deliberately unmeasured: no useFitHourPx, no
 * useWeekColumns, no ScrollArea. A skeleton that measured would be a second
 * copy of the view's geometry to keep in step, and the swap to the measured
 * grid is one frame either way.
 *
 * Never `data-week-cols` / `data-week-col`: the week hover recede
 * (globals.css) keys on those, and a skeleton that receded would be the
 * at-rest dim the accent rule forbids by another route.
 *
 * Motion is CSS-only (`.planner-skeleton` in globals.css): a 250ms-delayed
 * fade-in so a warm load never flashes bars, then a slow neutral breathe on
 * the bars alone. Both motion vetoes are spelled out there.
 */

export type SkeletonVariant = 'list' | 'buckets' | 'schedule' | 'braindump';

const DEFAULT_LABEL: Record<'day' | 'week' | 'braindump', string> = {
  day: 'Loading your day…',
  week: 'Loading your week…',
  braindump: 'Loading braindump…',
};

/** Each view's own rhythm (what follows `canvas-container py-6 pb-20` on its
 *  root) — the skeleton sits where the view will, so the swap does not shift
 *  the band. It goes on the bars wrapper, the root's only in-flow child (the
 *  sr-only label is out of flow), rather than on the root itself: the wrapper
 *  is what breathes, and a `display: contents` wrapper would not composite an
 *  opacity at all. */
function viewRhythm(variant: SkeletonVariant, scope: ViewScope): string {
  if (variant === 'braindump') return '';
  if (scope === 'week') {
    if (variant === 'list') return 'space-y-6';
    return 'flex gap-7';
  }
  if (variant === 'list') return 'space-y-5';
  if (variant === 'buckets') return 'flex flex-col gap-4';
  return 'space-y-4';
}

function Bar({ className, width }: { className?: string; width: string }) {
  return <div className={cn('rounded-md bg-surface-3', className)} style={{ width }} />;
}

/** A row-shaped bar pair — a tick slot and a title — the size of a task row. */
function Row({ width }: { width: string }) {
  return (
    <div className="flex h-9 items-center gap-3">
      <div className="size-4 flex-shrink-0 rounded-full bg-surface-3" />
      <Bar className="h-3" width={width} />
    </div>
  );
}

const DAY_LIST_GROUPS: string[][] = [
  ['62%', '48%', '71%', '39%'],
  ['55%', '67%', '44%', '58%'],
];
const WEEK_LIST_GROUPS: string[][] = [
  ['58%', '41%'],
  ['66%'],
  ['47%', '62%'],
  ['53%'],
  ['70%', '38%'],
  ['45%'],
  ['60%'],
];
const BUCKET_ROWS: string[][] = [
  ['64%', '48%', '57%'],
  ['52%', '69%'],
  ['45%'],
];
const WEEK_COLUMN_ROWS: string[][] = [
  ['80%', '62%'],
  ['70%'],
  ['85%', '55%', '66%'],
  ['60%'],
  ['75%', '50%'],
  [],
  ['68%'],
];
const BRAINDUMP_ROWS = ['72%', '55%', '81%', '47%', '64%', '58%'];
const HOUR_ROWS = 8;

function Bars({ variant, scope }: { variant: SkeletonVariant; scope: ViewScope }) {
  if (variant === 'braindump') {
    return (
      <div className="space-y-0">
        {BRAINDUMP_ROWS.map((w, i) => (
          <Row key={i} width={w} />
        ))}
      </div>
    );
  }

  if (scope === 'week' && variant !== 'list') {
    // Seven columns (the wrapper's `flex gap-7`), each a heading bar then
    // cards (buckets) or blocks (schedule).
    return (
      <>
        {WEEK_COLUMN_ROWS.map((rows, i) => (
          <div key={i} className="min-w-0 flex-1 space-y-3">
            <Bar className="h-4" width="55%" />
            {variant === 'schedule' && <div className="border-t border-border" />}
            {rows.map((w, j) => (
              <Bar key={j} className={variant === 'schedule' ? 'h-12' : 'h-8'} width={w} />
            ))}
          </div>
        ))}
      </>
    );
  }

  if (variant === 'list') {
    const groups = scope === 'week' ? WEEK_LIST_GROUPS : DAY_LIST_GROUPS;
    return (
      <>
        {groups.map((rows, i) => (
          <div key={i} className="space-y-1">
            <Bar className="mb-2 h-3.5" width={scope === 'week' ? '18%' : '24%'} />
            {rows.map((w, j) => (
              <Row key={j} width={w} />
            ))}
          </div>
        ))}
      </>
    );
  }

  if (variant === 'buckets') {
    return (
      <>
        {BUCKET_ROWS.map((rows, i) => (
          <div key={i} className="space-y-1 rounded-card border border-surface-3 px-4 py-3">
            <Bar className="mb-2 h-3.5" width="22%" />
            {rows.map((w, j) => (
              <Row key={j} width={w} />
            ))}
          </div>
        ))}
      </>
    );
  }

  // Day schedule: hairline hour rows with two blocks laid over them. The
  // blocks are absolutely placed inside the field so the hairlines keep an
  // even pitch the way the real grid's do.
  return (
    <div className="relative">
      {Array.from({ length: HOUR_ROWS }, (_, i) => (
        <div key={i} className="flex h-14 items-start gap-3 border-t border-border">
          <Bar className="mt-1 h-2.5 flex-shrink-0" width="2rem" />
        </div>
      ))}
      <div className="absolute left-14 right-4 top-[3.75rem] h-20 rounded-md bg-surface-3" />
      <div className="absolute left-14 right-1/3 top-[13rem] h-12 rounded-md bg-surface-3" />
    </div>
  );
}

export function PlannerSkeleton({
  variant,
  scope = 'day',
  wide,
  label,
}: {
  variant: SkeletonVariant;
  scope?: ViewScope;
  /** `useCanvasWide()` from the router — the week COLUMN views run
   *  edge-to-edge, and every canvas-container on the page flips together. */
  wide?: boolean;
  label?: string;
}) {
  const isBraindump = variant === 'braindump';
  const name = label ?? DEFAULT_LABEL[isBraindump ? 'braindump' : scope];

  return (
    <div
      data-testid="planner-skeleton"
      data-skeleton-variant={variant}
      data-skeleton-scope={isBraindump ? undefined : scope}
      data-wide={!isBraindump && wide ? 'true' : undefined}
      // `status` already implies polite; the canvas and the braindump each
      // carry their own name so two skeletons never announce the same line.
      role="status"
      aria-busy="true"
      className={cn(
        'planner-skeleton',
        // The braindump renders inside the list's own padded wrapper.
        !isBraindump && 'canvas-container py-6 pb-20'
      )}
    >
      <span className="sr-only">{name}</span>
      <div data-skeleton-bars aria-hidden="true" className={viewRhythm(variant, scope) || undefined}>
        <Bars variant={variant} scope={scope} />
      </div>
    </div>
  );
}
