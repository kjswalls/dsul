'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { X } from 'lucide-react';
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalDescription,
} from '@/components/ui/responsive-modal';
import {
  ConsoleRail,
  consoleSectionsFor,
  isConsoleSection,
  sectionMeta,
  type ConsoleSection,
  type ConsoleSectionSpec,
} from './console-rail';
import { useExtensionPredicate } from '@/lib/extension-gates';
import { useConsoleHost } from '@/lib/console-door';
import { KeyCap } from './primitives';
import { useEscapeLadder } from './escape-ladder';
import { RoutinesSection } from './sections/routines';
import { SeasonsSection } from './sections/seasons';
import { GoalsSection } from './sections/goals';
import { ProjectsSection, TypesSection } from './sections/labels';
import { OverviewSection } from './sections/overview';
import { TrashSection } from './sections/trash';
import { cn } from '@/lib/utils';

/**
 * ORGANIZE — one console for every container and label.
 *
 * Replaces ManageCollectionsDialog (680px) and ManageCategoriesDialog (400px).
 * The full rationale, the three rejected container directions and the adversarial
 * verdicts are in memory/plans/organize-console.md; only the load-bearing
 * mechanics are repeated here.
 *
 * WHY A MODAL, given Settings became a route. Frequency. Every journey reviewer
 * independently found the same thing: this is a PERIODIC surface — under thirty
 * objects, one person, opened monthly. The modal keeps four things a route
 * forfeits: the vaul bottom sheet for free (which ManageCategoriesDialog never
 * had — it is a 400px centred box on a phone today), both e2e `closeManager`
 * helpers unchanged, focus trap and focus-return, and AppShell's services —
 * DndContext, the undo toast, and ⌘Z, which every delete confirm's copy now
 * explicitly promises.
 *
 * The console body is deliberately a COMPONENT rather than a dialog body, so
 * adding `/organize` later is an additive PR that renders this same tree rather
 * than a rebuild. Buy the URL when the URL is wanted.
 *
 * GEOMETRY — 1082 × up to 820, sized from the columns up:
 *   rail 180 | 1px | list 300 | 1px | detail 600   = 1082
 *   header 48 + body 740 + footer 32               = 820 (was 640)
 * The height is still FIXED per viewport — it never changes on a section
 * change — but takes up to 820 of it (min with 100vh − 80), so a goal with a
 * timeline and three lists reads without a scroll on an ordinary laptop.
 * The detail column grew from 456 when member rows gained week dots and a
 * wider control rail: at 456 a title kept ~64px. It needs a 1146×720 viewport,
 * so it fits 1280×800 with 134×80 to spare; narrower, the plate shrinks with
 * the window and the detail column (flex-1) gives up the difference. Fixed
 * is the point: the frame never resizes on a section change, which is the
 * loudest un-premium tell in both dialogs it replaces.
 *
 * GROUND — every pane sits on `bg-modal`. There is NO background step anywhere
 * inside the plate; depth is the hairline, full stop. A rail on `--surface-1`
 * over `--modal` is a 0.6% step in light (invisible) and a 3.2-point step in
 * dark, and the obvious fix inverts because `--surface-3` is LIGHTER than
 * `--modal` in dark. Removing the step removes the per-theme problem entirely.
 */

export interface OrganizeConsoleProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Section to land on. Unknown values fall back to routines. */
  section?: string;
  /** Select this object on arrival and scroll its row into view. */
  focusId?: string;
  /** Open straight into this section's create form (the "New …" entries). */
  focusNew?: boolean;
}

