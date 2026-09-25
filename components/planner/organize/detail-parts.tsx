'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import { ChevronLeft, MoreHorizontal, Plus, X } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconPicker } from '@/components/primitives/icon-picker';
import { ChipOption, PropertyChip } from '@/components/primitives/property-chip';
import { ColorSwatchPicker } from '@/components/primitives/color-swatch-picker';
import { accentColorForName } from '@/lib/accent-colors';
import { formatShort, parseDay, useNameDraft } from '@/lib/collections';
import { Eyebrow } from './primitives';
import { SECTION_IDENTITY, type ConsoleSection } from './console-rail';
import { useEscapeRung } from './escape-ladder';
import { cn } from '@/lib/utils';

/**
 * The pieces every detail pane in the Organize console is built from.
 *
 * Labels sit on one left rule and controls on one right rule — two clean
 * verticals down a 408px content column.
 */

/* ── the two columns ──────────────────────────────────────────────────── */

/**
 * List and detail, sized once so no section can drift.
 *
 * Below `md` the detail REPLACES the list; above it both are mounted and
 * selecting never navigates. The breakpoint is `md`, NOT `sm`, and that is load
 * bearing: ResponsiveModal hands over to the vaul bottom sheet at useIsMobile's
 * 768px, so `sm` (640px) would put the two-pane desktop layout inside a bottom
 * sheet for a 128px band.
 *
 * Same components either way — the only difference is whether the list stays
 * mounted beside the detail. Which is why the LIST ROW has to carry the full
 * state (colour, name, pill, count) rather than leaning on an editor that may
 * not be there.
 */
