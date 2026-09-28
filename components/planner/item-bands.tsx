'use client';

import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { useGoalsEnabled, useOrganizeEnabled } from '@/lib/extension-gates';
import { classifyKindForItemType } from '@/lib/container-registry';
import { getItemTypeConfig, isCollectible, itemTypeName } from '@/lib/item-registry';
import { goalItemIds, isGoalActive } from '@/lib/goals';
import { accentColorForName } from '@/lib/accent-colors';
import {
  bandTestId,
  visibleContainerBands,
  type ContainerBand,
} from '@/lib/item-bands';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * item-bands.tsx — the band as a thing you can see, on both surfaces.
 *
 * lib/item-bands.ts decides WHICH bands exist and in what order; this file is
 * what one looks like, and it is shared by the edit panel (where a band's
 * content is a live picker) and by /item/[id] (where it is a readout that can
 * open the editor). One row, one noun, one line of height — a label column on
 * the left and whatever the surface puts on the right.
 *
 * The label vocabulary is deliberately the SAME micro-label the detail sections
 * already use for Subtasks, Activity, History and Thread: those sections were
 * bands before the word existed, and the chips above them were the only part of
 * the surface still rendering as an unlabelled heap. Making them one component
 * is what lets the whole surface read as one grammar rather than two.
 */

export function BandLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        'text-muted-foreground text-[10px] font-semibold tracking-wider uppercase',
        className
      )}
    >
      {children}
    </p>
  );
}

/**
 * One band: the noun on the left, its controls on the right.
 *
 * `leading-7` on the label, not a padding: 28px is the chip height, so the
 * label's own line box centres it against the first row of chips and STAYS on
 * that first row when they wrap. A padding would have to be re-tuned every time
 * the chip height moved.
 *
 * The label column is a fixed 4rem so every band's controls share a left edge —
 * a ragged one is what makes a stack of short rows read as debris. Labels come
 * from the registry and are one word today; a longer one wraps rather than
 * truncating, because a clipped noun is worse than a taller row.
 *
 * NOT a `<label htmlFor>`, and PropertyChip does support one (`id`). A band may
 * hold several controls — When holds up to five — so an association could only
 * ever be right for the single-control bands, and a rule that holds for some
 * rows is worse than none. Each control carries its own `ariaLabel` with the
 * noun in it instead, which is the same information without the arbitrary half.
 */
