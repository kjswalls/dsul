'use client';

import { memo } from 'react';
import { WeekBuckets } from '@/components/views/week-buckets';
import { WeekList } from '@/components/views/week-list';
import { WeekSchedule } from '@/components/views/week-schedule';
import { DayBuckets } from '@/components/views/day-buckets';
import { DayList } from '@/components/views/day-list';
import { DaySchedule } from '@/components/views/day-schedule';
import { DoStuffDesk } from '@/components/sidebar/do-stuff-desk';
import { AtlasView } from '@/components/views/atlas/atlas-view';
import { useDeskHost, useDoStuffStore } from '@/lib/do-stuff';
import { PlannerSkeleton } from '@/components/primitives/planner-skeleton';
import { useCanvasWide, useViewStore } from '@/lib/view-store';
import { useDragStore } from '@/lib/drag-store';
import { usePlannerPreviewing, usePlannerSettled } from '@/lib/planner-ready';

/**
 * Routes the canvas to one of the six scope × layout views. Subscribes to drag
 * state here (not via a prop) so a drag only re-renders the canvas subtree —
 * the views need it for drop hints, the rest of the shell doesn't.
 *
 * Until there is something to show it renders a PlannerSkeleton in the view's
 * place instead of the view itself. Rendering the view over an empty store drew
 * a real, EMPTY day — "nothing planned" — for the length of every cold load,
 * which is a claim about the account, not a loading state. The view mounts on
 * the first of two edges, with data either way:
 *  - the look-only PREVIEW (lib/planner-snapshot.ts): this browser's copy of
 *    the last session, painted while the load is still in flight. Inert, and
 *    marked `data-preview`; never `data-loaded`.
 *  - the settled edge, when the fresh load lands (or fails).
 * Preview → fresh is the SAME element tree, just its data swapped and `inert`
 * lifted, so nothing here may be keyed on settled or previewing: rows keep
 * their identity (and their scroll) across the swap, which the settle's FLIP
 * depends on.
 *
 * memo'd, with no props: DesktopShell re-renders for the right column's
 * overlay (`covered`), and that must not re-render the day under it.
 */
export const ViewRouter = memo(function ViewRouter() {
  const activeId = useDragStore((s) => s.activeId);
  const settled = usePlannerSettled();
  const previewing = usePlannerPreviewing();
  const visible = settled || previewing;
  const wide = useCanvasWide();
  const { scope, layout, atlasLayout } = useViewStore();
  // Doing stuff at the Desk: the canvas is the current item beside today's day
  // column, whatever the scope and layout (components/sidebar/do-stuff-desk.tsx).
  const desk = useDoStuffStore((s) => s.on && s.desk);
  // This router is what draws the desk, so it says so (the phone's router
  // never does, and there openDesk() is a no-op and the ⤢ is not drawn).
  useDeskHost();

  const view = (() => {
    if (desk) return <DoStuffDesk activeId={activeId} />;
    // Atlas: containers as cards on a map (components/views/atlas/). Desktop
    // only; the phone's router never reads scope.
    if (scope === 'atlas') return <AtlasView activeId={activeId} />;
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
      data-view-layout={scope === 'atlas' ? atlasLayout : layout}
      // Whether the planner store's initial fetch has LANDED — the same
      // predicate that swaps the skeleton out, so `data-loaded="false"` and
      // the skeleton are one state. A test that acted on "the page is
      // interactive" instead could create a project, watch it appear, and find
      // it gone when initializeStore's wholesale replace landed. Why the
      // predicate is `userId && !isLoading` lives at lib/planner-ready.ts.
      // FRESH only, never the preview: e2e acts on this, and a persistence
      // spec must never pass by reading this browser's cache back.
      data-loaded={settled ? 'true' : 'false'}
      // The look-only state: the real view, painted from the cache, refusing
      // every pointer and focus (`inert`) until the fresh data replaces it.
      // Store writes are refused underneath regardless (lib/preview-write-guard.ts);
      // inert is so nothing on screen is a silent no-op.
      data-preview={previewing ? 'true' : undefined}
      data-settle-scope="canvas"
      inert={previewing}
      style={{ display: 'contents' }}
    >
      {visible ? (
        view
      ) : (
        <PlannerSkeleton variant={scope === 'atlas' ? 'atlas' : layout} scope={scope} wide={wide} />
      )}
    </div>
  );
});
