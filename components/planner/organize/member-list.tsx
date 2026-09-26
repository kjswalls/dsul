'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { LinkExistingPill, OrganizerSection } from '@/components/primitives/organizer-chips';
import { CategoryIcon } from '@/lib/category-icons';
import { usePlannerStore } from '@/lib/planner-store';
import { getItemTypeConfig, isCollectible, itemTypeName } from '@/lib/item-registry';
import { countLive, swapMembers, useLiveItemIds } from '@/lib/collections';
import { inActiveSection, useEscapeRung } from './escape-ladder';
import { cn } from '@/lib/utils';
import type { Item, Routine } from '@/lib/planner-types';

/**
 * The member lists inside the Organize console's detail pane.
 *
 * MOVED, NOT REWRITTEN (memory/plans/organize-console.md, Phase 2). Every
 * data-testid travels verbatim, because Phase 2's acceptance criterion is that
 * `tests/e2e/programs.spec.ts` runs UNCHANGED. The
 * geometry is re-cut to console scale (30px rows, 5px radii, a reserved control
 * rail) but no behaviour changes here.
 *
 * Each list is a SECTION in the item edit pane's grammar (2026-09-25): one
 * heading, "Items · 3", with a "Link existing" pill beside it that opens the
 * picker, the rows, and then whatever the owner adds at the foot (a goal's
 * "Add milestone…"). An empty list is the heading and that foot — no "0 items"
 * eyebrow under a heading that already names the list, and no "Nothing in here
 * yet" block saying what the empty rows already say.
 */

/* ── the row's shared control rail ────────────────────────────────────── */

/**
 * Hidden until hover or focus above `md`, unconditionally visible below it.
 *
 * The console is a bottom SHEET on a phone, where there is no hover and no
 * prior focus — reordering was the one thing group-by-routine shipped to make
 * observable, and on a phone it was two invisible targets you had to guess at.
 *
 * 24px boxes with a gap, not bare 14px glyphs touching each other: two adjacent
 * sub-24px targets are a mis-tap away from swapping in the wrong direction, and
 * the write goes straight to the DB.
 */
function ControlRail({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-end gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
        // Sized for its fullest case — up, down, remove (3 × 24px + 2 gaps),
        // plus the ⋯ menu when wide — so an orderable row never spills left.
        wide ? 'w-[102px]' : 'w-[76px]'
      )}
    >
      {children}
    </div>
  );
}