export function ItemBand({
  label,
  testId,
  children,
  className,
}: {
  label: string;
  testId?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start gap-2', className)} data-testid={testId}>
      <BandLabel className="w-16 shrink-0 leading-7">{label}</BandLabel>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/**
 * The stack of bands.
 *
 * `gap-2` (8px) between rows against `gap-1.5` (6px) between chips INSIDE a row:
 * a band that wraps has to stay one row to the eye, so the separation between
 * bands must not be tighter than the separation within one. The label column is
 * what carries the rest of the hierarchy.
 */
export function ItemBandGroup({
  children,
  className,
  testId = 'item-bands',
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * What an EMPTY band offers on a read-only surface.
 *
 * The empty-band rule says a band with nothing in it still renders — so this is
 * the thing it renders, and the one requirement it has is that it must not read
 * as a broken or half-loaded row. So it is not a dimmed placeholder and not an
 * em-dash: it is the app's existing dashed-affordance vocabulary (the same
 * recipe as "Assign to Beacon" in the detail sections and as PropertyChip's own
 * unset state), carrying a plus and a verb. Dashed says "nothing here yet",
 * the plus and the word say "and you may".
 *
 * The visible word is the verb alone, because the band's label two inches to
 * its left is already the noun. The ACCESSIBLE name is the noun, so a control
 * read out of its row still says which band it belongs to.
 */
export function BandAddButton({
  label,
  onClick,
  testId,
}: {
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-label={label}
      className={cn(
        'border-input text-muted-foreground hover-wash inline-flex h-7 items-center gap-1.5',
        'rounded-sm border border-dashed px-2.5 text-xs transition-colors',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
      )}
    >
      <Plus className="size-3 shrink-0" aria-hidden />
      Add
    </button>
  );
}

/**
 * A fact, not a control — the readout vocabulary the /item/[id] page already
 * used for its chips, moved here so the page and the bands share one.
 */
export function BandChip({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className="bg-secondary text-foreground inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs"
    >
      {children}
    </span>
  );
}

/** The identity mark: a square names a thing, a dot names a value. */
export function BandSquare({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn('inline-block size-[9px] shrink-0 rounded-[3px]', className)}
      style={{ background: color }}
      aria-hidden
    />
  );
}

/** One container this item belongs to, flattened for display. */
export interface BandMembership {
  key: string;
  name: string;
  color?: string;
}

export interface ResolvedBand {
  band: ContainerBand;
  memberships: BandMembership[];
}

/**
 * The bands for one item, with their memberships resolved — the READ side.
 *
 * Read-only on purpose. The edit panel does not use this: its bands write, and
 * membership writes take two different paths (a draft in add mode, a live join
 * through the store in edit mode) that a read hook has no business knowing
 * about. What both surfaces DO share is the question of which bands exist, and
 * that is `visibleContainerBands` underneath both.
 *
 * Goals are filtered to the ACTIVE ones, matching the chip: a goal you have
 * achieved or set aside stops claiming the item's row. (The editor's own
 * popover still lists ended goals under a divider, which is where un-joining
 * one belongs — it is an explanation, not a membership.)
 */
export function useItemBands(item: Item): ResolvedBand[] {
  const projects = usePlannerStore((s) => s.projects);
  const getProjectColor = usePlannerStore((s) => s.getProjectColor);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const goals = usePlannerStore((s) => s.goals);
  const collectionsAvailable = usePlannerStore((s) => s.collectionsAvailable);
  const goalsAvailable = usePlannerStore((s) => s.goalsAvailable);
  const goalsEnabled = useGoalsEnabled();
  const organizeEnabled = useOrganizeEnabled();

  const config = getItemTypeConfig(itemTypeName(item));
  const bands = visibleContainerBands({
    classifyKind: classifyKindForItemType(config.containerKind),
    collectible: isCollectible(item),
    collectionsAvailable,
    goalsAvailable,
    goalsEnabled,
    organizeEnabled,
    counts: {
      project: projects.length,
      routine: routines.length,
      season: seasons.length,
      goal: goals.length,
    },
  });

  return bands.map((band) => {
    switch (band.kind) {
      case 'project': {
        const name = item.project;
        return {
          band,
          memberships: name
            ? [{ key: name, name, color: getProjectColor(name) }]
            : [],
        };
      }
      case 'routine':
        return {
          band,
          memberships: routines
            .filter((r) => r.itemIds.includes(item.id))
            .map((r) => ({
              key: r.id,
              name: r.name,
              color: r.color ?? accentColorForName(r.name),
            })),
        };
      case 'season':
        return {
          band,
          memberships: seasons
            .filter((p) => p.itemIds.includes(item.id))
            .map((p) => ({
              key: p.id,
              name: p.name,
              color: p.color ?? accentColorForName(p.name),
            })),
        };
      case 'goal':
        return {
          band,
          memberships: goals
            .filter((g) => isGoalActive(g) && goalItemIds(g).includes(item.id))
            .map((g) => ({
              key: g.id,
              name: g.name,
              color: g.color ?? accentColorForName(g.name),
            })),
        };
    }
  });
}

/**
 * The container bands as a READOUT — /item/[id]'s half of the grammar.
 *
 * Same bands, same order, same nouns as the edit panel; what differs is that a
 * membership is a fact here rather than a picker, because the page is a place
 * you navigated to rather than a control you opened. Before this the page
 * showed a project and nothing else: an item could sit in three routines, a
 * season and two goals and its own page would not say so.
 *
 * An empty band still renders, and its affordance opens the editor rather than
 * inventing a second write path. That is what keeps this a readout: every
 * change to a membership still happens in exactly one place.
 */
export function ContainerBandsReadout({
  item,
  onAdd,
}: {
  item: Item;
  onAdd: (band: ContainerBand) => void;
}) {
  const bands = useItemBands(item);
  if (bands.length === 0) return null;
  return (
    <>
      {bands.map(({ band, memberships }) => (
        <ItemBand key={band.kind} label={band.label} testId={bandTestId(band.kind)}>
          {memberships.length === 0 ? (
            <BandAddButton
              label={band.label}
              onClick={() => onAdd(band)}
              testId={`band-add-${band.kind}`}
            />
          ) : (
            memberships.map((m) => (
              <BandChip key={m.key}>
                {m.color && <BandSquare color={m.color} />}
                <span className="truncate">{m.name}</span>
              </BandChip>
            ))
          )}
        </ItemBand>
      ))}
    </>
  );
}
