'use client';

import { memo, useCallback, useMemo } from 'react';
import { Sidebar } from '@/components/sidebar/sidebar';
import { ViewRouter } from '@/components/views/view-router';
import { ProgramNotice } from '@/components/views/program-notice';
import { DayHeaderNotice } from '@/components/notices/notice-slot';
import { HeaderCapsule } from '@/components/canvas/header-capsule';
import { WeekScale } from '@/components/canvas/week-scale';
import { ItemDialog, type ItemDialogState } from '@/components/planner/item-dialog';
import { useUIStore } from '@/lib/ui-store';
import { useCanvasWide } from '@/lib/view-store';
import { useMediaQuery } from '@/hooks/use-media-query';
import { cn } from '@/lib/utils';

/** Below this the panel stops compressing the canvas and overlays it instead. */
const PANEL_OVERLAY_QUERY = '(max-width: 1180px)';

/**
 * Desktop layout: sidebar v2 (braindump + chat + omnibar) + canvas panel on
 * the warm backdrop. The views live behind ViewRouter (P5).
 *
 * memo'd, and its one dialog read is narrowed to the edit-item payload: this
 * shell owns the docked edit panel and nothing else dialog-shaped, so opening
 * the launcher, the add modal or the shortcuts overlay must not re-render the
 * sidebar and the schedule grid it lays out. Non-edit dialogs select a stable
 * `null` (Object.is bails), and edit opens always re-render because
 * openEditFor spreads a fresh item object into the slot per open — an
 * invariant its own comment now pins.
 */
