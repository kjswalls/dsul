'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Sidebar } from '@/components/sidebar/sidebar';
import { ViewRouter } from '@/components/views/view-router';
import { SeasonNotice } from '@/components/views/season-notice';
import { DayHeaderNotice } from '@/components/notices/notice-slot';
import { HeaderCapsule } from '@/components/canvas/header-capsule';
import { WeekScale } from '@/components/canvas/week-scale';
import { ItemDialog, type ItemDialogState } from '@/components/planner/item-dialog';
import { registerItemPanelClose, useUIStore } from '@/lib/ui-store';
import { useSelectionStore } from '@/lib/selection-store';
import { subscribeClickAway } from '@/lib/click-away';
import { useCanvasWide, useViewStore } from '@/lib/view-store';
import { SectionBoundary } from '@/components/primitives/section-boundary';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useFocusOnlyScroll } from '@/hooks/use-focus-only-scroll';
import { useLayoutDef } from '@/lib/look-store';
import { canvasHeaderPad, layoutAttributes } from '@/lib/layout-themes';
import { SidebarDock } from '@/components/sidebar/sidebar-dock';
import { BraindumpPane } from '@/components/shell/braindump-pane';
import { StatusLine } from '@/components/shell/status-line';
import { PageTabs, Ribbon } from '@/components/shell/page-tabs';
import { DayTabs } from '@/components/shell/day-tabs';
import { PageCount, StatusBar } from '@/components/shell/status-bar';
import { HelpMenu } from '@/components/shell/help-menu';
import { RightRail } from '@/components/ai/rail/right-rail';
import { AskSetup } from '@/components/ai/rail/ask-setup';
import { AskOpener } from '@/components/ai/rail/ask-opener';
import { useBackLabel } from '@/components/ai/rail/rail-header';
import { ModOpener } from '@/components/mods/mod-opener';
import { ModRail } from '@/components/mods/mod-rail';
import { useModsStore } from '@/lib/mods-store';
import { modSurfaceLabel } from '@/lib/mods/labels';
import {
  PANEL_OVERLAY_QUERY,
  RAIL_RESERVE_PX,
  clearRailFocusRecord,
  noteRailEntry,
  railMode,
  useRailCovers,
  useRailStore,
} from '@/lib/rail-store';
import { askOpenOf, useSidebarStore } from '@/lib/sidebar-store';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { prefersReducedMotion } from '@/lib/zen-transition';
import { cn } from '@/lib/utils';

/**
 * How long Ask stays painted after it starts leaving the docked column if the
 * column never reports the end of its ease: its 300ms and a little.
 */
const LEAVE_FALLBACK_MS = 400;

/**
 * Desktop layout: sidebar v2 (braindump + omnibar) + canvas panel + the right
 * column (RailColumn: the item panel and Ask) on the warm backdrop. The views
 * live behind ViewRouter (P5).
 *
 * memo'd, and its one dialog read is narrowed to the edit-item payload: this
 * shell owns the docked edit panel and nothing else dialog-shaped, so opening
 * the launcher, the add modal or the shortcuts overlay must not re-render the
 * sidebar and the schedule grid it lays out. Non-edit dialogs select a stable
 * `null` (Object.is bails), and edit opens always re-render because
 * openEditFor spreads a fresh item object into the slot per open — an
 * invariant its own comment now pins.
 *
 * LAYOUTS (lib/layout-themes.ts). The structural slots are read here: where the
 * braindump sits (`sidebar`), where capture sits (`capture`), whether the
 * canvas is a plate (`canvas`), the day tabs across the top (`tabs`), and the
 * `status-line`, `status-bar` and `page-count` ornaments. The styled
 * slots are stamped on this root (layoutAttributes) for app/globals.css, which
 * is what keeps every layout off the phone. Classic renders the exact tree it
 * always has; a layout with a top or bottom band wraps the row in a column.
 */