export function OrganizeConsole({
  open,
  onOpenChange,
  section,
  focusId,
  focusNew,
}: OrganizeConsoleProps) {
  /* "A console exists in this tree" — registered here, by the component that
     cannot be wrong about it, so that an Organize door on a route without one
     navigates instead of arming a slot nothing reads. First statement in the
     body, above every early return below, because hook order has to hold on
     every path through this component. See lib/console-door.ts. */
  useConsoleHost();

  /**
   * The sections this account actually has, and the console's own gate.
   *
   * Each row names the extension it rides (console-rail.tsx), so with the
   * Organize console off and Goals on this is exactly one section — the place a
   * goal is made — and with both off it is empty, which is not a console at all.
   *
   * `initial` therefore falls back to the first AVAILABLE section rather than
   * to the hard-coded 'routines': a deep link to a gated section (the settings
   * destination rows, the palette, an old bookmark) must land somewhere real
   * instead of on a tab with no trigger in the rail, which Radix renders as an
   * empty plate.
   */
  const isOn = useExtensionPredicate();
  const sections = useMemo(() => consoleSectionsFor(isOn), [isOn]);
  const unavailable = sections.length === 0;
  const requested: ConsoleSection | null = isConsoleSection(section) ? section : null;
  const initial: ConsoleSection =
    (requested && sections.some((s) => s.id === requested) ? requested : sections[0]?.id) ??
    'routines';
  const [active, setActive] = useState<ConsoleSection>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);

  /**
   * Whether this section is CREATING — the detail pane holds the create form
   * rather than a selection (see CreateForm).
   *
   * Console-level rather than per-section for the same reason `selectedId` is:
   * a section change has to end it, and the footer bar has to be able to say so.
   * `focusNew` is an ARRIVAL that starts it — the caller asking to open straight
   * into "make one" — which is the job that prop was plumbed for and never had.
   */
  const [creating, setCreating] = useState(!!focusNew);

  /**
   * Reopening lands on what the CALLER asked for, not on wherever the last visit
   * ended — the console stays mounted between opens, so neither piece of state
   * resets on its own. Deliberately NOT a last-used-section memory: at monthly
   * frequency a remembered destination is a coin flip rather than a convenience,
   * and it makes the braindump door unlearnable.
   *
   * Adjusted during render rather than in an effect. This is React's documented
   * "adjusting state when a prop changes" pattern, and it is the correct one
   * here: an effect would paint one frame of the PREVIOUS section before
   * correcting itself, which on a deep link is a visible flash of the wrong
   * list. React re-runs this component immediately, before touching the DOM or
   * any child.
   */
  const request = `${open ? 'open' : 'shut'}:${initial}:${focusId ?? ''}`;
  const [lastRequest, setLastRequest] = useState(request);
  if (request !== lastRequest) {
    setLastRequest(request);
    if (open) {
      setActive(initial);
      setSelectedId(focusId ?? null);
      setCreating(!!focusNew);
    }
  }

  const { register, consume, Ladder } = useEscapeLadder();

  const onSectionChange = useCallback((next: string) => {
    if (!isConsoleSection(next)) return;
    setActive(next);
    // Selection is per-section and does not survive a switch: one shared id
    // would open whatever row happened to share an index, which reads as the
    // console losing its place.
    setSelectedId(null);
    // Nor does a half-written new one: arriving in Seasons still offering to
    // name a routine is the same lost-place bug wearing a form.
    setCreating(false);
  }, []);

  /**
   * A section change that KEEPS a selection, which `onSectionChange` deliberately
   * does not.
   *
   * Clearing the selection is right for the rail, where a section change means
   * "show me the projects" and carrying an id across would open whatever row
   * shared an index. Here the id is the entire point of the move: the routine
   * detail's reverse view is naming a specific season, and landing on the
   * Seasons list with nothing selected would make the user find it again.
   *
   * Not routed through `onValueChange` — that would clear the id on the way past.
   */
  const onNavigate = useCallback((next: ConsoleSection, id: string) => {
    setActive(next);
    setSelectedId(id);
    setCreating(false);
  }, []);

  /** Jump to a section from the Overview map. */
  const onOpenSection = useCallback((next: ConsoleSection) => {
    setActive(next);
    setSelectedId(null);
    setCreating(false);
  }, []);

  /** Jump to a section AND start making one — the Overview's "New". */
  const onCreateIn = useCallback((next: ConsoleSection) => {
    setActive(next);
    setSelectedId(null);
    setCreating(true);
  }, []);

  /**
   * Select a row — and leave the create form, which the selection replaces.
   *
   * NOT the raw setter. The form and the selection share the detail pane, and
   * `creating` wins there, so a plain `setSelectedId` while the form was open
   * looked like the click did nothing: the row latched, the pane went on showing
   * an empty form, and the only way out was a section change.
   */
  const onSelectRow = useCallback((id: string | null) => {
    setCreating(false);
    setSelectedId(id);
  }, []);

  /** Open the create form, which the selection would otherwise be covering. */
  const onNew = useCallback(() => {
    setSelectedId(null);
    setCreating(true);
  }, []);

  /**
   * A create landed: leave the form and select what was just made.
   *
   * One call rather than two so no section can do half of it — a create that
   * left the form open would offer to make a second thing before showing the
   * first, and one that skipped the selection would drop the user back on a
   * teaching line about the row they just created.
   */
  const onCreated = useCallback((id: string | null) => {
    setCreating(false);
    setSelectedId(id);
  }, []);

  /**
   * A console with no sections is not a console — so hand the dialog slot back
   * rather than rendering nothing into it.
   *
   * ui-store holds ONE activeDialog. Returning null while `open` is true would
   * leave that slot armed at a dialog nobody can see or Escape out of, and the
   * next ⌘K would be the only way to clear it.
   *
   * UNREACHABLE TODAY, AND KEPT ANYWAY. Trash declares `extension: null`
   * (console-rail.tsx), so `consoleSectionsFor` always returns at least one row
   * and this branch cannot fire — which is the point: the bin must never be
   * behind a switch. The guard stays because "every section is gated" is one
   * config edit away, and deleting the guard is how the blank-plate bug comes
   * back. It is covered by a test that mocks the section list empty rather than
   * by a toggle combination, because no toggle combination can produce it.
   */
  useEffect(() => {
    if (open && unavailable) onOpenChange(false);
  }, [open, unavailable, onOpenChange]);
  if (unavailable) return null;

  // A toggle can flip while the console is open, which would leave `active`
  // naming a section whose rail trigger has just gone — Radix renders that as a
  // blank plate. Resolved on read, so nothing has to be reset.
  const activeSection = sections.some((s) => s.id === active) ? active : initial;

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent
        showCloseButton={false}
        data-testid="organize-console"
        // Claims the bare-key space. Console list rows are <button>s, so without
        // this every single-letter global still fires from a focused row — `n`
        // would open the add dialog and replace this console in the single
        // ActiveDialog slot. See hooks/use-command-shortcuts.ts.
        data-keys-local="true"
        onKeyDown={focusFilterOnSlash}
        // Radix decides on Escape from a CAPTURE listener on the document, so
        // this prop is the only place a rung can get in front of it. See
        // escape-ladder.tsx.
        onEscapeKeyDown={(event) => {
          if (consume()) event.preventDefault();
        }}
        className={cn(
          // The stock DialogContent base is `grid gap-4 rounded-lg border p-6
          // shadow-lg duration-200 zoom-95 max-w-[calc(100%-2rem)] sm:max-w-lg`
          // and every one of those fights a number below. zoom-95 on a 1082px
          // plate is a 54px lurch.
          'flex flex-col gap-0 overflow-hidden p-0',
          'w-[min(1082px,calc(100vw-64px))] max-w-none sm:max-w-none',
          'h-[min(820px,calc(100vh-80px))]',
          'bg-modal border-border rounded-[20px] border',
          'shadow-[var(--shadow-elev-plate)]',
          'duration-150 data-[state=open]:zoom-in-[0.98] data-[state=closed]:zoom-out-[0.98]'
        )}
      >
        <ResponsiveModalHeader className="border-border h-12 shrink-0 flex-row items-center gap-0 space-y-0 border-b px-4">
          <ResponsiveModalTitle className="text-foreground flex-1 text-base leading-5 font-semibold">
            Organize
          </ResponsiveModalTitle>
          <ResponsiveModalDescription className="sr-only">
            Your routines, seasons, projects and item types, plus anything
            you&apos;ve deleted in the last 30 days.
          </ResponsiveModalDescription>
          {/* Ours, on the header band's baseline, rather than the stock close
              floating over the rail. */}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            data-testid="organize-close"
            className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-ring flex h-6 w-6 items-center justify-center rounded-[5px] focus-visible:outline-1 focus-visible:outline-solid"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </ResponsiveModalHeader>

        {/* Keyed on the incoming section so a second open with a different one
            actually lands there — Radix `defaultValue` only applies once, and
            this console stays mounted. The manage-categories precedent. */}
        <Ladder value={register}>
        <TabsPrimitive.Root
          key={initial}
          value={activeSection}
          onValueChange={onSectionChange}
          orientation="vertical"
          className="flex min-h-0 flex-1"
        >
          <ConsoleRail sections={sections} />

          {sections.map((s) => (
            <TabsPrimitive.Content
              key={s.id}
              value={s.id}
              // A tabpanel that is the flex row itself, so the list and detail
              // columns are its children rather than nested one level deeper.
              // min-w-0: a flex item's floor is otherwise its content's
              // min-content width, and one wide row in the detail pane then
              // widened the whole panel past the plate, clipping the pane's
              // right edge (its buttons, toggles and pills) under overflow-hidden.
              className="flex min-h-0 min-w-0 flex-1 data-[state=inactive]:hidden"
            >
              <SectionBody
                section={s.id}
                selectedId={selectedId}
                onSelect={onSelectRow}
                onNavigate={onNavigate}
                creating={creating && s.id === activeSection}
                onNew={onNew}
                onCreated={onCreated}
                sections={sections}
                onOpenSection={onOpenSection}
                onCreateIn={onCreateIn}
              />
            </TabsPrimitive.Content>
          ))}
        </TabsPrimitive.Root>
        </Ladder>

        <FooterBar section={activeSection} selectedId={selectedId} creating={creating} />
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