export function ListColumn({
  eyebrow,
  count,
  hasSelection,
  filter,
  suppressNoMatch,
  children,
  onNew,
}: {
  eyebrow: string;
  /** Rows currently SHOWING — so it reads as a match count while filtering. */
  count: number;
  hasSelection: boolean;
  /** The section filter. Always mounted when given, per the layout law below. */
  filter?: {
    value: string;
    onChange: (next: string) => void;
    /** Names the scope: `Filter routines…`. */
    placeholder: string;
    testId: string;
  };
  children: React.ReactNode;
  /**
   * Suppress the centralised "Nothing matches" branch and render `children`.
   *
   * For a section whose children are saying something the filter cannot know
   * about. The Trash is the case: a FAILED fetch renders zero rows, so typing
   * one character replaced "Couldn't load the trash" with "Nothing matches
   * 'x'" — turning an outage into a confident statement that the thing you are
   * hunting for is not in the bin. That is the one wrong answer a recovery
   * surface can give.
   */
  suppressNoMatch?: boolean;
  /**
   * Start creating. Renders the "+ New" verb in the head; the FORM it opens
   * lives in the detail pane (see CreateForm).
   *
   * This replaced a create row pinned to the foot of the column. That row was
   * 26px of borderless input under the fold of a scrolling list — the least
   * prominent thing in the section, for the one gesture a section exists to
   * offer. Omitted when a section cannot create (Trash).
   */
  onNew?: { onClick: () => void; label: string; testId: string; disabled?: boolean };
}) {
  return (
    <div
      data-testid="organize-list"
      className={cn(
        // 300px is a DESKTOP number, and pinning it below `md` put content off
        // the side of a phone: the plate hands over to a vaul bottom sheet whose
        // wrapper is `overflow-x-hidden`, so a 180px rail plus a shrink-0 300px
        // list is 480px of unpannable content in a 393px sheet — the add button,
        // the count column, the state pill and the drill-in chevron all live in
        // the clipped 119px. `md:flex-none` restores exactly `shrink-0` above the
        // breakpoint, so the 180 | 300 | 456 arithmetic is untouched; `min-w-0`
        // also drops the min-content floor the fixed width imposed on the row.
        'border-border flex min-h-0 min-w-0 flex-1 flex-col border-r md:w-[300px] md:flex-none',
        hasSelection && 'hidden md:flex'
      )}
    >
      <div className="flex h-[34px] shrink-0 items-center gap-2 pr-[9px] pl-[15px]">
        <Eyebrow className="flex-1">{eyebrow}</Eyebrow>
        {/* The count lives HERE and in the detail meta line — never in the rail,
            where it would reflow as data loads and join a tab's accessible name. */}
        <span className="text-muted-foreground font-num text-2xs">{count}</span>
        {onNew && (
          <button
            type="button"
            onClick={onNew.onClick}
            disabled={onNew.disabled}
            aria-label={onNew.label}
            data-testid={onNew.testId}
            className="border-border text-secondary-foreground hover:bg-accent hover:text-foreground focus-visible:outline-ring flex h-[22px] shrink-0 items-center gap-1 rounded-[6px] border pr-2 pl-1.5 text-xs font-medium disabled:opacity-40 focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-solid"
          >
            <Plus className="h-3 w-3" />
            New
          </button>
        )}
      </div>

      {filter && <FilterRow {...filter} />}

      {/* Plain overflow-y-auto: <ScrollArea> silently drops max-h. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {/* Centralised so all five sections cannot word it five ways — and so a
            section that forgets the branch cannot show "No routines yet." to
            someone who has twelve and typed a typo. */}
        {filter?.value && count === 0 && !suppressNoMatch ? (
          <p className="text-muted-foreground px-[7px] pt-2 text-xs">
            Nothing matches &ldquo;{filter.value}&rdquo;.
          </p>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

/**
 * The section filter — one field, filtering the CURRENT section only.
 *
 * Always mounted, never revealed on a keypress, because of the layout law: the
 * empty and populated states are the same layout with rows missing, and a field
 * that appears when you type `/` would shove the whole list down by 30px at the
 * exact moment you are aiming at it.
 *
 * The query lives in the SECTION, so switching sections clears it — Radix
 * unmounts the outgoing panel's subtree, and that is the behaviour worth having
 * anyway: a filter still narrowing a list you walked away from is a list that
 * looks half-empty for no visible reason.
 */
function FilterRow({
  value,
  onChange,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  testId: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  // Rung: clear the query. Claimed only while this field holds focus AND has
  // something to clear, so Escape on an empty field still closes the plate — a
  // rung that swallowed every press would strand the keyboard user and exhaust
  // the e2e closeManager helpers' four-press budget.
  useEscapeRung(() => {
    if (!value || document.activeElement !== ref.current) return false;
    onChange('');
    return true;
  });

  return (
    <div className="border-border flex h-[30px] shrink-0 items-center border-b px-[15px]">
      <input
        ref={ref}
        data-organize-filter=""
        data-testid={testId}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Into the results, so `/ type ↓ ↵` is one uninterrupted gesture.
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.currentTarget
              .closest('[data-testid="organize-list"]')
              ?.querySelector<HTMLElement>('[data-organize-row]')
              ?.focus();
          }
        }}
        className="text-foreground placeholder:text-muted-foreground -mx-1 w-[calc(100%+0.5rem)] min-w-0 border-0 bg-transparent px-1 py-0 text-sm outline-none"
      />
    </div>
  );
}

export function DetailColumn({
  hasSelection,
  children,
}: {
  hasSelection: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid="organize-detail"
      className={cn(
        'min-w-0 flex-1 overflow-y-auto px-6 py-5',
        !hasSelection && 'hidden md:block'
      )}
    >
      {children}
    </div>
  );
}

/** The arrival state: the section's teaching sentence, left-aligned at the top. */
export function TeachingLine({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground max-w-[46ch] text-sm">{children}</p>;
}

/**
 * The empty detail pane, warmed: the section's own glyph over its definition.
 *
 * The definition text is unchanged and stays THE content — this only gives the
 * coldest pane in the console a focal point and ties it to the rail's mark. The
 * glyph is NEUTRAL and larger (colour rides the rail tick and icon, never a big
 * mark), and the block stays TOP-ALIGNED: the empty state is the populated
 * layout with rows missing, never a centred card in a void (the empty-state
 * law). Trash keeps its own two-sentence detail and does not use this.
 */
export function SectionWelcome({
  section,
  children,
}: {
  section: ConsoleSection;
  children: React.ReactNode;
}) {
  const Icon = SECTION_IDENTITY[section].icon;
  return (
    <div className="flex flex-col gap-3">
      <Icon className="text-muted-foreground size-5 shrink-0" aria-hidden />
      <TeachingLine>{children}</TeachingLine>
    </div>
  );
}

/* ── identity ─────────────────────────────────────────────────────────── */

/**
 * Icon + name + colour, and the meta line beneath it.
 *
 * THE NAME IS BUFFERED, not written per keystroke, and that is not a
 * performance nicety: every update action stamps a history label and set()s,
 * and the subscriber deep-clones the whole snapshot on every change — so a
 * live-bound input turns renaming "Morning kickoff" into ~15 undo entries and
 * ~15 PATCHes, evicting the user's real history from a 50-deep stack.
 * Committed on blur and on Enter; Escape resets; blank or unchanged reverts.
 *
 * EVERY container is renameable now. This row carried an `editable=false` mode
 * that rendered a static title plus one honest sentence — projects and habit
 * groups were referenced BY NAME by their children, so a rename orphaned them —
 * and migration 027 removed the reason: children carry stable ids, the rename
 * fans out, and `validate` refuses a collision before it is written. The mode
 * and its note are gone rather than left behind as a permanently-true flag; git
 * has them if a surface ever needs to say no again.
 *
 * Item types were never parked and are a different shape: this row edits their
 * LABEL, while the immutable slug (items.type) is shown in the meta line.
 */
export function IdentityRow({
  id,
  name,
  accentName,
  icon,
  color,
  label,
  testPrefix,
  meta,
  onPatch,
  validate,
}: {
  id: string;
  name: string;
  /** The string the accent hashes, when it is not the displayed name — see ObjectRow. */
  accentName?: string;
  icon?: string;
  color?: string;
  /** "Routine", "Program", … — used for the control aria-labels. */
  label: string;
  testPrefix: string;
  /** `Routine · 6 items · in 1 program` — numerals in font-num. */
  meta: React.ReactNode;
  onPatch: (patch: { name?: string; icon?: string; color?: string }) => void;
  /**
   * Refuses a name before it is written, returning the sentence to show. Both
   * container tables are UNIQUE (user_id, name) and the rename's two writes do
   * not fail together — see useNameDraft.
   */
  validate?: (next: string) => string | null;
}) {
  const nameDraft = useNameDraft(id, name, (next) => onPatch({ name: next }), validate);
  const ref = useRef<HTMLInputElement>(null);

  // Rung: put the name back the way it was. Only claimed when the field is
  // focused AND actually dirty, so Escape on a settled pane still leaves.
  useEscapeRung(() => {
    if (nameDraft.draft === name || document.activeElement !== ref.current) return false;
    nameDraft.reset();
    return true;
  });

  return (
    <div>
      <div className="flex h-8 items-center gap-3">
        <IconPicker value={icon} name={name} onSelect={(next) => onPatch({ icon: next })} />

        <input
          ref={ref}
          value={nameDraft.draft}
          onChange={(e) => nameDraft.setDraft(e.target.value)}
          onBlur={nameDraft.commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              // Blur only on acceptance. Leaving a refused name on an UNFOCUSED
              // field strands it: the Escape rung below requires focus, so the
              // next Escape would close the whole console instead of putting
              // the old name back, and the sentence explaining the refusal
              // would sit under a field the user has to click into again.
              if (nameDraft.commit()) e.currentTarget.blur();
            }
          }}
          aria-label={`${label} name`}
          data-testid={`${testPrefix}-name-input`}
          // Borderless, styled as the heading it is. The well only appears
          // under focus, so a settled pane reads as a title rather than a form.
          className="text-foreground focus:bg-surface-3 -mx-1 min-w-0 flex-1 truncate rounded-[5px] border-0 bg-transparent px-1 py-0.5 text-lg font-semibold outline-none focus:shadow-[var(--shadow-inset-well)]"
        />

        <ColorSwatchPicker
          value={color}
          fallback={accentColorForName(accentName ?? name)}
          onSelect={(next) => onPatch({ color: next })}
          aria-label={`${label} color`}
        />
      </div>

      <p
        className="text-muted-foreground mt-1.5 text-2xs"
        data-testid={`${testPrefix}-meta`}
      >
        {meta}
      </p>


      {nameDraft.problem && (
        <p
          className="text-destructive mt-1.5 max-w-[58ch] text-xs"
          data-testid={`${testPrefix}-name-problem`}
        >
          {nameDraft.problem}
        </p>
      )}
    </div>
  );
}

/* ── the edit-pane head ──────────────────────────────────────────────── */

/**
 * The top of a goal, program or routine pane, in the ITEM edit pane's grammar
 * (item-dialog.tsx): a whisper — the colour square and the kind, 11px muted —
 * with the pane's quiet verbs on the right, ending in a ⋯ menu.
 *
 * Delete lives in that menu and nowhere else. A goal, program or routine goes
 * to the trash and comes back from it, so a labelled red zone at the foot of
 * every pane was spending the loudest thing in the console on an undoable act;
 * the item pane already keeps its Delete one tap behind ⋯ for the same reason.
 *
 * Below `md` the detail replaces the list, so BackRow stands above it.
 *
 * MENU ACTIONS RUN AFTER THE MENU HAS HANDED FOCUS BACK, not in `onSelect`.
 * Every one of them opens the shared confirm, and ConfirmDialog remembers
 * whatever holds focus the moment it opens so Cancel can put the cursor back.
 * Run from `onSelect`, that is the menu item — unmounted a frame later — so
 * reading the prompt and deciding not to delete dropped the cursor on <body>.
 * Deferred to the menu's close, it is the ⋯ trigger, which is still there.
 */
export interface DetailMenuAction {
  label: string;
  icon: React.ReactNode;
  testId: string;
  destructive?: boolean;
  onSelect: () => void;
}

export function DetailHead({
  kind,
  color,
  name,
  testPrefix,
  back,
  actions,
  menu,
}: {
  /** "Goal", "Program", "Routine". */
  kind: string;
  color?: string;
  /** Hashed for the square when no colour is stored, as ObjectRow does. */
  name: string;
  testPrefix: string;
  back: { label: string; testId: string; onBack: () => void };
  /** Quiet verbs before the ⋯ — a goal's "Open as page". */
  actions?: React.ReactNode;
  menu: DetailMenuAction[];
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pending = useRef<(() => void) | null>(null);

  return (
    <div className="flex flex-col">
      <BackRow {...back} />
      <div className="flex min-h-7 items-center gap-2">
        <span
          data-testid={`${testPrefix}-whisper`}
          className="text-muted-foreground inline-flex min-w-0 flex-1 items-center gap-1.5 text-[11px]"
        >
          <span
            className="size-[9px] shrink-0 rounded-[3px]"
            style={{ background: color ?? accentColorForName(name) }}
            aria-hidden
          />
          {kind}
        </span>
        {actions}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              data-testid={`${testPrefix}-more`}
              aria-label={`More ${kind.toLowerCase()} actions`}
              className="text-muted-foreground hover:text-foreground hover-wash focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-52"
            onCloseAutoFocus={(event) => {
              const run = pending.current;
              pending.current = null;
              if (!run) return;
              // Focus home FIRST, then act — see above.
              event.preventDefault();
              triggerRef.current?.focus();
              run();
            }}
          >
            {menu.map((action) => (
              <DropdownMenuItem
                key={action.testId}
                variant={action.destructive ? 'destructive' : 'default'}
                data-testid={action.testId}
                onSelect={() => {
                  pending.current = action.onSelect;
                }}
              >
                {action.icon}
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/**
 * Icon + name, as the item pane draws its title: a 30px glyph button and a
 * borderless SERIF heading. Colour is not here — it is a chip in the row below,
 * the way an item's project is.
 *
 * Buffered exactly as IdentityRow is, and for the same reason (see there):
 * committed on blur and on Enter, Escape resets, blank or unchanged reverts.
 */
export function TitleRow({
  id,
  name,
  icon,
  label,
  testPrefix,
  onPatch,
  validate,
}: {
  id: string;
  name: string;
  icon?: string;
  /** "Routine", "Program", … — the field's accessible name. */
  label: string;
  testPrefix: string;
  onPatch: (patch: { name?: string; icon?: string }) => void;
  validate?: (next: string) => string | null;
}) {
  const nameDraft = useNameDraft(id, name, (next) => onPatch({ name: next }), validate);
  const ref = useRef<HTMLInputElement>(null);

  useEscapeRung(() => {
    if (nameDraft.draft === name || document.activeElement !== ref.current) return false;
    nameDraft.reset();
    return true;
  });

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2.5">
        <IconPicker
          value={icon}
          name={name}
          onSelect={(next) => onPatch({ icon: next })}
          className="h-[30px] w-[30px] [&_svg]:size-4"
        />
        <input
          ref={ref}
          value={nameDraft.draft}
          onChange={(e) => nameDraft.setDraft(e.target.value)}
          onBlur={nameDraft.commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              // Blur only on acceptance — see IdentityRow.
              if (nameDraft.commit()) e.currentTarget.blur();
            }
          }}
          aria-label={`${label} name`}
          data-testid={`${testPrefix}-name-input`}
          className="text-foreground -mx-1 min-w-0 flex-1 truncate border-0 bg-transparent px-1 py-0 font-serif text-lg leading-snug font-medium outline-none"
        />
      </div>
      {nameDraft.problem && (
        <p
          className="text-destructive max-w-[58ch] text-xs"
          data-testid={`${testPrefix}-name-problem`}
        >
          {nameDraft.problem}
        </p>
      )}
    </div>
  );
}

/**
 * A state the pane has to explain — a paused routine, a program on its dates, a
 * goal's wind-down — in the item pane's paused-note dress: a quiet filled strip
 * with a leading glyph. Muted, never a warning colour: it states a fact.
 */
export function StatusStrip({
  icon,
  testId,
  children,
}: {
  icon: React.ReactNode;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="bg-surface-2 text-muted-foreground flex items-start gap-2.5 rounded-md px-2.5 py-2 text-xs"
    >
      <span className="mt-px flex shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/* ── create ───────────────────────────────────────────────────────────── */

/**
 * MAKING SOMETHING, in the detail pane — the console's create surface.
 *
 * The verb starts in the list head ("+ New"); this is what it opens, and it gets
 * the whole third pane: a pickable glyph, a heading-sized name, the section's own
 * definition as the hint, and one primary button. Creating is a deliberate act
 * and now looks like one — the same shape as the add-item dialog, where the app
 * already teaches that a name and an icon make a thing.
 *
 * It KEEPS the old create row's testids (`{prefix}-new-name`, `{prefix}-add`,
 * `{prefix}-new-problem`) because it is the same gesture in a better place: the
 * suites that drive creation only have to open it first, and the validate
 * contract — a SENTENCE, never a silent disabled button — is unchanged.
 *
 * `fields` is the kind's own part of making one — a goal's why and window, a
 * program's run — so the things that DEFINE the object are asked for at birth
 * rather than left as post-create edits. The section owns their state and
 * reads it in `onCreate`; the form only places them.
 *
 * An EMPTY section opens straight into this, which is why `onCancel` is
 * optional: with no rows behind it there is nothing to cancel back to, and a
 * button that returns you to a blank pane is a button that does nothing.
 */
export function CreateForm({
  eyebrow,
  placeholder,
  addLabel,
  hint,
  icon: initialIcon,
  testPrefix,
  disabled,
  autoFocus,
  validate,
  fields,
  onCreate,
  onCancel,
}: {
  /** "NEW ROUTINE" — names what is being made. */
  eyebrow: string;
  placeholder: string;
  /** "Create routine" — the button, and the field's accessible name. */
  addLabel: string;
  /** The section's definition, doing its teaching where it is now useful. */
  hint: React.ReactNode;
  /** The glyph a new one starts with; the picker can change it. */
  icon: string;
  testPrefix: string;
  disabled?: boolean;
  /**
   * Take the cursor. TRUE only when the user asked to create — never when the
   * form is merely standing in for an empty section.
   *
   * An empty section shows this form on arrival, and a form that focused itself
   * on arrival would rip the cursor out of the rail the moment ↓ landed on a
   * section with nothing in it — you could not walk past an empty section. Same
   * hazard the old create row's latch existed for, one surface up.
   */
  autoFocus?: boolean;
  validate?: (name: string) => string | null;
  /** The kind's own fields, under the name — see above. */
  fields?: React.ReactNode;
  onCreate: (name: string, icon: string | undefined) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string | undefined>(initialIcon);
  const ref = useRef<HTMLInputElement>(null);

  const trimmed = name.trim();
  const problem = trimmed && validate ? validate(trimmed) : null;
  const valid = !!trimmed && !disabled && !problem;

  /**
   * Take the cursor when the flag turns on — not merely when this mounts.
   *
   * React applies `autoFocus` at MOUNT only. An empty section already has this
   * form on screen (standing in for the empty list), so pressing its "+ New"
   * flipped the flag on an ALREADY-MOUNTED form and the attribute did nothing:
   * the section's one primary verb answered with no cursor and no visible
   * change. Driving the ref off the flag covers both arrivals — mounted-by-a-
   * click and already-here.
   */
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // Two rungs in one, in the order a step back happens: clear a half-typed name
  // FIRST, leave the form second. Escaping straight out of a form you have typed
  // into throws the typing away in the same keystroke that leaves.
  //
  // BOTH are guarded on focus, which is the idiom every other rung in the plate
  // follows (the create row's was, the filter's is, IdentityRow's is). Unguarded,
  // an Escape aimed at the filter or a rail row reached in here and destroyed a
  // half-typed name — first by wiping it, then, once only the clear was guarded,
  // by closing the whole form out from under it. A rung must not fire for a
  // keystroke that was never aimed at it.
  //
  // Falling through is correct in the two cases left: an empty name in a section
  // with nothing to cancel back to (the plate closes, as it always did), and any
  // press while the cursor is elsewhere (whatever owns it answers).
  useEscapeRung(() => {
    if (document.activeElement !== ref.current) return false;
    if (name) {
      setName('');
      return true;
    }
    if (!onCancel) return false;
    onCancel();
    return true;
  });

  const submit = () => {
    if (!valid) return;
    onCreate(trimmed, icon);
  };

  return (
    <div className="flex flex-col" data-testid={`${testPrefix}-create-form`}>
      <Eyebrow>{eyebrow}</Eyebrow>

      <div className="mt-3.5 flex items-center gap-3">
        <IconPicker value={icon} name={name} onSelect={setIcon} />
        <input
          ref={ref}
          value={name}
          placeholder={placeholder}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          aria-label={addLabel}
          data-testid={`${testPrefix}-new-name`}
          aria-invalid={!!problem || undefined}
          aria-describedby={problem ? `${testPrefix}-new-problem` : undefined}
          // The same borderless heading field IdentityRow uses, so the thing you
          // are naming looks like the thing it will become.
          className="text-foreground placeholder:text-muted-foreground focus:bg-surface-3 -mx-1 min-w-0 flex-1 truncate rounded-[5px] border-0 bg-transparent px-1 py-0.5 text-lg font-semibold outline-none focus:shadow-[var(--shadow-inset-well)]"
        />
      </div>

      {problem && (
        <p
          id={`${testPrefix}-new-problem`}
          data-testid={`${testPrefix}-new-problem`}
          className="text-muted-foreground mt-2 max-w-[46ch] text-xs"
        >
          {problem}
        </p>
      )}

      {fields && <div className="mt-3 flex flex-col gap-3">{fields}</div>}

      <p className="text-muted-foreground mt-3 max-w-[46ch] text-sm">{hint}</p>

      <div className="mt-5 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!valid}
          data-testid={`${testPrefix}-add`}
          className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:outline-ring flex h-8 shrink-0 items-center rounded-[6px] px-3.5 text-sm font-medium disabled:opacity-40 focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-solid"
        >
          {addLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            data-testid={`${testPrefix}-cancel`}
            className="border-border text-secondary-foreground hover:bg-accent hover:text-foreground focus-visible:outline-ring flex h-8 shrink-0 items-center rounded-[6px] border px-3 text-sm focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-solid"
          >
            Cancel
          </button>
        )}
        <span className="text-muted-foreground font-num ml-auto text-2xs">↵ to create</span>
      </div>
    </div>
  );
}

/* ── a buffered field ─────────────────────────────────────────────────── */

/**
 * A text or number input that commits on blur and on Enter, never per keystroke.
 *
 * THE CONSOLE'S SAVE RULE, half of it: discrete controls (a switch, a segment, a
 * select, a swatch) patch live, because one gesture is one decision and one undo
 * entry. Anything you TYPE buffers, because every keystroke would otherwise be
 * its own history entry and its own PATCH — renaming a project would evict the
 * user's real undo stack, and `duration: 6` would be written on the way to 60.
 *
 * Escape reverts and is a rung of the ladder, so backing out of a half-typed
 * value does not also collapse the plate. `validate` rejects a value outright
 * (blank, NaN, out of range); a rejected commit restores what was there.
 */
/**
 * BufferedInput's multi-line sibling: commits on blur, never per keystroke.
 *
 * Same rule and the same reason — every commit arms a history label, `set()`s,
 * and the subscriber deep-clones the whole snapshot, so a live-bound field turns
 * one typed sentence into ~60 undo entries and ~60 PATCHes, evicting the user's
 * real history from a 50-deep stack. It exists because a goal's `why` is the
 * first genuinely PARAGRAPH-shaped field in the console; every other typed
 * control here is a single line and uses BufferedInput.
 *
 * No Enter-to-commit: Enter is a newline in a textarea, which is the whole point
 * of using one. Escape reverts, matching its sibling.
 *
 * It is BORDERLESS SERIF and grows with its text — the item pane's notes recipe
 * (item-dialog.tsx), because in the edit-pane grammar the why is "what you
 * wrote", set against the chips' sans metadata, not a form field in a box.
 */
export function BufferedTextarea({
  value,
  onCommit,
  testId,
  ariaLabel,
  placeholder,
  rows = 1,
  className,
}: {
  value: string;
  onCommit: (next: string) => void;
  testId: string;
  ariaLabel: string;
  placeholder?: string;
  rows?: number;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Render-phase reset — see BufferedInput. Without it, switching the selected
  // object in the two-pane layout carries the previous one's half-typed text
  // into the next one's field, and a blur there commits it onto the wrong row.
  const [last, setLast] = useState(value);
  if (last !== value) {
    setLast(value);
    setDraft(value);
  }

  const commit = () => {
    if (draft === value) return;
    onCommit(draft);
  };

  useEscapeRung(() => {
    if (draft === value || document.activeElement !== ref.current) return false;
    setDraft(value);
    return true;
  });

  useAutoGrow(ref, draft);

  return (
    <textarea
      ref={ref}
      value={draft}
      rows={rows}
      placeholder={placeholder}
      aria-label={ariaLabel}
      data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      className={cn(
        // The item pane's notes recipe, minus the shadcn Textarea it undoes.
        'text-foreground placeholder:text-muted-foreground -mx-1 block w-[calc(100%+0.5rem)] resize-none overflow-y-auto border-0 bg-transparent px-1 py-0 font-serif text-sm leading-relaxed outline-none placeholder:italic',
        className
      )}
    />
  );
}

/**
 * One line tall, growing with the text. `field-sizing` alone would do it in
 * Chrome; measuring keeps Safari from trapping a long why inside one scrolling
 * row. 'auto' first so it also SHRINKS on delete. Same cap as item notes.
 */
function useAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, text: string) {
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [ref, text]);
}

/**
 * An UNBUFFERED serif notes field, for a create form — nothing exists to write
 * to yet, so the draft is the section's own state and commits with the object.
 */
export function NotesField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
  testId: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, value);

  // Rung: clear the field, as FilterRow does. Without it, Escape here found no
  // claimant — CreateForm's rung only answers for its name input — and closed
  // the console with the name, the why and the window all in it.
  useEscapeRung(() => {
    if (!value || document.activeElement !== ref.current) return false;
    onChange('');
    return true;
  });

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      data-testid={testId}
      onChange={(e) => onChange(e.target.value)}
      // BufferedTextarea's recipe — spelled out, so caret-room can read it.
      className="text-foreground placeholder:text-muted-foreground -mx-1 block w-[calc(100%+0.5rem)] resize-none overflow-y-auto border-0 bg-transparent px-1 py-0 font-serif text-sm leading-relaxed outline-none placeholder:italic"
    />
  );
}

export function BufferedInput({
  value,
  onCommit,
  validate,
  type = 'text',
  testId,
  ariaLabel,
  placeholder,
  className,
  ...rest
}: {
  value: string;
  onCommit: (next: string) => void;
  /** Return false to reject — the field snaps back to `value`. */
  validate?: (next: string) => boolean;
  type?: 'text' | 'time' | 'number';
  testId: string;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
} & Omit<React.ComponentProps<'input'>, 'value' | 'onChange' | 'type' | 'className'>) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  // Render-phase reset, so a value changed elsewhere (undo, a sibling control)
  // lands in the field without a frame of the stale one.
  const [last, setLast] = useState(value);
  if (last !== value) {
    setLast(value);
    setDraft(value);
  }

  const commit = () => {
    const next = draft.trim();
    if (!next || next === value || (validate && !validate(next))) {
      setDraft(value);
      return;
    }
    onCommit(next);
  };

  useEscapeRung(() => {
    if (draft === value || document.activeElement !== ref.current) return false;
    setDraft(value);
    return true;
  });

  return (
    <input
      {...rest}
      ref={ref}
      type={type}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          e.currentTarget.blur();
        }
      }}
      className={cn(
        'border-border bg-background text-foreground focus-visible:outline-ring h-[26px] rounded-[5px] border px-2 text-sm focus-visible:outline-1 focus-visible:outline-solid',
        className
      )}
    />
  );
}

