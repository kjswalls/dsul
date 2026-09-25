'use client';

import { useEffect, useRef } from 'react';
import { ChevronRight, Moon } from 'lucide-react';
import { CategoryIcon } from '@/lib/category-icons';
import { accentColorForName } from '@/lib/accent-colors';
import { cn } from '@/lib/utils';

/**
 * The Organize console's shared marks (memory/plans/organize-console.md).
 *
 * Kept in one file because they only make sense as a set: the row, the pill it
 * may carry, the count column they share an edge with, and the keycap the
 * footer bar uses. Splitting them into a file each would hide the fact that
 * every geometry here is picked against the others.
 */

/* ── eyebrow ──────────────────────────────────────────────────────────── */

/**
 * The uppercase micro-label: rail group headers, list heads, member-list
 * headings. 10.5px rather than the 11px `text-xs` step, and deliberately below
 * the 12px name it labels — a heading that out-shouts its content is the
 * failure BUCKET_LABEL_INK exists to prevent elsewhere in the app.
 */
export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'text-muted-foreground text-[10.5px] font-medium tracking-wider uppercase',
        className
      )}
    >
      {children}
    </span>
  );
}

/* ── keycap ───────────────────────────────────────────────────────────── */

/**
 * A key, drawn flat. Never a bevelled 3D `<kbd>` — the app has exactly one
 * elevation vocabulary and a fake-embossed key is not in it.
 */
export function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <span className="border-border bg-surface-3 text-muted-foreground font-num ml-1.5 inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-[4px] border px-1 text-2xs">
      {children}
    </span>
  );
}

/* ── state pill ───────────────────────────────────────────────────────── */

/**
 * Muted, with a moon. The guilt-free law: never amber, never red, never a
 * dotted border, never a badge. Set aside is a decision the user made on
 * purpose and should look like one.
 *
 * A LIVE container wears no marker at all — only the exception is labelled —
 * so callers pass `null` rather than rendering an "Active" counterpart.
 */
export function StatePill({ label, testId }: { label: string; testId: string }) {
  return (
    <span
      data-testid={testId}
      className="bg-muted text-muted-foreground inline-flex h-[19px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-[10.5px] font-medium"
    >
      <Moon className="h-2.5 w-2.5" aria-hidden />
      {label}
    </span>
  );
}

/* ── object row ───────────────────────────────────────────────────────── */

/**
 * The one row primitive, used by all six sections.
 *
 * Full-bleed in the 300px list column, no card, no per-row fill at rest. A
 * stack of grey pills is the fastest way to look like a bootstrapped admin
 * panel, and this app already reserves rounded fills for NAV rows (the sidebar
 * rail).
 *
 * NO PER-ROW ACTIONS. No trash, no gear, no swatch, no overflow menu — every
 * verb for an object lives in its detail pane one pixel away. That buys ~30px
 * of name width, removes every hover-only affordance (touch and keyboard
 * parity solved by deletion rather than duplication), removes the mis-tap
 * delete, and leaves the list with exactly one interaction: select.
 */