/**
 * `/` and ⌘F put the cursor in the current section's filter.
 *
 * Scoped to `[data-state="active"]`. Radix does not mount an inactive panel's
 * children, so there is only ever one filter field in the document today — but
 * the scope costs nothing and is what keeps this correct if a later change adds
 * `forceMount` to preserve section scroll. See escape-ladder.tsx.
 *
 * `/` is claimed only when the press is NOT already in a text field. Without
 * that guard, typing a slash into the filter — or into any name input on the
 * plate — would silently jump the cursor somewhere else instead of typing.
 * ⌘F takes the browser's find bar, which is the right trade inside a console
 * whose whole job is finding one of thirty objects.
 */
function focusFilterOnSlash(event: React.KeyboardEvent<HTMLDivElement>) {
  const slash = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey;
  const find = event.key.toLowerCase() === 'f' && (event.metaKey || event.ctrlKey);
  if (!slash && !find) return;

  const target = event.target as HTMLElement | null;
  const typing =
    !!target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable);
  if (slash && typing) return;

  const field = event.currentTarget.querySelector<HTMLInputElement>(
    '[data-state="active"] [data-organize-filter]'
  );
  if (!field) return;
  event.preventDefault();
  field.focus();
  field.select();
}

/**
 * One section's list + detail pair.
 *
 * Each section owns both columns rather than being handed slots, because what
 * goes in the detail is entirely section-specific and a slot API would just be
 * two props threading the same state back out again. The shared geometry lives
 * in ListColumn / DetailColumn so no section can drift.
 */
