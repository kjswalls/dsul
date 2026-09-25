'use client';

import { createElement, type ComponentProps, type ReactNode } from 'react';
import { Check, Plus } from 'lucide-react';
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalHeader,
} from '@/components/ui/responsive-modal';
import { ChipOption, ChipSectionLabel } from '@/components/primitives/property-chip';
import { SECTION_IDENTITY } from '@/components/planner/organize/console-rail';
import { usePlannerStore } from '@/lib/planner-store';
import { useGoalsEnabled, useOrganizeEnabled } from '@/lib/extension-gates';
import { useOpenConsole } from '@/lib/console-door';
import { ALL_ITEM_TYPES, getItemTypeConfig } from '@/lib/item-registry';
import { CONTAINER_KINDS } from '@/lib/container-registry';
import type { NewContainerKind } from '@/lib/ui-store';

/**
 * The "new" surface's shell, shared by the two dialogs that wear it: ItemDialog
 * (items, add and edit) and ContainerDialog (organizers, add only). Moved here
 * rather than copied when organizers joined the "new" dialog (2026-09-25) —
 * the two must read as ONE dialog whose body swaps, so the wrapper, the add
 * modal's geometry, the serif fields, the ↵ hint and the type menu each live
 * once.
 */

/**
 * Identity mark for a type or container — the mockup's 9px color square, as
 * opposed to the round dot that marks a *value* (priority). Same vocabulary as
 * PropertyChip's swatchShape="square".
 */
export function ColorSquare({ color }: { color: string }) {
  return (
    <span
      className="size-[9px] shrink-0 rounded-[3px]"
      style={{ background: color }}
      aria-hidden
    />
  );
}


// ── The two shapes of the surface ────────────────────────────────────────────
// Same children either way. `modal` is the Radix dialog (desktop) / vaul drawer
// (mobile); `panel` is a bare <aside> the shell lays out BESIDE the canvas — no
// portal, no overlay, no focus trap, no scroll lock, so the app stays workable
// behind it. Splitting at the wrapper rather than forking the body is what keeps
// "growth is a presentation, not a fork" true (memory/plans/item-surface-growth.md).

export function SurfaceRoot({
  panel,
  open,
  onOpenChange,
  isMobile,
  children,
}: {
  panel: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Settled in the permanent wrapper — this tree mounts fresh per open. */
  isMobile: boolean;
  children: ReactNode;
}) {
  if (panel) return <>{children}</>;
  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange} isMobile={isMobile}>
      {children}
    </ResponsiveModal>
  );
}

export function SurfaceContent({
  panel,
  open,
  flat,
  panelLabel,
  className,
  overlayClassName,
  children,
  ...props
}: ComponentProps<typeof ResponsiveModalContent> & {
  panel: boolean;
  open: boolean;
  /** Docked on the backdrop (shell column) vs floating as an overlay card
   *  (the /item page). Flat drops the card chrome; floating keeps it. */
  flat: boolean;
  panelLabel: string;
}) {
  if (panel) {
    // Unmounts when closed: the shell's column animates its own width, and the
    // e2e suite asserts the surface reaches count 0 after a close.
    if (!open) return null;
    return (
      <aside
        aria-label={panelLabel}
        // Focusable as a container so ⌘\ can land here and Tab can continue
        // into it — the panel never takes focus on its own (see autoFocus).
        tabIndex={-1}
        // Deliberately NOT role="dialog" — it isn't modal, and the suite's bare
        // getByRole('dialog') must keep resolving to exactly one node.
        //
        // Two surfaces, one body:
        //  · flat (shell) — a surface on the surface-0 backdrop, NOT a card: it
        //    reads as the paper plane BELOW the floating <main> card, mirroring
        //    the braindump column on the left (whose list sits directly on
        //    paper). So no bg-canvas fill, no border, no rounded card edge —
        //    the backdrop shows through. pt-[42px] drops the title's cap-top
        //    onto the same line as the "Braindump" and date headers (~59px from
        //    the window top); this column has no header capsule to add the
        //    offset those two get for free.
        //  · floating (/item page) — the same card recipe as <main>, because
        //    there it is a fixed overlay ABOVE the page's own content, so it
        //    must stay opaque and framed. No drop shadow either way: the shell
        //    column clips (overflow-hidden) for its width animation, which would
        //    eat an outer cast.
        className={
          flat
            ? 'flex h-full w-[420px] flex-col overflow-x-hidden overflow-y-auto bg-transparent px-5 pt-[42px] pb-5 outline-none'
            : 'border-border bg-canvas flex h-full w-[420px] flex-col overflow-x-hidden overflow-y-auto rounded-[30px] border px-5 pt-[31px] pb-5 outline-none'
        }
        {...props}
      >
        {children}
      </aside>
    );
  }
  return (
    <ResponsiveModalContent className={className} overlayClassName={overlayClassName} {...props}>
      {children}
    </ResponsiveModalContent>
  );
}

