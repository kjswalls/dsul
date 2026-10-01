'use client';

import { WeekBuckets } from '@/components/views/week-buckets';
import { WeekList } from '@/components/views/week-list';
import { WeekSchedule } from '@/components/views/week-schedule';
import { DayBuckets } from '@/components/views/day-buckets';
import { DayList } from '@/components/views/day-list';
import { DaySchedule } from '@/components/views/day-schedule';
import { PlannerSkeleton } from '@/components/primitives/planner-skeleton';
import { useCanvasWide, useViewStore } from '@/lib/view-store';
import { useDragStore } from '@/lib/drag-store';
import { usePlannerSettled } from '@/lib/planner-ready';

/**
 * Routes the canvas to one of the six scope × layout views. Subscribes to drag
 * state here (not via a prop) so a drag only re-renders the canvas subtree —
 * the views need it for drop hints, the rest of the shell doesn't.
 *
 * Until the planner's load has landed it renders a PlannerSkeleton in the
 * view's place instead of the view itself. Rendering the view over an empty
 * store drew a real, EMPTY day — "nothing planned" — for the length of every
 * cold load, which is a claim about the account, not a loading state. The
 * view mounts on the settled edge, with its data.
 */
export function ViewRouter() {
  const activeId = useDragStore((s) => s.activeId);
  const settled = usePlannerSettled();
  const wide = useCanvasWide();
  const { scope, layout } = useViewStore();

  const view = (() => {
    if (scope === 'week') {
      if (layout === 'list') return <WeekList />;
      if (layout === 'schedule') return <WeekSchedule activeId={activeId} />;
      return <WeekBuckets activeId={activeId} />;
    }
    if (layout === 'list') return <DayList />;
    if (layout === 'schedule') return <DaySchedule activeId={activeId} />;
    return <DayBuckets activeId={activeId} />;
  })();

  // Nothing in the DOM used to say WHICH of the six views was mounted, so tests
  // inferred it from droppable ids — which are ambiguous ([data-dnd-id^="week:"]
  // is emitted by both week-buckets and week-schedule; unscheduled:anytime by
  // both day-buckets and day-schedule). A layout regression then surfaced as an
  // opaque timeout in an unrelated assertion. `display: contents` so this
  // wrapper adds a marker without joining the layout.
  return (
    <div
      data-testid="view-root"
      data-view-scope={scope}
      data-view-layout={layout}
      // Whether the planner store's initial fetch has LANDED — the same
      // predicate that swaps the skeleton out, so `data-loaded="false"` and
      // the skeleton are one state. A test that acted on "the page is
      // interactive" instead could create a project, watch it appear, and find
      // it gone when initializeStore's wholesale replace landed. Why the
      // predicate is `userId && !isLoading` lives at lib/planner-ready.ts.
      data-loaded={settled ? 'true' : 'false'}
      style={{ display: 'contents' }}
    >
      {settled ? view : <PlannerSkeleton variant={layout} scope={scope} wide={wide} />}
    </div>
  );
}