function SectionBody({
  section,
  selectedId,
  onSelect,
  onNavigate,
  creating,
  onNew,
  onCreated,
  sections,
  onOpenSection,
  onCreateIn,
}: {
  section: ConsoleSection;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Jump to another section AND select something in it. See SeasonHolders. */
  onNavigate: (section: ConsoleSection, id: string) => void;
  /** The detail pane is holding this section's create form. */
  creating: boolean;
  onNew: () => void;
  /** Leave the form and select what was made — one call, so it cannot half-happen. */
  onCreated: (id: string | null) => void;
  /** Gate-filtered list, for the Overview's cards. */
  sections: readonly ConsoleSectionSpec[];
  onOpenSection: (section: ConsoleSection) => void;
  onCreateIn: (section: ConsoleSection) => void;
}) {
  if (section === 'overview') {
    return (
      <OverviewSection sections={sections} onOpen={onOpenSection} onCreate={onCreateIn} />
    );
  }

  const make = { creating, onNew, onCreated };
  if (section === 'routines') {
    return (
      <RoutinesSection
        selectedId={selectedId}
        onSelect={onSelect}
        onOpenSeason={(id) => onNavigate('seasons', id)}
        {...make}
      />
    );
  }
  if (section === 'seasons') {
    return <SeasonsSection selectedId={selectedId} onSelect={onSelect} {...make} />;
  }
  if (section === 'goals') {
    return <GoalsSection selectedId={selectedId} onSelect={onSelect} {...make} />;
  }
  if (section === 'projects') {
    return <ProjectsSection selectedId={selectedId} onSelect={onSelect} {...make} />;
  }
  if (section === 'types') {
    return <TypesSection selectedId={selectedId} onSelect={onSelect} {...make} />;
  }

  // Trash selects like the rest now — a row opens a read-only preview in the
  // detail pane — but Enter on a row still Restores. See trash.tsx.
  return <TrashSection selectedId={selectedId} onSelect={onSelect} />;
}

/**
 * The teaching surface that makes the second visit feel like the tenth.
 *
 * Desktop only, three entries, not five: at monthly frequency this is not a
 * power-user ledger. It is present in the empty state too, so the keyboard flow
 * never dead-ends.
 */
function FooterBar({
  section,
  selectedId,
  creating,
}: {
  section: ConsoleSection;
  selectedId: string | null;
  creating: boolean;
}) {
  const meta = sectionMeta(section);
  return (
    <div className="border-border text-muted-foreground font-num hidden h-8 shrink-0 items-center gap-4 border-t px-4 text-2xs md:flex">
      <span data-testid="organize-footer-subject">
        {creating
          ? `${meta.label} · new`
          : selectedId
            ? meta.label
            : `${meta.label} · nothing selected`}
      </span>
      {/* Only where there is a field for it to land in. The Overview is a map,
          not a list, so `/` there would teach a key that does nothing. */}
      {meta.filterable && (
        <span className="ml-auto flex items-center" data-testid="organize-footer-filter">
          Filter
          <KeyCap>/</KeyCap>
        </span>
      )}
      <span className={cn('flex items-center', !meta.filterable && 'ml-auto')}>
        Close
        <KeyCap>Esc</KeyCap>
      </span>
    </div>
  );
}