/** Radix needs a title/description in the a11y tree; the <aside> labels itself
 *  (and a DialogTitle rendered outside a Dialog throws). */
export function SurfaceA11yHeader({ panel, children }: { panel: boolean; children: ReactNode }) {
  if (panel) return null;
  return <ResponsiveModalHeader className="sr-only">{children}</ResponsiveModalHeader>;
}

/**
 * The add modal's geometry — top-[14vh]: a quick capture is a command, not a
 * ceremony, and the omnibar's latitude keeps your eyes near the day you're
 * adding to. max-h 80vh so 14vh + dialog never presses the viewport bottom.
 * Plain className overrides on the primitive's centered base; tailwind-merge
 * drops the conflicting top/translate pair. Desktop only — the drawer ignores it.
 */
export const ADD_MODAL_CLASS =
  'top-[14vh] w-[calc(100vw-2rem)] translate-y-0 sm:max-w-[460px] max-h-[80vh] overflow-y-auto overflow-x-hidden';

/**
 * The title field's recipe: borderless serif at a heading size — prose against
 * the sans + mono metadata below it, and the one element that makes the
 * surface read as a document rather than a form. dark:bg-transparent is
 * load-bearing: Input carries dark:bg-input/30, which tailwind-merge keeps
 * (different modifier) and which outranks bg-transparent on specificity.
 */
export const SERIF_TITLE_CLASS =
  '-mx-1 h-auto w-[calc(100%+0.5rem)] border-0 bg-transparent px-1 py-0 font-serif text-lg leading-snug font-medium shadow-none placeholder:font-normal focus-visible:ring-0 md:text-lg dark:bg-transparent';

/**
 * Notes' recipe: min-h-0 unpins the Textarea primitive's min-h-16; the rest is
 * the title's borderless recipe, dark:bg-transparent included. Paired with the
 * serif title as "what you wrote".
 */
export const SERIF_NOTES_CLASS =
  '-mx-1 min-h-0 w-[calc(100%+0.5rem)] resize-none overflow-y-auto border-0 bg-transparent px-1 py-0 font-serif text-sm leading-relaxed shadow-none placeholder:italic focus-visible:ring-0 md:text-sm dark:bg-transparent';

/** The footer's "↵ to add" teaching hint. Hidden on phones, which have no Enter to teach. */
export function EnterHint({ verb }: { verb: string }) {
  return (
    <span className="text-muted-foreground hidden items-center gap-1.5 text-xs sm:flex">
      <kbd className="border-border text-muted-foreground rounded-xs border px-1 font-mono text-[10px]">
        ↵
      </kbd>
      to {verb}
    </span>
  );
}

// ── The type menu ────────────────────────────────────────────────────────────

/** The organizers in menu order: the aspiration, the two gates, the label. */
export const ORGANIZER_KINDS: readonly NewContainerKind[] = ['goal', 'routine', 'program', 'project'];

/** Each organizer's console section — the Open / Add & open destination. */
export const ORGANIZER_SECTION: Record<NewContainerKind, 'goals' | 'routines' | 'programs' | 'projects'> = {
  goal: 'goals',
  routine: 'routines',
  program: 'programs',
  project: 'projects',
};

/**
 * The console rail's fixed glyph for the kind, so a Goal wears the same Target
 * everywhere. createElement rather than a capitalised local: the icon is looked
 * up per render, and the compiler lint reads `<Glyph />` of a looked-up
 * component as a component minted during render.
 */
export function OrganizerGlyph({ kind, className }: { kind: NewContainerKind; className?: string }) {
  return createElement(SECTION_IDENTITY[ORGANIZER_SECTION[kind]].icon, {
    className,
    'aria-hidden': true,
  });
}

/** One muted line per organizer — what it is FOR, not what it holds. */
const ORGANIZER_HINT: Record<NewContainerKind, string> = {
  goal: 'Something to reach',
  routine: 'A run of habits',
  program: 'A season',
  project: 'A home for work',
};