function RailButton({
  onClick,
  label,
  testId,
  disabled,
  children,
}: {
  onClick: () => void;
  label: string;
  testId: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // aria-disabled, NOT disabled. A real `disabled` at the end of the list
      // drops focus to the body the moment the last press lands it there, and
      // `focus-within` then fades the pair out — so a keyboard user walking a
      // member down loses their place and has to tab from the top of the plate.
      // The handler guards instead.
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onClick()}
      aria-label={label}
      data-testid={testId}
      className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-6 w-6 items-center justify-center rounded-[4px] aria-disabled:pointer-events-none aria-disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/* ── what a member row says about an item ─────────────────────────────── */

/**
 * The type glyph.
 *
 * A member row used to be a bare title, so two items called "Stretch" — one a
 * task, one a habit — were the same row twice, here AND in the add-search that
 * feeds it. Picking the wrong one is a silent write: it lands in the routine,
 * looks right, and only diverges later when the habit keeps recurring.
 *
 * The token comes off the REGISTRY rather than a `type === 'habit'` ternary, so
 * a user-defined type brings its own glyph with it and this component never
 * learns the type list.
 *
 * The fallback hashes the SLUG, not the label, and the distinction is real now
 * that Phase 3 made labels editable: `accentColorForName(def.name)` hashes the
 * slug, so hashing the label here would let a rename silently change a type's
 * glyph on every member row while its colour stayed put. One string decides
 * both.
 */
function TypeGlyph({ item, className }: { item: Item; className?: string }) {
  const name = itemTypeName(item);
  const config = getItemTypeConfig(name);
  return (
    <span className="flex w-[18px] shrink-0 justify-center">
      <CategoryIcon glyph={config.glyph} name={name} className={cn('h-3.5 w-3.5', className)} />
    </span>
  );
}

/**
 * The 64px meta column: WHEN, in as few characters as possible.
 *
 * `numeric` drives `font-num` and is deliberately not "always on". Tabular
 * figures exist to make digits line up in a column; running a word like
 * `Anytime` through them buys nothing and reads as instrumentation. A clock
 * time is numeric, a bucket name is not.
 *
 * An unscheduled item says nothing rather than "unscheduled" — the column is
 * 64px, and most rows in a braindump-fed routine are unscheduled, so the word
 * would be the loudest repeated thing on the pane while carrying no signal.
 */
function memberMeta(item: Item): { text: string; numeric: boolean } {
  if (item.startTime) return { text: item.startTime, numeric: true };
  if (item.timeBucket && item.timeBucket !== 'anytime') {
    return { text: BUCKET_TEXT[item.timeBucket] ?? item.timeBucket, numeric: false };
  }
  return { text: '', numeric: false };
}

/**
 * How many rows the picker draws.
 *
 * A cap rather than the whole pool because browsing on an empty query means
 * this list is now unbounded by default — someone with 400 braindump items
 * would render 400 buttons to pick one. Eight is deliberately more than the six
 * the search-only version showed: the list is scrollable and arrow-navigable
 * now, so more rows cost nothing to reach, and a browse list of six is barely a
 * browse.
 */
const PICKER_LIMIT = 8;

const BUCKET_TEXT: Record<string, string> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  anytime: 'Anytime',
};

/* ── items ────────────────────────────────────────────────────────────── */

/** What a member row draws in its leading slot and meta column, when the owner knows better. */
export interface MemberRowParts {
  /** Replaces the type glyph — a milestone's checkbox, a check-in's repeat mark. */
  leading?: (item: Item) => ReactNode;
  /** Replaces the when-column — a milestone's date, a check-in's "last Sep 20". */
  meta?: (item: Item) => { text: string; numeric: boolean };
  /** Done, not hidden: the title goes muted (never struck through). */
  done?: (item: Item) => boolean;
  /** After the meta column, before the controls — the week's dots (schedule-views.tsx). */
  trailing?: (item: Item) => ReactNode;
  /**
   * The row's verbs (member-row-actions.tsx): a hover capsule laid over the
   * meta column above md, and a ⋯ menu in the rail on every width.
   */
  capsule?: (item: Item) => ReactNode;
  menu?: (item: Item) => ReactNode;
}

/**
 * How far a row's trailing slot sits from the row's right edge: the control
 * rail (76px — ControlRail), the gap before it and the row's padding. A header
 * drawn over the trailing slots (WeekDotsHeader) pads by this much to line up.
 */
export const MEMBER_ROW_TRAILING_PAD = 76 + 9 + 7;
/** The same, for a list whose rail carries a ⋯ menu (`row.menu`). */
export const MEMBER_ROW_TRAILING_PAD_WITH_MENU = 102 + 9 + 7;