export const DesktopShell = memo(function DesktopShell() {
  // No sidebar state here any more: collapse, expand, resize and hover-peek all
  // live on the column's own edge in <Sidebar/>. This shell just lays out.
  const editItem = useUIStore((s) =>
    s.activeDialog?.type === 'edit-item' ? s.activeDialog.item : null
  );
  const closeDialog = useUIStore((s) => s.closeDialog);
  const canvasWide = useCanvasWide();
  const layout = useLayoutDef();
  const { slots } = layout;
  const plate = slots.canvas === 'plate';
  const spread = slots.canvas === 'spread';
  const sheet = slots.canvas === 'sheet';
  const flatPanel = slots.canvas === 'flat' || sheet;
  const statusLine = layout.ornaments.includes('status-line');
  const statusBar = layout.ornaments.includes('status-bar');
  const pageCount = layout.ornaments.includes('page-count');
  const tabs = slots.tabs === 'none' ? null : slots.tabs;
  const captureBottom = slots.capture === 'prompt-bottom';
  // A top or bottom band spans the whole shell, so the row goes in a column.
  const banded = statusLine || captureBottom || !!tabs || statusBar || pageCount;

  // Editing an item IS the selection here — the ui-store's single dialog slot
  // already gives us retargeting for free: clicking another row calls
  // openEditFor, which replaces the slot, and the panel re-seeds off the new id.
  // Memoized because ItemDialog's anti-flicker latch keys on payload identity.
  const panelState = useMemo<ItemDialogState | null>(
    () => (editItem ? { mode: 'edit', item: editItem } : null),
    [editItem]
  );

  // When the right column overlays rather than compresses, the canvas
  // underneath is covered but still tabbable — so Tab would walk onto blocks
  // and buttons hidden behind an opaque card. A class can't express that;
  // `inert` can. `covered` is whether it shows as that overlay (an item, or
  // Ask summoned while overlaid; lib/rail-store.ts railMode): one boolean,
  // and constant false while the column docks, so neither a push inside the
  // rail nor a docked open or close (Ctrl+J from 1180px up) re-renders this
  // shell, its braindump and its day. The column re-renders alone; the one
  // thing out here a docked column changes, Notebook's padding, is CSS
  // (`data-rail-docked`, below).
  const panelOverlays = useMediaQuery(PANEL_OVERLAY_QUERY);
  const covered = useRailCovers(panelOverlays);

  // With the panel docked, the header row can be wider than <main>, and Tab
  // onto a control past its edge scrolls <main> to show it. This puts <main>
  // back once focus has moved on (the hook has the whole story).
  const mainRef = useRef<HTMLElement>(null);
  useFocusOnlyScroll(mainRef);

  // Stable so the panel's Escape listener isn't torn down and re-bound on every
  // store tick.
  //
  // A plain row click both selects the row and opens it here, so closing the
  // panel — Done, Escape, click-away — lets go of that one-row selection too;
  // otherwise the row keeps its latched wash with nothing open. Only when the
  // lone selected id IS the panel's item: a 2+ multi-select is the bulk bar's,
  // and a single ⌘-clicked row that was never opened isn't the panel's to drop.
  const handlePanelOpenChange = useCallback(
    (open: boolean) => {
      if (open) return;
      const dialog = useUIStore.getState().activeDialog;
      const selection = useSelectionStore.getState();
      if (
        dialog?.type === 'edit-item' &&
        selection.selectedIds.size === 1 &&
        selection.selectedIds.has(dialog.item.id)
      ) {
        selection.clear();
      }
      closeDialog();
    },
    [closeDialog]
  );

  // Click on empty space clears the selection (lib/click-away.ts). The panel
  // subscribes separately, while open, so it can flush before it closes.
  useEffect(() => subscribeClickAway(() => useSelectionStore.getState().clear()), []);

  // The shell's close, for an item closed from outside the panel (Ctrl+J, `?`):
  // lib/ui-store.ts closeItemPanel flushes the panel's edit, then calls this, so
  // the one-row selection rule above holds there too.
  useEffect(() => registerItemPanelClose(() => handlePanelOpenChange(false)), [handlePanelOpenChange]);

  // Each region fails on its own (#74, components/primitives/section-boundary.tsx):
  // a throw in the grid no longer takes the braindump and the rail with it.
  // Moving to another view clears the canvas's caught error.
  const viewKey = useViewStore((s) => `${s.scope}:${s.layout}`);
  const sidebarLeft = slots.sidebar === 'left' && (
    <SectionBoundary label="braindump" className="w-[280px] flex-none">
      <Sidebar />
    </SectionBoundary>
  );
  const pages = (
    <>
      {sidebarLeft}

      {/* Body panel: a big card floating over the backdrop/sidebar field. The
          hairline border does the close-range work (it survives on top of the
          shadow at the panel's edge, which is what reads as "lifted" in dark
          mode where a black drop barely registers); shadow-elev-panel adds the
          leftward cast onto the sidebar plus a left-edge light-catch, which the
          vertical-only elev family couldn't give it.

          overflow-hidden, not overflow-clip: a hidden box is still a scroll
          container, so focus can scroll it to show a control the docked item
          panel has pushed past this edge, and useFocusOnlyScroll brings it back
          (a clip box would leave that focus on a control nobody can see).

          @container/canvas: the day's own width, for what has to fit in it.
          The window is no measure of that any more: a docked right rail takes
          432px of it, and the braindump yields only down to its 280px minimum,
          so at a 1181px window the day is 381px in Notebook (sidebar-store.ts
          renderedSidebarWidth has the figures per layout). The header row
          (below), the header capsule (app/globals.css, "The header on a narrow
          canvas") and a row's trailing rail (task-row.tsx) compress against it.
          inline-size only: <main>'s width comes from the flex row, never from
          what is in it (overflow-hidden already zeroes its minimum), so the
          containment changes no layout. */}
      <main
        ref={mainRef}
        inert={covered}
        className={cn(
          '@container/canvas relative flex flex-1 flex-col overflow-hidden',
          // Spread and sheet: the page shares the paper under both panes
          // (app/globals.css, [data-book] / [data-sheet]) rather than being a
          // surface of its own.
          spread || sheet ? 'bg-transparent' : 'bg-canvas',
          plate && 'rounded-[30px] border border-border shadow-[var(--shadow-elev-panel)]'
        )}
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
        {/* Below a 640px canvas the row wraps, so what does not fit beside the
            capsule (WeekScale in week scope, a notice) goes under it instead of
            past <main>'s edge. Above that it is one row, as it always was: a
            notice that does not fit shrinks and truncates there. */}
        <div
          data-wide={canvasWide ? 'true' : undefined}
          className={cn(
            'canvas-container flex flex-shrink-0 items-start gap-3 pb-2 @max-[640px]/canvas:flex-wrap',
            // 31px lines the capsule up with the left column's braindump
            // header; with the braindump elsewhere there is nothing to meet.
            // Shared with the rail's header row, which sits on this one.
            canvasHeaderPad(slots)
          )}
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
          {/* max-w bounds the truncate: season names are user data, and an
              unbounded line here would push WeekScale off the row's right end
              before it ever thought about eliding. */}
          <SeasonNotice className="mt-2 h-8 min-w-0 max-w-[260px]" />
          {/* "Today's review is waiting" — beside the date it is about, on the
              same argument and in the same row as the line above it. Free, for
              the same reason: the row's height is max(children) and the capsule
              is never shorter than 96. It goes dark on any other date and the
              line falls back to the dock. WeekScale only renders in week scope,
              so in day scope these two share the row with room to spare. */}
          <DayHeaderNotice className="mt-2 h-8 min-w-0 max-w-[280px]" />
          <WeekScale className="ml-auto" />
          {/* The Ask button, while Ask is closed: the row's far end, its key
              on the date's line, past WeekScale in the week views (which hold
              the far end themselves). It gives way to everything else here
              (ask-opener.tsx has the rules). */}
          <AskOpener className={canvasWide ? undefined : 'ml-auto'} />
          {/* The key to a mod's panels, after the Ask button: it takes the
              row's far end itself only when the Ask button is not offered
              (mod-opener.tsx). */}
          <ModOpener />
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
          <SectionBoundary label="view" resetKey={viewKey}>
            <ViewRouter />
          </SectionBoundary>
        </div>

        {/* The "?" help hub, in the canvas's own corner (help-menu.tsx has why
            it is in here and not fixed to the window, and why 10px). */}
        <HelpMenu className="absolute right-2.5 bottom-2.5 z-30" />
      </main>
    </>
  );

  const row = (
    <>
      {spread ? (
        // One sheet of paper under both pages, so the braindump and the day
        // read as facing pages of one book. The ornaments hang off the book,
        // not off <main>, which clips its overflow.
        // gap-3 is the sidebar sash's gutter, as in Classic: without it the
        // sash would sit over the right page's first 12px and take its clicks.
        <div data-book="" className="relative flex min-w-0 flex-1 gap-3">
          {pages}
          {/* Inert with <main> while the right column overlays: they sit
              under it then, and must not stay in the tab order. The ribbon
              hangs 12px in from the page's right edge, clear of WeekScale
              (32px). */}
          <div inert={covered} className="contents">
            {layout.ornaments.includes('ribbon') && (
              <Ribbon className="absolute top-0 right-3 z-[5]" />
            )}
            {layout.ornaments.includes('page-tabs') && (
              <PageTabs className="absolute top-28 left-full z-[5]" />
            )}
          </div>
        </div>
      ) : sheet ? (
        // One document under both panes, the window's chrome around it
        // (app/globals.css, [data-sheet]). gap-3 is the sash's gutter, as in
        // the spread; the seam is drawn on the column's own edge.
        <div data-sheet="" className="relative flex min-w-0 flex-1 gap-3 bg-canvas">
          {pages}
        </div>
      ) : (
        pages
      )}

      {slots.sidebar === 'pane-right' && <BraindumpPane covered={covered} />}

      {/* The right column, a sibling surface on the backdrop, not a layer over
          the canvas (RailColumn below has the whole story). */}
      <RailColumn
        panelState={panelState}
        onPanelOpenChange={handlePanelOpenChange}
        overlays={panelOverlays}
        plate={plate}
        spread={spread}
        flatPanel={flatPanel}
      />
    </>
  );

  return (
    <div
      // Clicks on empty space in here let go of the selection (lib/click-away).
      data-click-away-scope=""
      {...layoutAttributes(layout)}
      className={cn(
        'relative hidden h-[100dvh] md:flex',
        plate
          ? 'gap-3 bg-surface-0 p-3'
          : spread
            ? // pr-14 holds the page tabs. Only a DOCKED rail (an item or Ask)
              // takes that room; an overlaid one (<1180px) takes no width, so
              // the book keeps it. Keyed off the column's own
              // `data-rail-docked` rather than a store read, so opening and
              // closing the rail never re-renders this shell; and it holds
              // while Ask eases out, with the sheet it sits on (RailColumn).
              'bg-[var(--nb-desk)] p-5 pr-14 has-[[data-rail-docked]]:pr-5'
            : sheet
              ? 'bg-[var(--np-chrome)]'
              : 'bg-canvas',
        banded && 'flex-col'
      )}
    >
      {banded ? (
        <>
          {statusLine && <StatusLine />}
          {tabs && <DayTabs variant={tabs} />}
          <div className="relative flex min-h-0 flex-1">{row}</div>
          {captureBottom && <SidebarDock placement="bottom" />}
          {statusBar && <StatusBar />}
          {pageCount && <PageCount className="bg-canvas" />}
        </>
      ) : (
        row
      )}
    </div>
  );
});

