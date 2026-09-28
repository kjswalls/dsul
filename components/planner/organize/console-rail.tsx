'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import {
  CalendarRange,
  Folder,
  LayoutGrid,
  type LucideIcon,
  Repeat,
  Shapes,
  Target,
  Trash2,
} from 'lucide-react';
import { Eyebrow } from './primitives';
import { EXT_GOALS, EXT_ORGANIZE } from '@/lib/extension-registry';
import { cn } from '@/lib/utils';
import { CONTAINER_KINDS } from '@/lib/container-registry';

/**
 * The Organize console's navigation: a grouped VERTICAL rail, never a tab strip.
 *
 * Built on `TabsPrimitive.Root orientation="vertical"` and that choice is load
 * bearing rather than convenient — it is what keeps
 * `getByRole('tab', { name: 'Routines' })` resolving, which
 * `tests/e2e/seasons.spec.ts` drives the manager with. Phase 2's
 * acceptance criterion is that that spec runs
 * UNCHANGED. It also gives roving tabindex and ↑/↓ traversal for free, and
 * `key={section}` remains the remount trick that makes a second open on a
 * different section actually land there.
 *
 * Proven before it was built: `tests/unit/organize-rail.test.tsx`.
 *
 * IMPORTED FROM THE PRIMITIVE, NOT `components/ui/tabs.tsx`. The wrapper's
 * TabsList is `bg-muted inline-flex h-9 w-fit rounded-lg p-[3px]` with `flex-1`
 * triggers — precisely the full-width segmented strip this design exists to get
 * away from, and every one of those classes would have to be nulled anyway.
 */

export type ConsoleSection =
  | 'overview'
  | 'routines'
  | 'seasons'
  | 'goals'
  | 'projects'
  | 'types'
  | 'trash';

/**
 * EVERY SECTION NAMES THE EXTENSION IT RIDES — or names none, which is a third
 * answer rather than a missing one.
 *
 * Five of the seven ride the console itself. The other two are the whole reason
 * this is a field instead of a branch in the rail:
 *
 *   GOALS rides EXT_GOALS. This is where a goal is CREATED, so if it rode the
 *     console then switching Goals on with the console off would buy a filter,
 *     a grouping and a page for goals you have no way to make.
 *
 *   TRASH rides NOTHING — `extension: null`, ungatable by construction. It is
 *     the only way back out of a delete (see sections/trash.tsx), and DELETION
 *     IS NOT GATED: items, projects, routines, seasons, habit groups and goals
 *     all still delete freely with the console off. Gating only the recovery
 *     half means the app's DEFAULT configuration — both extensions off, which
 *     is what every new account gets — can destroy work with no cross-session
 *     route back. ⌘Z is session-scoped and fifty deep; it is not the answer.
 *     Gating the bin because of the room it happens to stand in is gating by
 *     HOUSING rather than by MEANING, which is the exact mistake "The Weight of
 *     dsul" exists to correct — and the rail already says so, pinning trash
 *     below a rule as a lifecycle surface rather than a peer of either group.
 *
 * So with both extensions off the console still opens, holding one row: Trash.
 * That is the same shape as the Goals-only case, and both are pinned in
 * tests/unit/extension-gates-organize.test.tsx.
 *
 * Declaring it per-section is the registry bargain the rest of the app makes
 * (lib/item-registry.ts, lib/container-registry.ts): the next gated section is
 * a field, not a code path.
 */