export function ItemMemberList({
  label,
  count,
  lead,
  footer,
  pickerHint,
  row,
  ownerId,
  ownerName,
  memberIds,
  members,
  hiddenIds,
  testPrefix,
  orderable = false,
  eligible,
  emptyPoolLabel,
  emptyHint,
  removable,
  onChange,
}: {
  /** The section heading — "Items", "Milestones". */
  label: string;
  /** After the dot. Defaults to the member count; omitted entirely when empty. */
  count?: ReactNode;
  /** Directly under the heading, above the rows — a goal's progress track. */
  lead?: ReactNode;
  /** The section's foot — an InlineAddRow that makes a new member. */
  footer?: ReactNode;
  /** One muted line at the top of the open picker saying who qualifies. */
  pickerHint?: string;
  row?: MemberRowParts;
  /** Only used to disarm the search when the selection changes. */
  ownerId: string;
  ownerName: string;
  memberIds: string[];
  members: Item[];
  /**
   * The members NOT on the user's day right now — the resolver's own per-item
   * answer, never the owning container's state.
   *
   * This was a single boolean, and that was wrong in both directions. A routine
   * held off by a program greyed an item that a SECOND routine was still
   * carrying, and a live routine drew an item at full contrast while the item's
   * own pause kept it off the grid. The container's state is not the item's:
   * the whole point of the disjunctive rule is that an item can have another
   * way onto the day.
   */
  hiddenIds: ReadonlySet<string>;
  testPrefix: string;
  /**
   * Routines only, and not a taste call: `routine_items` carries a `sort_order`
   * column (written from the array index by reconcileMembership) and
   * `program_items` does not. Offering the controls on a program would let the
   * user arrange an order that survives until the next fetch and then silently
   * reshuffles.
   */
  orderable?: boolean;
  /**
   * Which items may be added, when plain collectibility is not the question.
   *
   * Goals need it: a milestone must additionally be one-shot and a check-in
   * must be recurring, so the picker for those lists is narrower than the one
   * for plain members. Defaults to `isCollectible`, which is what every
   * container asked before and what routines and programs still ask.
   */
  eligible?: (item: Item) => boolean;
  /**
   * What to say when the pool is empty for a reason other than "you already
   * added everything".
   *
   * The default copy — "Everything is already in here." — was true while the
   * pool was always `isCollectible`. With a narrower `eligible` it can be empty
   * because NOTHING the user owns qualifies, and telling someone with no
   * one-shot tasks that every one of them is already a milestone is the kind of
   * confident wrong answer a picker should never give.
   */
  emptyPoolLabel?: string;
  /**
   * One muted line in place of rows while the list is empty — what belongs
   * here, by example. The create forms use it so a new container's empty
   * sections read as prompts rather than a blank form.
   */
  emptyHint?: string;
  /**
   * Whether a member may leave. Absent = always. A project cannot release a
   * habit (its container is REQUIRED — canBulkClearProject), so its bin would
   * be a button that silently does nothing.
   */
  removable?: (item: Item) => boolean;
  onChange: (ids: string[]) => void;
}) {
  const items = usePlannerStore((s) => s.items);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  /** Index into `candidates` of the highlighted row. See the keyboard block. */
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // The two-pane layout never remounts this component — it swaps the props
  // under it — so without this an open search box AND its typed query survive a
  // click on a different container, and Enter adds the top match to whichever
  // one is selected NOW. A silent write to the wrong owner.
  //
  // Adjusted during render, not in an effect: an effect paints one frame with
  // the PREVIOUS owner's query still in the box, and that frame is live — the
  // candidate list under it is already resolved against the new owner, so a fast
  // Enter lands the old query's top match on the new container.
  const [lastOwnerId, setLastOwnerId] = useState(ownerId);
  if (ownerId !== lastOwnerId) {
    setLastOwnerId(ownerId);
    setAdding(false);
    setQuery('');
    setCursor(0);
  }

  /**
   * STAYS OPEN. Collecting is almost never a single act — a routine is built by
   * adding four things in a row — and closing after each one made that four
   * round trips through a button that is 30px away and re-focuses the field
   * each time. The query clears instead, which drops back to the browse list
   * with the item just added removed from it, so the next one is one ↓↵ away.
   *
   * The cursor goes home rather than staying put: the list underneath has
   * changed completely (a cleared query re-shows the whole pool), so holding an
   * index would leave the highlight on an unrelated row.
   */
  const add = (id: string) => {
    onChange([...memberIds, id]);
    setQuery('');
    setCursor(0);
    searchRef.current?.focus();
  };

  // Rung: close the search before the plate. The active-section guard is
  // belt-and-braces — see inActiveSection for why it is worth keeping even
  // though Radix does not mount inactive panels today.
  useEscapeRung(() => {
    if (!adding || !inActiveSection(rootRef.current)) return false;
    setAdding(false);
    setQuery('');
    setCursor(0);
    return true;
  });

  /**
   * BROWSES ON AN EMPTY QUERY. The old picker showed nothing until you typed,
   * which quietly required you to already know the title of the thing you were
   * looking for — in a console whose entire job is finding one of thirty
   * objects you have half-forgotten. An empty query now means "everything
   * eligible", and typing narrows it.
   *
   * `isCollectible` is the registry's answer, not a type check, so a
   * user-defined type joins routines the day it is created.
   */
  const q = query.trim().toLowerCase();
  const admits = eligible ?? isCollectible;
  const pool = items.filter((i) => admits(i) && !memberIds.includes(i.id));
  const candidates = (q ? pool.filter((i) => i.title.toLowerCase().includes(q)) : pool).slice(
    0,
    PICKER_LIMIT
  );

  /**
   * Clamped during render, not in an effect, and at BOTH ends.
   *
   * The top clamp is for the list shrinking underneath the cursor — an item
   * deleted in another tab, an agent write, a redo — which the picker staying
   * open across adds made a much longer window.
   *
   * The bottom clamp is for ↓ on an EMPTY list, which is not a hypothetical:
   * `Math.min(active + 1, candidates.length - 1)` is `Math.min(1, -1)` there, so
   * one press against "Everything is already in here." parks the cursor at -1
   * and it stays there when the list refills — remove a member with its trash
   * button and the pool grows back with no row highlighted, no
   * `aria-activedescendant`, and Enter doing nothing until ↑ is pressed. The
   * first version of this clamped only the top and its own comment claimed the
   * user could not move the cursor out of range; ↓ is a user move.
   */
  const active = Math.max(0, Math.min(cursor, candidates.length - 1));

  // Keep the highlight on screen. Without this the cursor walks off the bottom
  // of the 148px window and ↓ appears to stop working — the selection is moving,
  // just where nobody can see it. `nearest` so it never scrolls when it doesn't
  // have to, which is what keeps the list from lurching on every keystroke.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active, query]);

  const closePicker = () => {
    setAdding(false);
    setQuery('');
    setCursor(0);
  };

  return (
    <div ref={rootRef}>
      <OrganizerSection
        label={label}
        count={members.length > 0 ? (count ?? members.length) : undefined}
        testId={`${testPrefix}-members`}
        action={
          <LinkExistingPill
            testId={`${testPrefix}-member-add`}
            aria-expanded={adding}
            onClick={() => {
              if (adding) closePicker();
              else {
                setAdding(true);
                setCursor(0);
              }
            }}
          />
        }
      >
        {lead}

        {members.length > 0 && (
          /* Plain overflow-y-auto: <ScrollArea> silently drops max-h. */
          <div
            className={cn(
              'max-h-44 space-y-px overflow-y-auto',
              // With week dots, the header above must line up with the rows —
              // so the scrollbar's gutter is reserved in both (WeekDotsHeader).
              row?.trailing && '[scrollbar-gutter:stable]'
            )}
          >
            {members.map((item, i) => {
              const meta = (row?.meta ?? memberMeta)(item);
              const done = row?.done?.(item) ?? false;
              return (
                <div
                  key={item.id}
                  data-testid={`${testPrefix}-member`}
                  data-item-id={item.id}
                  data-member-index={i}
                  data-done={done || undefined}
                  className="hover:bg-accent group relative flex h-[30px] items-center gap-[9px] rounded-[5px] px-[7px]"
                >
                  {row?.leading ? (
                    <span className="flex w-[18px] shrink-0 justify-center">{row.leading(item)}</span>
                  ) : (
                    <TypeGlyph item={item} />
                  )}

                  {/* Greyed while the container is off, NOT struck through —
                      struck through means done, and this isn't done, it's set
                      aside. A DONE milestone is muted the same way and for the
                      mirror reason: its check already says done, and a strike
                      on top would say it twice. */}
                  <span
                    title={item.title}
                    className={cn(
                      'font-content text-content min-w-0 flex-1 truncate',
                      hiddenIds.has(item.id) || done ? 'text-muted-foreground' : 'text-foreground'
                    )}
                  >
                    {item.title}
                  </span>

                  <span
                    data-testid={`${testPrefix}-member-meta`}
                    className={cn(
                      'text-muted-foreground w-[64px] shrink-0 text-right text-2xs',
                      meta.numeric && 'font-num'
                    )}
                  >
                    {meta.text}
                  </span>

                  {row?.trailing?.(item)}
                  {row?.capsule?.(item)}

                  {/* Buttons, not drag. The console renders inside the shell's
                      DndContext, so a sortable list here would need a nested one
                      and would compete with the item-drag sensors for the same
                      pointer. Two buttons are also the only version a keyboard
                      can reach.

                      Swaps by ID, never by index: `members` drops ids that name
                      a TRASHED item (join rows survive an item's soft delete by
                      design), so visible position and array position diverge
                      the moment one member is in the bin. */}
                  <ControlRail wide={!!row?.menu}>
                    {orderable && (
                      <>
                        <RailButton
                          onClick={() =>
                            onChange(swapMembers(memberIds, item.id, members[i - 1].id))
                          }
                          disabled={i === 0}
                          label={`Move ${item.title} up in ${ownerName}`}
                          testId={`${testPrefix}-member-up`}
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </RailButton>
                        <RailButton
                          onClick={() =>
                            onChange(swapMembers(memberIds, item.id, members[i + 1].id))
                          }
                          disabled={i === members.length - 1}
                          label={`Move ${item.title} down in ${ownerName}`}
                          testId={`${testPrefix}-member-down`}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </RailButton>
                      </>
                    )}
                    {(removable?.(item) ?? true) && <RailButton
                      onClick={() => onChange(memberIds.filter((m) => m !== item.id))}
                      label={`Remove ${item.title} from ${ownerName}`}
                      testId={`${testPrefix}-member-remove`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </RailButton>}
                    {row?.menu?.(item)}
                  </ControlRail>
                </div>
              );
            })}
          </div>
        )}

        {members.length === 0 && !adding && emptyHint && (
          <p
            className="text-muted-foreground px-[7px] text-xs italic"
            data-testid={`${testPrefix}-empty-hint`}
          >
            {emptyHint}
          </p>
        )}

        {adding && (
          <div className="flex flex-col gap-1">
            {pickerHint && (
              <p className="text-muted-foreground px-[7px] text-xs" data-testid={`${testPrefix}-member-hint`}>
                {pickerHint}
              </p>
            )}
            <Input
              ref={searchRef}
              autoFocus
              placeholder="Find an item…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // Home on every keystroke: the list under the cursor is a
                // different list now, so the old index points at nothing the user
                // chose.
                setCursor(0);
              }}
              /**
               * The whole keyboard contract, on the input rather than the rows.
               *
               * The rows are buttons and could take focus themselves, but then ↓
               * from the field moves focus OUT of it and the next character typed
               * goes nowhere. This is the combobox pattern for exactly that
               * reason: focus never leaves the input, `aria-activedescendant`
               * tells a screen reader which row is current, and the highlight is
               * ours to draw.
               */
              role="combobox"
              aria-expanded
              aria-controls={`${testPrefix}-member-candidates`}
              aria-activedescendant={
                candidates[active] ? `${testPrefix}-cand-${candidates[active].id}` : undefined
              }
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setCursor(Math.min(active + 1, candidates.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setCursor(Math.max(active - 1, 0));
                } else if (e.key === 'Enter') {
                  // Guarded on the row existing, not on the list being non-empty:
                  // Enter on "Nothing matches" must do nothing, not add whatever
                  // happens to be at index 0 of a stale render.
                  if (candidates[active]) {
                    e.preventDefault();
                    add(candidates[active].id);
                  }
                }
              }}
              className="bg-background border-border h-8"
              data-testid={`${testPrefix}-member-search`}
            />

            {/* Plain overflow-y-auto: <ScrollArea> silently drops max-h. */}
            <div
              id={`${testPrefix}-member-candidates`}
              role="listbox"
              className="max-h-[148px] space-y-px overflow-y-auto"
            >
              {candidates.map((item, i) => (
                <button
                  key={item.id}
                  ref={i === active ? activeRef : undefined}
                  type="button"
                  role="option"
                  id={`${testPrefix}-cand-${item.id}`}
                  aria-selected={i === active}
                  // Pointer and keyboard drive the SAME cursor, so moving the
                  // mouse over a row and pressing Enter does what the highlight
                  // says. Two independent "current" notions is the classic way a
                  // picker adds the wrong thing.
                  onMouseMove={() => i !== active && setCursor(i)}
                  onClick={() => add(item.id)}
                  data-testid={`${testPrefix}-member-candidate`}
                  data-item-id={item.id}
                  data-active={i === active || undefined}
                  className={cn(
                    'flex h-8 w-full items-center gap-[9px] rounded-[5px] px-[7px] text-left text-sm',
                    i === active && 'bg-accent'
                  )}
                >
                  {/* The same glyph as the row it will become. Without it, choosing
                      between two same-titled items is a coin flip — and this is the
                      half where getting it wrong is a write. */}
                  <TypeGlyph item={item} />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                </button>
              ))}

              {/* Inside the list, never a replacement screen, so ↑/↓/↵ keep meaning
                  something and the field keeps focus. Two different empties: one
                  is a query that found nothing, the other is a pool with nothing
                  left in it, and telling someone to refine a search that cannot
                  succeed is the worse of the two wrong answers. */}
              {candidates.length === 0 && (
                <p
                  className="text-muted-foreground px-[7px] py-1 text-xs"
                  data-testid={`${testPrefix}-member-none`}
                >
                  {pool.length === 0
                    ? (emptyPoolLabel ?? 'Everything is already in here.')
                    : `Nothing matches “${query.trim()}”.`}
                </p>
              )}
            </div>

            {/* THE WAY OUT, and it became load-bearing when the picker started
                staying open across adds. Before that, adding something closed it;
                now the only other exits are the Escape rung and switching
                container — and the console is a vaul bottom SHEET below `md`,
                where there is no Escape key at all. RoutineMemberList has shipped
                this row since Phase 2 for the same reason. */}
            <button
              type="button"
              onClick={closePicker}
              className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-8 items-center self-start rounded-[5px] px-[7px] text-left text-sm"
              data-testid={`${testPrefix}-member-add-done`}
            >
              Done
            </button>
          </div>
        )}

        {/* px-2, not the rows' 7px: the add row's plus is 16px to the glyph
            column's 18, and 8px puts the two on one centre line. */}
        {footer && <div className="px-2">{footer}</div>}
      </OrganizerSection>
    </div>
  );
}