/** What the column takes from DesktopShell: the item slot, its close, and the layout. */
type RailColumnProps = {
  panelState: ItemDialogState | null;
  onPanelOpenChange: (open: boolean) => void;
  overlays: boolean;
  plate: boolean;
  spread: boolean;
  flatPanel: boolean;
};

/**
 * The right column: the item panel and Ask, one 420px column
 * (lib/rail-store.ts railMode). An open item is on top; with nothing open it
 * is Ask when Ask is kept open and something answers; otherwise it is closed.
 *
 * Its own memo'd component because DesktopShell is memo'd so that non-edit UI
 * changes never re-render the sidebar and the grid, and its children are not.
 * So the Ask subscriptions (`askOpen`, `summoned`, the stack's top, the gate)
 * live here, and a push, a Back or a rename re-renders only this column.
 *
 * WITH NO AI (nothing answers: no model, the gate unknown, AI hidden, or
 * "Who answers: Off") it is the item host: no Ask, no rail header, no box, and
 * the item is today's panel, Done included. The one other thing it shows
 * then is the setup column (components/ai/rail/ask-setup.tsx), when the gate
 * offers to set AI up or fix it and the unlit key or Ctrl+J summoned it; it
 * is never kept open, and it is never under an item. With AI the item wears
 * the rail's header ("‹ Ask", ✕) and its conversation's box is pinned at the
 * bottom, and Ask stays mounted underneath it, `hidden` and `inert`
 * (right-rail.tsx has why).
 *
 * A MOD'S PANEL (components/mods/mod-rail.tsx) is the column's third
 * occupant, opened only by an explicit open (lib/mods/ui/open-panel.ts) and
 * shown at any width, with or without AI. It sits between the item and Ask
 * (railMode's 'mod'): an item opens over it, mounted beneath as Ask is, and
 * wears the rail's header "‹ Your mod · <name>"; Ask's summon replaces it.
 *
 * The width lives out here rather than in ItemDialog so the column can animate
 * both ways while its contents mount and unmount — the item surface itself
 * must reach count 0 when closed. Opening it narrows <main> (flex-1 recomputes
 * exactly as it does for the braindump collapse), which is the whole argument
 * for going non-modal: the day stays visible, and workable, beside the item.
 *
 * Under 1180px there is no day left worth compressing (the overlap layout
 * starts wrapping panes below ~200px each), so the column overlays instead:
 * an absolutely-positioned flex child occupies no track, and <main> keeps its
 * full width (and goes inert, DesktopShell's `covered`). Ask overlays only
 * when summoned there, never from the persisted `askOpen` at boot, and it
 * gives the planner back on click-away, on Escape, and when a docked window
 * narrows past 1180. -ml-3 eats the flex gap when closed, the same 12px the
 * collapsed sidebar deliberately keeps.
 */