export const CONSOLE_SECTIONS = [
  // The map, and the console's front door when no caller asked for a section.
  // It rides EXT_ORGANIZE like the rest of the console's own furniture: with the
  // console switched off, a Goals-only plate should open on Goals, not on an
  // overview of one thing.
  {
    id: 'overview', label: 'Overview', group: null, eyebrow: 'OVERVIEW',
    blurb: 'What you have, and where to make more.', extension: EXT_ORGANIZE,
    // The one section that is not a list + detail pair, so the one with nothing
    // to filter. It is a map of six cards, all on screen at once.
    filterable: false,
  },
  { id: 'routines', label: 'Routines', group: 'CONTAINERS', eyebrow: 'ROUTINES',
    blurb: 'Pause a stack of items together.', extension: EXT_ORGANIZE, filterable: true },
  { id: 'seasons', label: 'Seasons', group: null, eyebrow: 'SEASONS',
    blurb: 'A stretch of life that switches routines on.', extension: EXT_ORGANIZE,
    filterable: true },
  // Third in CONTAINERS, and last of the three on purpose: routines and
  // seasons answer "is this on today", goals answer "why is any of it here".
  // The daily questions sit above the long one.
  { id: 'goals', label: 'Goals', group: null, eyebrow: 'GOALS',
    blurb: 'Why the work matters.', extension: EXT_GOALS, filterable: true },
  // The whole CLASSIFY axis in one row since migration 039. 'Habit groups' sat
  // below 'Item types' until then (Kirby, 2026-08-11 decision 7); the fold that
  // ordering was making cheap is this one, and it went to projects rather than
  // to routines — a habit group described what a habit is ABOUT, which is what
  // a project is, not when it counts.
  //
  // The section ID is NOT the noun. `CONTAINER_KINDS.project.label` is, and it
  // supplies both strings below.
  { id: 'projects', label: CONTAINER_KINDS.project.labelPlural, group: 'LABELS',
    eyebrow: CONTAINER_KINDS.project.labelPlural.toUpperCase(),
    blurb: 'File your tasks; carry a repeating block.', extension: EXT_ORGANIZE,
    filterable: true },
  { id: 'types', label: 'Item types', group: null, eyebrow: 'ITEM TYPES',
    blurb: 'Your own kinds of task.', extension: EXT_ORGANIZE, filterable: true },
  // Behind a rule, pinned to the foot, the way a bin is pinned to the foot of a
  // dock. Trash is a lifecycle surface, not a peer of either group — and
  // `extension: null` is that same sentence said to the gate. See the header.
  { id: 'trash', label: 'Trash', group: 'RULE', eyebrow: 'TRASH',
    blurb: 'Anything deleted, kept 30 days.', extension: null, filterable: true },
] as const satisfies readonly {
  id: ConsoleSection;
  label: string;
  group: string | null;
  eyebrow: string;
  /** One short line for the Overview card — never the full definition. */
  blurb: string;
  /** The slug this section rides, or `null` for one that may never be gated. */
  extension: string | null;
  /**
   * Whether this section renders a filter field — which is to say, whether the
   * footer's `/` hint is telling the truth here.
   *
   * A field rather than an `id === 'overview'` test, for the same reason the
   * gate above is: the footer bar is the console's teaching surface, and a hint
   * that over-promises on one section is the failure this repo already named
   * once ("the footer bar teaches `/`, so leaving it unbuilt shipped a promise
   * the plate did not keep"). The next section that is a map rather than a list
   * should not have to remember to edit a boolean expression in another file.
   */
  filterable: boolean;
}[];

export type ConsoleSectionSpec = (typeof CONSOLE_SECTIONS)[number];

/**
 * One fixed glyph and one accent per section — the console's warmth vocabulary.
 *
 * FIXED, not the user's stored container icons: a section is a KIND, and its
 * mark should be the same for everyone (a routine is a Repeat, a goal a Target),
 * the way the braindump and the extension catalog already give kinds a stable
 * glyph. The rail then reads as part of the app rather than its admin page.
 *
 * The colour is spent in exactly two ≤14px-or-thinner places, never as a fill:
 * the 2px tick on the active rail row (below) and the rail icon (added with the
 * icon rail). The larger detail-pane welcome glyph stays NEUTRAL, like every
 * other big glyph in the console — colour rides the small marks only.
 *
 * Trash gets no accent (a lifecycle surface is not a kind of work) and a muted
 * glyph, keeping its "pinned below a rule, not a peer" reading.
 */
export const SECTION_IDENTITY: Record<
  ConsoleSection,
  { icon: LucideIcon; accent: string }
> = {
  // Neutral: the map is not a kind of work, so it takes the ink the rail's
  // resting rows already use rather than a sixth hue.
  overview: { icon: LayoutGrid, accent: 'var(--muted-foreground)' },
  routines: { icon: Repeat, accent: 'var(--accent-2)' },
  seasons: { icon: CalendarRange, accent: 'var(--accent-3)' },
  goals: { icon: Target, accent: 'var(--accent-6)' },
  projects: { icon: Folder, accent: 'var(--accent-1)' },
  types: { icon: Shapes, accent: 'var(--accent-4)' },
  trash: { icon: Trash2, accent: 'var(--muted-foreground)' },
};

/**
 * The sections an account may actually see, given a per-slug predicate.
 *
 * Pure and store-free so the four on/off combinations are one table in a unit
 * test rather than four renders. Order is CONSOLE_SECTIONS' order, so a gated
 * console reads as the full one with rows removed — the rail never reshuffles.
 *
 * A `null` extension is kept unconditionally and is never passed to `isOn` —
 * the predicate is never asked a question about a section that has no switch.
 */
export function consoleSectionsFor(
  isOn: (slug: string) => boolean
): readonly ConsoleSectionSpec[] {
  return CONSOLE_SECTIONS.filter(
    (section) => section.extension === null || isOn(section.extension)
  );
}