/* ── routines held by a program ───────────────────────────────────────── */

/**
 * The routines a program holds.
 *
 * Attaching is the one membership write in the app with a NON-OBVIOUS
 * consequence, so it is the one that confirms first — the caller owns that
 * dialog and passes `onRequestAttach`, because the `wouldHide` simulation needs
 * the whole store and does not belong in a list component.
 */
export function RoutineMemberList({
  program,
  live,
  members,
  candidates,
  onRequestAttach,
  onRemove,
  testPrefix = 'program',
  emptyHint,
}: {
  program: { id: string; name: string };
  live: boolean;
  members: Routine[];
  candidates: Routine[];
  onRequestAttach: (routine: Routine) => void;
  onRemove: (routineId: string) => void;
  /** `program` in the detail pane (its testids predate this prop); the create forms pass their own. */
  testPrefix?: string;
  /** See ItemMemberList's `emptyHint`. */
  emptyHint?: string;
}) {
  const liveIds = useLiveItemIds();
  const [adding, setAdding] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Same render-phase reset as ItemMemberList, and for the same reason: above
  // `md` this component is never remounted, so an open candidate list would
  // survive a click on a different program and stay pointed at the one you left.
  const [lastProgramId, setLastProgramId] = useState(program.id);
  if (program.id !== lastProgramId) {
    setLastProgramId(program.id);
    setAdding(false);
  }

  // Escape closes the candidate list before it closes the plate.
  //
  // This USED to be a capture-phase listener on the document, on the theory
  // that Radix binds in the bubble phase. It does not — `useEscapeKeydown` binds
  // on the document with `{ capture: true }`, so it wins on registration order
  // and that handler never got in front of anything. The ladder goes through
  // Radix's own `onEscapeKeyDown` instead.
  useEscapeRung(() => {
    if (!adding || !inActiveSection(rootRef.current)) return false;
    setAdding(false);
    return true;
  });

  const none = candidates.length === 0;

  return (
    <div ref={rootRef}>
      <OrganizerSection
        label="Routines"
        count={members.length > 0 ? members.length : undefined}
        testId={`${testPrefix}-routines`}
        action={
          <LinkExistingPill
            testId={`${testPrefix}-routine-add`}
            aria-expanded={adding}
            // Disabled with its reason on hover, rather than hidden: a missing
            // pill reads as "programs cannot hold routines".
            disabled={none}
            title={none ? 'Every routine is already here' : undefined}
            className="disabled:pointer-events-none disabled:opacity-50"
            onClick={() => setAdding((a) => !a)}
          />
        }
      >
        {members.length > 0 && (
          <div className="max-h-32 space-y-px overflow-y-auto">
            {members.map((routine) => (
              <div
                key={routine.id}
                data-testid={`${testPrefix}-routine-member`}
                data-routine-id={routine.id}
                className="hover:bg-accent group flex h-[30px] items-center gap-[9px] rounded-[5px] px-[7px]"
              >
                <span className="flex w-[18px] shrink-0 justify-center">
                  <CategoryIcon glyph={routine.icon} name={routine.name} className="h-3.5 w-3.5" />
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-sm',
                    live ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {routine.name}
                </span>
                <span className="text-muted-foreground font-num w-[22px] shrink-0 text-right text-2xs">
                  {countLive(routine.itemIds, liveIds)}
                </span>
                <ControlRail>
                  <RailButton
                    onClick={() => onRemove(routine.id)}
                    label={`Remove ${routine.name} from ${program.name}`}
                    testId={`${testPrefix}-routine-remove`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </RailButton>
                </ControlRail>
              </div>
            ))}
          </div>
        )}

        {members.length === 0 && !adding && emptyHint && (
          <p
            className="text-muted-foreground px-[7px] text-xs italic"
            data-testid={`${testPrefix}-routines-empty-hint`}
          >
            {emptyHint}
          </p>
        )}

        {adding && !none && (
          <div className="flex flex-col gap-1">
            {candidates.map((routine) => (
              <button
                key={routine.id}
                type="button"
                onClick={() => {
                  setAdding(false);
                  onRequestAttach(routine);
                }}
                data-testid={`${testPrefix}-routine-candidate`}
                data-routine-id={routine.id}
                className="hover:bg-accent flex h-8 items-center gap-2 rounded-[5px] px-[7px] text-left text-sm"
              >
                <CategoryIcon glyph={routine.icon} name={routine.name} className="h-3.5 w-3.5" />
                <span className="truncate">{routine.name}</span>
              </button>
            ))}
            {/* The way out. Without it the only exits are attaching a routine you
                may not have wanted, or closing the whole console. */}
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-8 items-center rounded-[5px] px-[7px] text-left text-sm"
              data-testid={`${testPrefix}-routine-add-cancel`}
            >
              Cancel
            </button>
          </div>
        )}
      </OrganizerSection>
    </div>
  );
}