/* ── a day ────────────────────────────────────────────────────────────── */

/**
 * One day as a chip — a routine's "Comes back". (A program's run and a goal's
 * window are ranges, and use DateRangeChip.)
 *
 * Two rules it shares with every day picker in the console, each wrong in a
 * different way if it drifted:
 *
 * 1. WRITES WITH `format`, never `toDateStr`. react-day-picker hands back a
 *    browser-LOCAL-midnight Date, and re-reading that instant in another zone
 *    shifts it to the previous day. A picked day is a wall-calendar choice, not
 *    an instant. (Phase 1 of programs-routines shipped that bug once.)
 * 2. `disabledDays` is a v9 matcher, typed as the two single-key shapes rather
 *    than `{before?, after?}` — both-optional matches no member of the library's
 *    Matcher union, and `DateInterval` (which requires both) disables the days
 *    BETWEEN them, the exact opposite of what a bound wants.
 *
 * Unset reads as the dashed noun, like every PropertyChip; set reads as the
 * muted key and the day. Clearing lives in the popover, under the calendar.
 */
export function DayChip({
  label,
  value,
  testId,
  clearLabel,
  disabledDays,
  onChange,
}: {
  /** The noun unset, the muted key set — "Comes back". */
  label: string;
  value?: string;
  testId: string;
  clearLabel: string;
  disabledDays?: { before: Date } | { after: Date };
  onChange: (next: string | undefined) => void;
}) {
  return (
    <PropertyChip
      label={label}
      value={value ? formatShort(value) : undefined}
      display={
        value ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-num">{formatShort(value)}</span>
          </span>
        ) : undefined
      }
      ariaLabel={value ? `${label}: ${formatShort(value)}` : label}
      testId={testId}
      contentClassName="w-auto p-0"
    >
      {(close) => (
        <div>
          <Calendar
            mode="single"
            selected={parseDay(value)}
            defaultMonth={parseDay(value)}
            disabled={disabledDays}
            onSelect={(date) => {
              if (!date) return;
              onChange(format(date, 'yyyy-MM-dd'));
              close();
            }}
            initialFocus
          />
          {value && (
            <div className="border-t p-1">
              <ChipOption
                tone="muted"
                testId={`${testId}-clear`}
                onSelect={() => {
                  onChange(undefined);
                  close();
                }}
              >
                <X className="size-3.5" />
                {clearLabel}
              </ChipOption>
            </div>
          )}
        </div>
      )}
    </PropertyChip>
  );
}