export function ObjectRow({
  testId,
  idAttr,
  icon,
  color,
  name,
  accentName,
  selected,
  pill,
  pillTestId,
  count,
  onSelect,
}: {
  testId: string;
  idAttr?: Record<string, string>;
  icon?: string;
  /** Stored accent; falls back to the name hash, same as everywhere else. */
  color?: string;
  name: string;
  /**
   * The string the accent hashes, when it is NOT the displayed name.
   *
   * Only item types need this, and they need it because their display label and
   * their identity are different strings: item-registry's buildCustomTypeConfig
   * derives a type's accent from `def.name`, the SLUG, since that is the value
   * in `items.type`. Hash the label instead and a type called "Side Quest"
   * (slug `side-quest`) renders one colour here and another in the add dialog,
   * the item chips and Beacon's context.
   */
  accentName?: string;
  selected: boolean;
  /**
   * Non-null exactly when the object is NOT carrying its members. Required
   * rather than optional so every section has to answer the question — the
   * label sections pass `null` on purpose, they do not simply forget.
   */
  pill: string | null;
  pillTestId?: string;
  count: number;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  /**
   * Keep the selected row visible.
   *
   * The case that needs it is the deep link: the program notice opens the
   * console on a specific object, and the twelfth routine in a
   * list is below the fold, so without this the console arrives looking like
   * nothing was selected while the detail pane discusses something you cannot
   * see. `block: 'nearest'` makes it a no-op when the row is already in view, so
   * ordinary clicking never jumps the list under the cursor.
   *
   * Scroll only, never focus: the plate has a focus trap that runs on open, and
   * a second claim on the same tick is how a dialog ends up with a focus ring
   * somewhere its author never intended.
   */
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      data-testid={testId}
      // The filter's ArrowDown target. A generic hook rather than a per-section
      // testid, so the field does not have to know which list it sits above.
      data-organize-row=""
      data-selected={selected ? '' : undefined}
      data-paused={pill ? '' : undefined}
      {...idAttr}
      className={cn(
        'group flex h-[34px] w-full items-center gap-[9px] rounded-[5px] px-[7px] text-left',
        // No transition on background-color at all: anything over ~80ms
        // visibly trails the pointer as you sweep a twelve-row list, which is
        // why TaskRow omits one too.
        'hover:bg-accent',
        // Selected suppresses hover. Without the guard, hovering a selected row
        // swaps 9% for 4% and the row gets LIGHTER — the inversion every draft
        // of this design committed.
        'data-[selected]:bg-[var(--row-selected)] data-[selected]:hover:bg-[var(--row-selected)]',
        'focus-visible:outline-ring focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-solid'
      )}
    >
      {/* One mark, carrying identity AND colour. An identity square plus a grey
          glyph would accumulate two marks for one meaning.

          The colour sits on the WRAPPER and the glyph takes `text-current`:
          CategoryIcon bakes `text-muted-foreground` into its own className and
          accepts no style prop, so this is the only way to tint it — and it is
          CategoryIcon's existing idiom, not a new one. */}
      <span
        className="flex w-[18px] shrink-0 justify-center"
        style={{ color: color ?? accentColorForName(accentName ?? name) }}
      >
        <CategoryIcon glyph={icon} name={name} className="h-3.5 w-3.5 shrink-0 text-current" />
      </span>

      {/* The dimming rides the NAME only — not the row (that would fade the
          focus ring and the pill, the one thing that must stay readable) and
          not the glyph, because the accent may resolve to --accent-8, which is
          lime, and lime never dims. */}
      <span
        title={name}
        className="text-foreground group-data-[paused]:text-muted-foreground min-w-0 flex-1 truncate text-sm font-medium"
      >
        {name}
      </span>

      {pill && <StatePill label={pill} testId={pillTestId ?? 'state-pill'} />}

      {/* Fixed width and always rendered, including 0, so the numerals form a
          vertical rule down the list and the column never goes ragged as data
          loads. */}
      <span className="text-muted-foreground font-num w-[22px] shrink-0 text-right text-2xs">
        {count}
      </span>

      {/* Below md the detail replaces the list, so the row is a navigation. */}
      <ChevronRight className="text-muted-foreground/60 h-3 w-3 shrink-0 md:hidden" />
    </button>
  );
}

/* ── settings row ─────────────────────────────────────────────────────── */

/**
 * Label left, control flush right — two clean vertical rules down the detail
 * pane. The project time block's controls use it; the goal, program and routine
 * panes moved to the item edit pane's chip row (2026-09-25).
 */
export function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-border flex min-h-11 items-center gap-4 border-b last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-sm font-medium">{label}</div>
        {description && <div className="text-muted-foreground text-xs">{description}</div>}
      </div>
      {children}
    </div>
  );
}

/* ── segmented control ────────────────────────────────────────────────── */

/**
 * The app's capsule-over-pill signature at console scale, and the ONLY raised
 * element inside the plate.
 *
 * The 4px clearance is load-bearing, not taste: `--shadow-elev-sm` is a 4px
 * offset, so at 2px of padding the drop clips on the well's radius and the
 * whole thing reads as a shadcn default with a shadow bolted onto it.
 */
export function Segmented({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-surface-3 inline-flex h-8 shrink-0 items-center gap-0 rounded-[10px] p-1">
      {children}
    </div>
  );
}

export function SegmentedOption({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active ? '' : undefined}
      aria-pressed={active}
      className={cn(
        'h-6 rounded-[8px] px-3 text-sm transition-[background-color,box-shadow] duration-150',
        active
          ? 'bg-surface-2 text-foreground font-medium shadow-[var(--shadow-elev-sm)]'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}