export const DesktopShell = memo(function DesktopShell() {
  // No sidebar state here any more: collapse, expand, resize and hover-peek all
  // live on the column's own edge in <Sidebar/>. This shell just lays out.
  const editItem = useUIStore((s) =>
    s.activeDialog?.type === 'edit-item' ? s.activeDialog.item : null
  );
  const closeDialog = useUIStore((s) => s.closeDialog);
  const canvasWide = useCanvasWide();

  // Editing an item IS the selection here — the ui-store's single dialog slot
  // already gives us retargeting for free: clicking another row calls
  // openEditFor, which replaces the slot, and the panel re-seeds off the new id.
  // Memoized because ItemDialog's anti-flicker latch keys on payload identity.
  const panelState = useMemo<ItemDialogState | null>(
    () => (editItem ? { mode: 'edit', item: editItem } : null),
    [editItem]
  );

  // When the panel overlays rather than compresses, the canvas underneath is
  // covered but still tabbable — so Tab would walk onto blocks and buttons
  // hidden behind an opaque card. A class can't express that; `inert` can.
  const panelOverlays = useMediaQuery(PANEL_OVERLAY_QUERY);

  // Stable so the panel's Escape listener isn't torn down and re-bound on every
  // store tick.
  const handlePanelOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeDialog();
    },
    [closeDialog]
  );

  return (
    <div className="relative hidden h-[100dvh] gap-3 bg-surface-0 p-3 md:flex">
      <Sidebar />

      {/* Body panel: a big card floating over the backdrop/sidebar field. The
          hairline border does the close-range work (it survives on top of the
          shadow at the panel's edge, which is what reads as "lifted" in dark
          mode where a black drop barely registers); shadow-elev-panel adds the
          leftward cast onto the sidebar plus a left-edge light-catch, which the
          vertical-only elev family couldn't give it.

          overflow-clip, not overflow-hidden: both clip, but a hidden box is
          still a scroll container, so Tab onto a control the docked item panel
          has pushed past this edge (Zen, the Display shelf's ✕) scrolled the
          whole canvas sideways, and with no scrollbar nothing brought it back.
          A clip box is not a scroll container, which is also why it needs
          min-w-0: its automatic minimum width would be its content's again. */}
      <main
        inert={panelOverlays && !!panelState}
        className="relative flex min-w-0 flex-1 flex-col overflow-clip rounded-[30px] border border-border bg-canvas shadow-[var(--shadow-elev-panel)]"
      >
        {/* The hover-peek trigger used to be a 12px strip here, on this panel's
            left edge. <Sidebar/>'s expand zone now covers those same pixels and
            sits above them, so this one could only ever have gone dead — the
            zone fires setLeftSidebarHovered itself. One edge, one owner.

            The expand-sidebar affordance used to live here too, absolutely
            positioned at the panel's top-left. It moved into <Sidebar/> as the
            mirror of the collapse grip: same shape, same vertical centre, sat
            in the shell's gutter instead of inside this panel — so collapsing
            and reopening happen in one place on screen rather than the control
            jumping from the seam to over the canvas. */}

        {/* Canvas header. canvas-container shares its left edge with every body
            view (Figma x=103 align).

            The two [DEV] emoji triggers that used to sit on the right are gone:
            "Show overdue tasks" and "Start end-of-day review" are real commands
            in the palette now, and the morning one no longer pokes store state
            (which left the server-side dismissal in place, so the reset died on
            the next reload). */}
        {/* data-wide tracks the body view: the week column grids drop the
            1100px cap so seven columns can actually fit, and this row drops it
            with them — the point of canvas-container is that the capsule and
            the view underneath share an edge, not that the edge is at any
            particular x. WeekScale sits at the far end of the same row, so in
            week scope it lands on the grid's right edge. */}
        <div
          data-wide={canvasWide ? 'true' : undefined}
          className="canvas-container flex flex-shrink-0 items-start gap-3 pt-[31px] pb-2"
        >
          <HeaderCapsule />
          {/* "6 items are away with Summer" — the day's own suppression line,
              beside the day it is about. It costs this row nothing: the row's
              height is max(children), which the capsule already sets — 96 at
              rest, more while its Display shelf shows — and mt-2 + h-8 lands
              its centre on the date row's (the capsule's p-2 plus half of its
              32px nav row = 24px from the top, both ways; the shelf grows the
              capsule at the bottom, so this never moves).
              Being here rather than inside a view is what gets it into `buckets`
              too — it used to exist only in day-schedule and day-list. */}
          {/* max-w bounds the truncate: program names are user data, and an
              unbounded line here would push WeekScale off the row's right end
              before it ever thought about eliding. */}
          <ProgramNotice className="mt-2 h-8 min-w-0 max-w-[260px]" />
          {/* "Today's review is waiting" — beside the date it is about, on the
              same argument and in the same row as the line above it. Free, for
              the same reason: the row's height is max(children) and the capsule
              is never shorter than 96. It goes dark on any other date and the
              line falls back to the dock. WeekScale only renders in week scope,
              so in day scope these two share the row with room to spare. */}
          <DayHeaderNotice className="mt-2 h-8 min-w-0 max-w-[280px]" />
          <WeekScale className="ml-auto" />
        </div>

        {/* The waiting bar used to sit here, and its "50px in flow, forever"
            contract was rent for the address rather than a design decision:
            lib/use-fit-hour-px.ts derives the schedule grid's hour height from
            the space left below this point, so a bar whose height tracked its
            content drove hourPx to its MIN_HOUR_PX floor. It is a line in the
            sidebar dock now (components/sidebar/dock-notices.tsx), nothing
            measures into that column, and the 50px came back to the timeline.

            The rule this leaves behind still binds: anything mounted between
            the header row and the timeline is an input to the grid's height and
            must be constant-height at every data volume, or it must not go
            here. The header row is an input too, and it has exactly one
            deliberate exception: the Display shelf under the capsule's pill,
            which grows the row by a line per row of settings while any are set
            and re-fits the grid as it comes and goes (header-capsule.tsx has
            why that cost was taken). Nothing else in the row may grow it. */}

        {/* min-h-0 is explicit rather than relying on overflow-hidden to zero the
            automatic minimum size of a flex item: this column is what
            use-fit-hour-px measures into. */}
        <div data-tour="timeline" className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ViewRouter />
        </div>

      </main>

      {/* The item panel — a sibling surface on the backdrop, not a layer over
          the canvas. `flat` drops its card chrome so it reads as the paper
          plane BELOW <main>, mirroring the braindump column on the left.
          Opening it narrows <main> (flex-1 recomputes exactly as it does for
          the braindump collapse), which is the whole argument for going
          non-modal: the day stays visible, and stays workable, beside the item.

          The width lives out here rather than in ItemDialog so the column can
          animate both ways while its contents mount and unmount — the surface
          itself must reach count 0 when closed.

          Under 1180px there is no day left worth compressing (the overlap
          layout starts wrapping panes below ~200px each), so the column goes
          back to overlaying: an absolutely-positioned flex child occupies no
          track, and <main> keeps its full width. -ml-3 eats the flex gap when
          closed, the same 12px the collapsed sidebar deliberately keeps. */}
      <div
        className={cn(
          'relative flex-shrink-0 overflow-hidden transition-[width] duration-300 ease-out',
          panelState ? 'w-[420px]' : '-ml-3 w-0',
          'max-[1180px]:absolute max-[1180px]:inset-y-3 max-[1180px]:right-3 max-[1180px]:z-30 max-[1180px]:ml-0'
        )}
      >
        <ItemDialog presentation="panel" flat state={panelState} onOpenChange={handlePanelOpenChange} />
      </div>
    </div>
  );
});