/* ── chrome ───────────────────────────────────────────────────────────── */

/** Below `md` the detail replaces the list, so it needs a way back. */
export function BackRow({
  label,
  testId,
  onBack,
}: {
  label: string;
  testId: string;
  onBack: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onBack}
      data-testid={testId}
      className="text-muted-foreground hover:text-foreground -ml-1 mb-3 flex h-8 items-center gap-1.5 self-start text-sm md:hidden"
    >
      <ChevronLeft className="h-4 w-4" />
      {label}
    </button>
  );
}

/**
 * The delete zone: label left, outline button right, consequence beneath.
 *
 * `destructive` fills the button, and is spent on exactly one thing in the whole
 * console — the item-type delete, which is the only one that genuinely cannot be
 * undone. Dressing all five the same way is what taught the user to read none of
 * them.
 */
export function DangerZone({
  label,
  consequence,
  testId,
  destructive = false,
  onDelete,
}: {
  label: string;
  consequence: React.ReactNode;
  testId: string;
  destructive?: boolean;
  onDelete: () => void;
}) {
  return (
    <div>
      <div className="bg-border my-4 h-px" />
      <div className="flex items-center gap-4">
        <span className="text-foreground flex-1 text-sm font-medium">{label}</span>
        <button
          type="button"
          onClick={onDelete}
          data-testid={testId}
          className={cn(
            'h-[26px] shrink-0 rounded-[5px] px-3 text-sm',
            destructive
              ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              : 'text-destructive border-destructive/40 hover:bg-destructive/10 border'
          )}
        >
          Delete
        </button>
      </div>
      <p className="text-muted-foreground mt-2 max-w-[58ch] text-xs">{consequence}</p>
    </div>
  );
}