/**
 * Which organizers this account can make right now, per kind — the same gates
 * the console answers to (console-rail.tsx), plus the table's availability,
 * because a row that opens a dialog whose submit can never enable is a dead
 * door. Project is ungated: it is the one CLASSIFY kind, and items need
 * somewhere to be filed whatever else is switched off.
 */
export function useOrganizerGates(): Record<NewContainerKind, boolean> {
  const goalsOn = useGoalsEnabled();
  const organizeOn = useOrganizeEnabled();
  const goalsAvailable = usePlannerStore((s) => s.goalsAvailable);
  const collectionsAvailable = usePlannerStore((s) => s.collectionsAvailable);
  const collections = organizeOn && collectionsAvailable;
  return {
    goal: goalsOn && goalsAvailable,
    routine: collections,
    program: collections,
    project: true,
  };
}

/**
 * The type chip's menu — "what am I making" — identical in both dialogs.
 *
 * Item types first (built-ins pinned, then the user's own), then an
 * "Organizers" group with a line glyph per kind rather than a colour square,
 * so the two families never read as one list. A custom type whose slug is an
 * organizer noun (allowed before 2026-09-25, refused for new types since) is
 * suffixed " · type" so the menu never shows two indistinguishable "Goal" rows.
 *
 * `active` is an item type name, or `container:<kind>` for an organizer —
 * prefixed so a custom type called "goal" and the Goal organizer can never
 * answer to the same value.
 */
export function NewTypeMenu({
  active,
  showOrganizers,
  onPickType,
  onPickOrganizer,
  close,
}: {
  active: string;
  /** False on seeded opens (a bucket's or a day's "+"): that is an item's context. */
  showOrganizers: boolean;
  onPickType: (type: string) => void;
  onPickOrganizer: (kind: NewContainerKind) => void;
  close: () => void;
}) {
  const itemTypes = usePlannerStore((s) => s.itemTypes);
  const itemTypesAvailable = usePlannerStore((s) => s.itemTypesAvailable);
  const organizeOn = useOrganizeEnabled();
  const gates = useOrganizerGates();
  const openConsole = useOpenConsole();

  const typeNames = [...ALL_ITEM_TYPES, ...itemTypes.map((t) => t.name)];
  const organizers = showOrganizers ? ORGANIZER_KINDS.filter((k) => gates[k]) : [];
  const shadowed = new Set<string>(organizers);

  return (
    <>
      {typeNames.map((t) => {
        const config = getItemTypeConfig(t);
        return (
          <ChipOption
            key={t}
            selected={t === active}
            testId="item-dialog-type-option"
            value={t}
            onSelect={() => {
              onPickType(t);
              close();
            }}
          >
            <ColorSquare color={config.accent} />
            {config.label}
            {shadowed.has(t) && <span className="text-muted-foreground">· type</span>}
            {t === active && <Check className="ml-auto size-3.5" />}
          </ChipOption>
        );
      })}
      {organizers.length > 0 && (
        <>
          <div className="bg-border -mx-1 my-1 h-px" />
          <ChipSectionLabel>Organizers</ChipSectionLabel>
          {organizers.map((kind) => {
            const value = `container:${kind}`;
            return (
              <ChipOption
                key={kind}
                selected={value === active}
                testId="item-dialog-kind-option"
                value={kind}
                onSelect={() => {
                  onPickOrganizer(kind);
                  close();
                }}
              >
                <OrganizerGlyph kind={kind} className="text-muted-foreground size-3.5 shrink-0" />
                {CONTAINER_KINDS[kind].label}
                {value === active ? (
                  <Check className="ml-auto size-3.5" />
                ) : (
                  <span className="text-muted-foreground ml-auto truncate text-xs font-normal">
                    {ORGANIZER_HINT[kind]}
                  </span>
                )}
              </ChipOption>
            );
          })}
        </>
      )}
      {itemTypesAvailable && organizeOn && (
        <>
          <div className="bg-border -mx-1 my-1 h-px" />
          <ChipOption
            tone="muted"
            onSelect={() => {
              close();
              // Replaces this dialog rather than stacking on it: openDialog
              // swaps the single active slot.
              openConsole({ section: 'types' });
            }}
          >
            <Plus className="size-3.5" />
            Organize types…
          </ChipOption>
        </>
      )}
    </>
  );
}