/**
 * Which extension one section rides — for the callers that hold a section id
 * and need the SLUG rather than the row (the settings destinations, which
 * redirect to an extension's own pane rather than opening a console that will
 * immediately close).
 *
 * THREE ANSWERS, and the caller has to tell two of them apart:
 *   a slug   — this section rides that extension.
 *   `null`   — a KNOWN section that may never be gated (trash). The caller
 *              proceeds; there is no switch to send anyone to.
 *   fallback — an id the rail does not have (a stale bookmark, a typo'd deep
 *              link) answers EXT_ORGANIZE, the console's own switch, which is
 *              the safe default for anything that claims to be a console
 *              section and is not.
 */
export function consoleSectionExtension(id: string | undefined): string | null {
  const section = CONSOLE_SECTIONS.find((s) => s.id === id);
  return section ? section.extension : EXT_ORGANIZE;
}

export function sectionMeta(id: ConsoleSection) {
  return CONSOLE_SECTIONS.find((s) => s.id === id) ?? CONSOLE_SECTIONS[0];
}

export function isConsoleSection(value: string | undefined): value is ConsoleSection {
  return !!value && CONSOLE_SECTIONS.some((s) => s.id === value);
}

/**
 * The rail itself. Rendered as the TabsList so Radix owns the roving focus;
 * group eyebrows and the Trash rule are wrapped in `role="presentation"` so the
 * tablist's children are all tabs and RovingFocusGroup steps over them.
 */
export function ConsoleRail({ sections }: { sections: readonly ConsoleSectionSpec[] }) {
  return (
    <TabsPrimitive.List
      aria-label="Sections"
      data-testid="console-rail"
      className="border-border flex w-[180px] shrink-0 flex-col overflow-y-auto border-r p-2"
    >
      {sections.map((section) => (
        <RailEntry key={section.id} section={section} />
      ))}
    </TabsPrimitive.List>
  );
}

function RailEntry({ section }: { section: ConsoleSectionSpec }) {
  const Icon = SECTION_IDENTITY[section.id].icon;
  return (
    <>
      {section.group === 'RULE' ? (
        // mt-auto pins everything from here down to the foot. The margin
        // longhand wins over the rule's own shorthand because it is declared
        // after it in the class list and tailwind-merge keeps both.
        <div role="presentation" className="bg-border mx-[7px] my-2 mt-auto h-px" />
      ) : section.group ? (
        <div role="presentation" className="mt-3 flex h-[22px] items-center px-[7px] first:mt-0">
          <Eyebrow>{section.group}</Eyebrow>
        </div>
      ) : null}

      <TabsPrimitive.Trigger
        value={section.id}
        data-testid="console-rail-row"
        data-section={section.id}
        // The accent for the active tick, per section. A CSS var rather than an
        // inline `before` colour because the pseudo-element cannot read a prop —
        // and a var keeps the whole mark in the class list where the cascade is
        // legible.
        style={{ '--tick': SECTION_IDENTITY[section.id].accent } as React.CSSProperties}
        className={cn(
          // One size up (30→36px row, 16px glyph, 13px label): the rail reads
          // like the Overview's index rather than a dense nav strip, and the
          // extra height holds the coloured glyph without crowding.
          'group relative flex h-[36px] w-full items-center gap-2.5 rounded-[7px] px-[9px] text-left text-[13px] font-medium',
          'text-muted-foreground hover:bg-accent hover:text-foreground',
          // Counts still never live here — they reflow as data loads and would
          // JOIN THE TAB'S ACCESSIBLE NAME, making the e2e role queries depend
          // silently on Playwright's substring matching. Counts live on the list
          // head and the detail meta line.
          'data-[state=active]:bg-[var(--row-selected)] data-[state=active]:text-foreground',
          // A 2px accent tick on the active row, the same mark a modified
          // setting wears — centred in the row, the section's hue. Paired with
          // the glyph going colour on the active row (below).
          'before:absolute before:top-[8px] before:bottom-[8px] before:left-0 before:w-[2px] before:rounded-full before:bg-transparent',
          'data-[state=active]:before:bg-[var(--tick)]',
          'focus-visible:outline-ring focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-solid'
        )}
      >
        {/* The section's fixed silhouette. GREY at rest, its section hue ONLY on
            the active row — colour rides one row at a time, never the whole
            column, so the rail warms up without becoming a legend. distinct
            shapes answer the old "near-identical grey glyphs" ban. aria-hidden so
            the tab's accessible name stays exactly its label ("Routines"), which
            the e2e role queries and organize-rail.test.tsx's toHaveAccessibleName
            both require. */}
        <Icon
          className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground group-data-[state=active]:text-[var(--tick)]"
          aria-hidden
        />
        {section.label}
      </TabsPrimitive.Trigger>
    </>
  );
}