export const RailColumn = memo(function RailColumn({
  panelState,
  onPanelOpenChange,
  overlays,
  plate,
  spread,
  flatPanel,
}: RailColumnProps) {
  const askOpen = useSidebarStore(askOpenOf);
  const summoned = useRailStore((s) => s.summoned);
  const askTop = useRailStore((s) => s.stacks.desktop.at(-1));
  const modPanel = useRailStore((s) => s.modPanel);
  const { canChat, askInvite, askFix } = useAICapabilities();
  const mode = railMode({
    itemOpen: !!panelState,
    modOpen: !!modPanel,
    askOpen,
    canChat,
    overlays,
    summoned,
    invite: askInvite || askFix,
  });
  const shown = mode !== 'hidden';

  // Ask LEAVING a docked column: Ctrl+J or ✕ at Ask. It stays painted (and
  // inert, with none of its listeners) while the column eases shut, then
  // unmounts, so the close slides it out the way the open slid it in. Left to
  // unmount in the closing commit, the column eased shut empty, which on the
  // plate's transparent backdrop reads as Ask vanishing at once; and the
  // unmount's own work could eat the 300ms ease outright. Not at an overlay,
  // whose card chrome goes with `shown`, not under reduced motion, where there
  // is no ease to wait for, and not when an item closes: the item panel's
  // content leaves at once as it always has (item-dialog.tsx), and Ask was
  // hidden under it. Derived in render, from the mode it is leaving, so the
  // view is never unmounted for even one commit.
  // The setup column leaves the same way (Ctrl+J, ✕, Escape, No AI, thanks).
  const [shownMode, setShownMode] = useState(mode);
  const [leaving, setLeaving] = useState(false);
  const [setupLeaving, setSetupLeaving] = useState(false);
  // A mod's panel leaves the same way, and is drawn from the ref it last had
  // while it does (`modPanel` is already null then).
  const [modLeaving, setModLeaving] = useState(false);
  const [lastModRef, setLastModRef] = useState(modPanel);
  if (modPanel && modPanel !== lastModRef) setLastModRef(modPanel);
  if (shownMode !== mode) {
    setShownMode(mode);
    const eases = mode === 'hidden' && !overlays && !prefersReducedMotion();
    setLeaving(shownMode === 'ask' && eases);
    setSetupLeaving(shownMode === 'setup' && eases);
    setModLeaving(shownMode === 'mod' && eases);
  }
  // The fallback for an ease that never reports its end (a tab in the
  // background, a width interrupted at the same value).
  useEffect(() => {
    if (!leaving && !setupLeaving && !modLeaving) return;
    const timer = setTimeout(() => {
      setLeaving(false);
      setSetupLeaving(false);
      setModLeaving(false);
    }, LEAVE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [leaving, setupLeaving, modLeaving]);

  // Ask stays mounted under an item, so Back finds it as it was.
  const askMounted = canChat && (askOpen || summoned || leaving);
  // So does the setup column, under the same summon: a key left in its box,
  // and what was said about it, are still there when the item closes. Shown
  // only in 'setup'; hidden and inert under the item (AskSetup's `visible`).
  // Gone the moment something answers, when the column becomes Ask.
  const setupMounted = (summoned && (askInvite || askFix) && !canChat) || setupLeaving;
  // A mod's panel stays mounted under an item opened over it, hidden and
  // inert (ModRail's `visible`), so Back finds it as it was.
  const modMounted = !!modPanel || modLeaving;
  const modRef = modPanel ?? lastModRef;
  // The name an item opened over a mod's panel goes back to: the host's
  // chrome ("Your mod · Water"), never the panel's own words.
  const modBackLabel = useModsStore((s) => {
    const row = modPanel ? s.rows.find((r) => r.id === modPanel.modId) : undefined;
    return modPanel ? `Your mod · ${row ? modSurfaceLabel(row) : 'Your mod'}` : null;
  });
  // The item goes back to whatever Ask has on top (the item is ui-store's
  // slot, not a stack entry), by its live name.
  const itemBack = useBackLabel(null, askTop);

  // The first reveal from the persisted `askOpen` (the gate answering at
  // boot) lands at full width without the slide, so a launch does not animate
  // Ask in every time; every reveal after it, and any summon, slides. The
  // transition comes back one frame after the column first shows Ask.
  const [revealed, setRevealed] = useState(false);
  const instant = !revealed && mode === 'ask' && !summoned;
  useEffect(() => {
    if (revealed || mode !== 'ask') return;
    const frame = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(frame);
  }, [revealed, mode]);

  // What the canvas gives up: the column and its gap while docked, for an item
  // and for Ask alike. The braindump yields to it (components/sidebar/
  // sidebar.tsx), its sash caps growth by it, and the bulk bar centres beside
  // it. A layout effect, so the braindump's yield is published before this
  // commit paints and the two columns move in the same frame; `instant` with
  // the column's own instant reveal, so the boot reveal slides neither. With
  // it, whether the column covers the canvas as an overlay, for the bulk bar,
  // which stands down then (bulk-action-bar.tsx).
  useLayoutEffect(() => {
    const rail = useRailStore.getState();
    rail.setReserve(shown && !overlays ? RAIL_RESERVE_PX : 0, { instant });
    rail.setCovers(shown && overlays);
  }, [shown, overlays, instant]);
  useEffect(
    () => () => {
      const rail = useRailStore.getState();
      rail.setReserve(0);
      rail.setCovers(false);
    },
    []
  );

  // The column's dress (the flat seam and fill, the spread's loose sheet, and
  // Notebook's page-tab padding out on the shell) goes with what is ON it,
  // not with `shown`: Ask leaving is still painted for the whole ease, and
  // undressed it sat bare on the desk, the grey chrome or the backdrop for
  // 300ms. The width eases on `shown`, so the close still starts at once.
  const dressed = shown || leaving || setupLeaving || modLeaving;

  // The rail's focus record (lib/rail-store.ts) is per showing: a close takes
  // it, and the column hiding any other way (the item's Done or Escape with
  // Ask closed) drops it, so it never answers a later, unrelated close.
  useEffect(() => {
    if (!shown) clearRailFocusRecord();
  }, [shown]);

  // A docked Ask whose window narrows into overlay goes away: `summoned` is
  // set by every explicit open, at any width, and would otherwise bring it up
  // as an overlay over an inert planner (a half-screen snap is 960px). After
  // the edge only a summon made there shows it. So does a mod's panel
  // (parkOverlay). An item on top stays.
  const wasOverlay = useRef(overlays);
  useEffect(() => {
    if (overlays && !wasOverlay.current) useRailStore.getState().parkOverlay(true);
    wasOverlay.current = overlays;
  }, [overlays]);

  // An overlay is never a resting surface: a click on the covered canvas
  // (which, inert, lands on the shell's click-away scope) gives the planner
  // back. An item on top closes through its own subscription as well, so one
  // click closes the item and does not raise Ask as a second overlay.
  useEffect(() => {
    if (!shown || !overlays) return;
    return subscribeClickAway(() => useRailStore.getState().parkOverlay(true));
  }, [shown, overlays]);

  // An item over a mod's panel wears the rail's header, with or without AI:
  // Back closes the item (RailHeader closes it first), which shows the panel
  // again; ✕ closes the item and then the panel. With no mod beneath, Back
  // goes to Ask, and with no AI either the item keeps Done.
  const railChrome = useMemo(
    () =>
      modBackLabel
        ? {
            backLabel: modBackLabel,
            onBack: undefined,
            onCloseRail: () => useRailStore.getState().closeModPanel(),
          }
        : canChat
          ? {
              backLabel: itemBack,
              // Back shows Ask, at an overlay too, where nothing else would.
              onBack: () => useRailStore.getState().summon(),
              onCloseRail: () => useRailStore.getState().closeRail(),
            }
          : undefined,
    [canChat, itemBack, modBackLabel]
  );

  return (
    <div
      data-rail=""
      data-tour={canChat ? 'right-sidebar' : undefined}
      data-instant={instant ? '' : undefined}
      // Docked and dressed: what Notebook's shell keys its page-tab padding
      // off (DesktopShell's root, `has-[[data-rail-docked]]`).
      data-rail-docked={dressed && !overlays ? '' : undefined}
      // Where focus came from into the column: what closing Ask hands it back
      // to, when Ask was open from boot and no summon noted anything.
      onFocus={(e) => noteRailEntry(e.relatedTarget)}
      // The ease shut has ended: Ask, kept painted for it, can go.
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget || e.propertyName !== 'width') return;
        if (leaving) setLeaving(false);
        if (setupLeaving) setSetupLeaving(false);
        if (modLeaving) setModLeaving(false);
      }}
      className={cn(
        // titlebar-hole: the item panel scrolls (surface.tsx), and so does Ask,
        // so their content passes under the desktop app's drag band, where it
        // could not be clicked.
        'titlebar-hole relative flex-shrink-0 overflow-hidden',
        // The same ease both ways (Ask is kept painted while it leaves, above),
        // and none at all under reduced motion, opening or closing. The
        // plate's -ml-3 eases with the width, so its gutter goes over the
        // same 300ms instead of snapping 12px at the start of the ease.
        instant
          ? 'transition-none'
          : cn(
              plate ? 'transition-[width,margin-left]' : 'transition-[width]',
              'duration-300 ease-out motion-reduce:transition-none'
            ),
        shown ? 'w-[420px]' : cn('w-0', plate && '-ml-3'),
        // Flat and sheet: no gutter to eat, and a hairline seam where the
        // plate's edge was. box-content, as for the overlaid card below: the
        // seam is drawn OUTSIDE the 420px the item aside and Ask are sized to,
        // or they overflowed the column by its 1px and lost their right edge.
        flatPanel && dressed && 'box-content border-l border-border bg-canvas',
        // Spread: a loose sheet laid beside the book, clear of its page tabs.
        // Its ml-12 is dress too, held with the shell's pr-5 while Ask leaves:
        // the book's edge then eases from where it rests open to 12px short of
        // where it rests closed, the mirror of the open, which starts 12px
        // narrower. Snapping both at the start instead threw the book 36px
        // narrower before the ease began.
        spread && dressed && 'ml-12 rounded-[6px] bg-[var(--nb-page)] shadow-[var(--nb-sheet-shadow)]',
        plate
          ? 'max-[1180px]:absolute max-[1180px]:inset-y-3 max-[1180px]:right-3 max-[1180px]:z-30 max-[1180px]:ml-0'
          : spread
            ? 'max-[1180px]:absolute max-[1180px]:inset-y-5 max-[1180px]:right-5 max-[1180px]:z-30 max-[1180px]:ml-0'
            : 'max-[1180px]:absolute max-[1180px]:inset-y-0 max-[1180px]:right-0 max-[1180px]:z-30',
        // Overlaid, an opaque card over the canvas, and ONLY while shown: the
        // positioning above holds when closed too, and a closed column is w-0,
        // where a border would still draw a 2px sliver and the shadow a streak
        // down the window's right edge. box-content: the card's 1px border goes
        // OUTSIDE the 420px its children are sized to (the item aside and Ask
        // are fixed w-[420px]), or they would overflow by 2px, be clipped on
        // the right and sit 1px off where the borderless column put them.
        shown &&
          plate &&
          'max-[1180px]:box-content max-[1180px]:rounded-[30px] max-[1180px]:border max-[1180px]:border-border max-[1180px]:bg-canvas max-[1180px]:shadow-[var(--shadow-elev-panel)]',
        shown && flatPanel && 'max-[1180px]:bg-canvas max-[1180px]:shadow-[var(--shadow-elev-panel)]'
      )}
    >
      {/* The column's direct child: the titlebar hole is what makes the item
          clickable under the drag band (desktop-panel-titlebar.test.tsx).
          `flat` drops its card chrome so it reads as the paper plane BELOW
          <main>, mirroring the braindump column on the left. */}
      <ItemDialog
        presentation="panel"
        flat
        state={panelState}
        onOpenChange={onPanelOpenChange}
        railChrome={railChrome}
        conversation={canChat ? 'pinned' : 'none'}
      />
      {askMounted && (
        <SectionBoundary label="Ask panel" className="w-[360px] flex-none">
          <RightRail visible={mode === 'ask'} leaving={leaving} overlays={overlays} />
        </SectionBoundary>
      )}
      {setupMounted && (
        <SectionBoundary label="AI setup" className="w-[360px] flex-none">
          <AskSetup visible={mode === 'setup'} leaving={setupLeaving} />
        </SectionBoundary>
      )}
      {modMounted && modRef && (
        <SectionBoundary label="mod panel" className="w-[360px] flex-none">
          <ModRail visible={mode === 'mod'} leaving={modLeaving} overlays={overlays} panelRef={modRef} />
        </SectionBoundary>
      )}
    </div>
  );
});
