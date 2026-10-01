'use client';

import { DayBuckets } from '@/components/views/day-buckets';
import { DayList } from '@/components/views/day-list';
import { DaySchedule } from '@/components/views/day-schedule';
import { PlannerSkeleton } from '@/components/primitives/planner-skeleton';
import { useViewStore } from '@/lib/view-store';
import { useDragStore } from '@/lib/drag-store';
import { usePlannerSettled } from '@/lib/planner-ready';

/**
 * The Today tab's view. Mobile ships a clamped subset of the desktop matrix —
 * day scope only, in Buckets / List / Schedule. It reuses the exact desktop
 * view components + the shared derivation, and reads its own drag state (drop
 * hints) rather than threading it down from the shell.
 */
export function MobileViewRouter() {
  const layout = useViewStore((s) => s.layout);
  const settled = usePlannerSettled();
  const activeId = useDragStore((s) => s.activeId);

  const view = (() => {
    if (layout === 'list') return <DayList />;
    // No overlap-column prop here on purpose: DaySchedule measures its own field
    // and derives how many channels fit at MIN_CHANNEL_PX, so this shell's ~294px
    // gets two where the desktop's ~900px gets six. Neither shell has to know.
    if (layout === 'schedule') return <DaySchedule activeId={activeId} />;
    return <DayBuckets activeId={activeId} />;
  })();

  // Same marker the desktop ViewRouter carries, so one readiness check and one
  // set of view assertions work across both shells. Mobile is day-scope only by
  // design, hence the fixed scope. `display: contents` keeps this out of layout.
  return (
    <div
      data-testid="view-root"
      data-view-scope="day"
      data-view-layout={layout}
      data-shell="mobile"
      // See the desktop ViewRouter — one readiness contract (and one skeleton
      // swap) for both shells.
      data-loaded={settled ? 'true' : 'false'}
      style={{ display: 'contents' }}
    >
      {settled ? view : <PlannerSkeleton variant={layout} scope="day" />}
    </div>
  );
}
