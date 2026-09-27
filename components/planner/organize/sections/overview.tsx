'use client';

import { Plus } from 'lucide-react';
import { usePlannerStore } from '@/lib/planner-store';
import { cn } from '@/lib/utils';
import { CONSOLE_SECTIONS, SECTION_IDENTITY, type ConsoleSection, type ConsoleSectionSpec } from '../console-rail';

/**
 * OVERVIEW — the console's front door.
 *
 * The plate used to open on Routines, which is a fine section and a poor
 * greeting: a first-time arrival met a list of one kind of thing with no word
 * about the other five. This is the map — every available section, what you have
 * of it, one line on what it is for, and a way to make another.
 *
 * It takes the WHOLE body rather than the list+detail pair. There is nothing to
 * select here and nothing to detail; a 300px column of six rows beside an empty
 * pane would be the layout arguing with its own content. Trash proved a section
 * may use the space its own way (it takes no selection); this one goes further
 * and takes no columns.
 *
 * CALM, deliberately: hairlines between rows rather than six bordered cards, a
 * SHORT phrase rather than each section's full definition — the definitions live
 * in the sections themselves, where they are the empty state and the create
 * form's hint, and repeating them here would be the same six paragraphs twice.
 *
 * The trash row carries NO COUNT, and that is the bin's law rather than an
 * oversight: trashed rows never enter the store (see sections/trash.tsx), so a
 * count here would mean a fetch on every console open to answer a question
 * nobody asked.
 */
export function OverviewSection({
  sections,
  onOpen,
  onCreate,
}: {
  /** The sections this account can actually see — already gate-filtered. */
  sections: readonly ConsoleSectionSpec[];
  onOpen: (section: ConsoleSection) => void;
  /** Open that section AND start making one. */
  onCreate: (section: ConsoleSection) => void;
}) {
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const goals = usePlannerStore((s) => s.goals);
  const projects = usePlannerStore((s) => s.projects);
  const itemTypes = usePlannerStore((s) => s.itemTypes);
  const collectionsAvailable = usePlannerStore((s) => s.collectionsAvailable);
  const goalsAvailable = usePlannerStore((s) => s.goalsAvailable);
  const itemTypesAvailable = usePlannerStore((s) => s.itemTypesAvailable);
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);

  const counts: Partial<Record<ConsoleSection, number>> = {
    routines: routines.length,
    seasons: seasons.length,
    goals: goals.length,
    projects: projects.length,
    types: itemTypes.length,
  };

  /**
   * Whether that section would actually accept a create — the SAME three-part
   * signal each section computes for itself (its table is reachable, we know
   * who we are, the first fetch has landed).
   *
   * Asked properly rather than inferred from "does it have a count". A card
   * offering "New" for a section whose form will not render sends the user to a
   * pane that says nothing, with the footer claiming they are making something.
   */
  const ready = !!userId && !isLoading;
  const canCreate: Partial<Record<ConsoleSection, boolean>> = {
    routines: collectionsAvailable && ready,
    seasons: collectionsAvailable && ready,
    goals: goalsAvailable && ready,
    projects: ready,
    types: itemTypesAvailable && ready,
  };

  // Everything but the map itself. Trash keeps its place at the end, where the
  // rail also puts it.
  const cards = sections.filter((s) => s.id !== 'overview');

  return (
    <div className="min-w-0 flex-1 overflow-y-auto" data-testid="organize-overview">
      <div className="px-7 pt-6 pb-1">
        <h3 className="text-foreground text-base font-semibold">Your structure</h3>
        <p className="text-muted-foreground mt-1 max-w-[52ch] text-xs">
          Containers switch work on and off. Labels name it. All of it is optional — items live
          happily without any of it.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-x-7 px-6 pb-6 md:grid-cols-2">
        {cards.map((section, i) => {
          const Icon = SECTION_IDENTITY[section.id].icon;
          const count = counts[section.id];
          const creatable = canCreate[section.id] === true;
          return (
            <div
              key={section.id}
              // Hairline between rows, never a box. In ONE column every card but
              // the first carries a rule; in two, the first card of each column
              // drops it so the grid reads as two lists rather than a table.
              className={cn(
                i > 0 && 'border-border border-t',
                i === 1 && 'md:border-t-0'
              )}
            >
              <div className="flex items-start gap-3 py-3.5">
                <button
                  type="button"
                  onClick={() => onOpen(section.id)}
                  data-testid="overview-card"
                  data-section={section.id}
                  className="focus-visible:outline-ring -m-1 flex min-w-0 flex-1 items-start gap-3 rounded-[7px] p-1 text-left focus-visible:outline-1 focus-visible:outline-solid"
                >
                  <span
                    className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-[8px]"
                    style={{ color: SECTION_IDENTITY[section.id].accent }}
                  >
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="text-foreground truncate text-[13px] font-semibold">
                        {section.label}
                      </span>
                      {count !== undefined && (
                        <span className="text-muted-foreground font-num text-2xs">{count}</span>
                      )}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-[11.5px]">
                      {section.blurb}
                    </span>
                  </span>
                </button>
              </div>

              {creatable && (
                <button
                  type="button"
                  onClick={() => onCreate(section.id)}
                  data-testid="overview-new"
                  data-section={section.id}
                  aria-label={`New ${section.label.replace(/s$/, '').toLowerCase()}`}
                  className="text-success-text hover:bg-accent focus-visible:outline-ring -mt-2 mb-3 ml-10 flex h-[22px] items-center gap-1 rounded-[5px] px-1.5 text-[11px] font-medium focus-visible:outline-1 focus-visible:outline-solid"
                >
                  <Plus className="size-3" />
                  New
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Which sections the Overview itself lists — everything gate-available but the map. */
export const OVERVIEW_CARD_IDS = CONSOLE_SECTIONS.filter((s) => s.id !== 'overview').map(
  (s) => s.id
);
