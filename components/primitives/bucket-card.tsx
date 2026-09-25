'use client';

import { ChevronDown, Timer, Sunrise, Sun, Moon } from 'lucide-react';
import { AddIconButton } from '@/components/primitives/add-icon-button';
import { CountBadge } from '@/components/primitives/pills';
import type { TimeBucket } from '@/lib/planner-types';
import { useViewStore, type BucketStyle } from '@/lib/view-store';
import { cn } from '@/lib/utils';

export const BUCKET_META: Record<
  TimeBucket,
  { label: string; icon: React.ComponentType<{ className?: string }>; tint: string }
> = {
  anytime: { label: 'Anytime', icon: Timer, tint: 'text-anytime' },
  morning: { label: 'Morning', icon: Sunrise, tint: 'text-morning' },
  afternoon: { label: 'Afternoon', icon: Sun, tint: 'text-afternoon' },
  evening: { label: 'Evening', icon: Moon, tint: 'text-evening' },
};

/**
 * The caption's ink, shared with GroupSection's canvas variant so a bucket name
 * and a "Habits" / project heading are one voice. Both are deliberately quieter
 * than the rows they label: in a view whose job is scanning tasks, the furniture
 * naming the groups should be the last thing the eye lands on, not the first.
 * `meta.tint` is no longer spent here, and neither is a ring — the caption is
 * a glyph and a word, at the same weight the Braindump gives a project.
 */
export const BUCKET_LABEL_INK = 'text-muted-foreground/70';

/**
 * The "you are here" glyph's halo: a soft lime glow that breathes behind the
 * icon (`.bucket-now-glow` in globals.css, the zen room's now-bead breath at
 * caption scale). `bleed` is how far past the glyph's box it reaches on each
 * side.
 *
 * A thumbnail RelayField was tried here first. At a 14px glyph the field can't
 * go below six columns, so its tiles land at ~6px and read as a ring of
 * scattered specks — the default palette's teal and orange included — rather
 * than as light. A gradient is the glow those tiles were trying to be.
 *
 * It is its own element, so the pulse dims only itself and the lime mark it
 * sits behind never composites through it. The caller owns the stacking: the
 * halo is `-z-10`, so its parent must be `relative isolate`, or it drops behind
 * the caption button's hover fill. CSS handles both motion vetoes (reduced
 * motion and the animations setting), holding the glow at rest.
 */
function CurrentGlyphHalo({ bleed }: { bleed: number }) {
  return (
    // Inline inset, not a class: the bleed differs per density and Tailwind
    // cannot see a computed `-inset-[…]`.
    <span
      aria-hidden
      data-testid="bucket-current-halo"
      className="bucket-now-glow pointer-events-none absolute -z-10 rounded-full"
      style={{ inset: -bleed }}
    />
  );
}

/**
 * Geometry per style × density. One table so day and week cannot drift.
 *
 * VERTICAL RHYTHM lives in two numbers, `capGap` and `gap`, plain px rather
 * than Tailwind classes because the parent views read `gap` through
 * `bucketGap()` and a class plus a duplicated literal is how those silently
 * drift apart.
 *
 *   capGap  caption → content
 *   gap     this bucket's content → the next bucket's caption
 *
 * `gap` is applied by the PARENT as flex `gap`, never by this component as
 * padding or margin, and that is load-bearing rather than stylistic. The
 * section's border box is the `{bucket}` droppable's rect, so any trailing
 * space inside it pushes the bare bucket's centre DOWN, toward
 * `scheduled:{bucket}:empty` sitting below. Measured on an empty bucket
 * mid-drag with 30px of trailing padding: the bare centre landed 21px from
 * `unscheduled:{bucket}` and 22px from `scheduled:{bucket}:empty` — a 1px
 * margin on a closestCenter decision, i.e. a coin flip between "no time" and
 * "9am", which is exactly the silent mis-resolution lib/dnd/CONTRACT.md warns
 * about. Margin does not help: a flex item is a block-formatting-context root,
 * so a child's bottom margin cannot collapse out of it and the rect still grows.
 * Flex `gap` is the only one of the three that puts the space BETWEEN the boxes
 * instead of inside one, which is why the views read `bucketGap()` below.
 */
const GEO = {
  /**
   * Floating cards. The bucket is a card on the canvas, flush with the
   * container's left edge like every other `canvas-container` surface. There
   * used to be a timeline rail here — a hairline running the height of the day
   * in an 18px gutter, with a bead pinning each bucket's start to it — and it
   * was removed: the caption glyph already says which stretch of the day this
   * is, so the rail was a second mark for the same fact, and its gutter was
   * width every row paid for. The stored value stays 'spine'; see the setting.
   */
  spine: {
    full: {
      node: 0,   // tray-only: the spine's glyph is inline in the caption
      /** CategoryIcon's size — a bucket glyph and a project glyph are one thing. */
      nodeIcon: 'h-3.5 w-3.5',
      /** The card's left edge. Flush: the gutter the rail ran in is gone. */
      cardX: 0,
      /**
       * The caption is the rows' column HEADER, so it indents to their columns
       * rather than sitting on the card's outer edge:
       *
       *   pl  22  = 0 cardX + 14 body pad + 8 TaskRow px-2 → the checkbox's x
       *   pr  22  =           14 body pad + 8 TaskRow px-2 → the trailing
       *                                                      pills' right edge
       *
       * The glyph lands on the checkbox column and the + on the pill column, so
       * both ends of the caption are verticals the rows already draw. Flush at
       * cardX aligned the LABEL to the checkbox instead, which left the glyph
       * and the label straddling that column without either one touching it,
       * and hung the + 14px past where any row content ends.
       */
      head: 'h-[26px] pl-[22px] pr-[22px] gap-2',
      /** Glyph → label, sized so the label lands on the TITLE's x:
       *  22 + 16 (checkbox) + 12 (row gap-3) = 50, minus 22 + 14 (glyph). */
      labelGap: 'gap-3.5',
      /** 0 + 14 = 14 row box; TaskRow's px-2 then lands the checkbox at 22. */
      body: 'pl-[14px] pr-[14px] py-4',
      capGap: 6,
      gap: 30,
      slotOpen: 'min-h-11',
      slotArmed: 'min-h-[60px]',
      radius: 'rounded-[14px]',
      sliver: 8,
      add: 'md' as const,
    },
    mini: {
      node: 0,
      nodeIcon: 'h-3 w-3',
      cardX: 0,
      // Same arithmetic as full, mini's numbers: 0 + 8 + 8 = 16 (checkbox),
      // 8 + 8 = 16 (pill edge). The glyph is 12px here rather than 14, so the
      // label gap is 2px WIDER than full's — the row's own 16 + 12 to the title
      // is density-independent (TaskRow's compact mode only changes py).
      head: 'h-5 pl-4 pr-4 gap-1',
      labelGap: 'gap-4',             // 16 + 16 + 12 = 44, minus 16 + 12
      body: 'pl-2 pr-2 py-2',        // 0 + 8 = 8 row box → checkbox at 16
      capGap: 4,
      // Four of these stack in a 240px column, so the day view's 30 would cost
      // 120px of a column that also has to hold a 60px header.
      gap: 16,
      slotOpen: 'min-h-7',
      slotArmed: 'min-h-[38px]',
      radius: 'rounded-[10px]',
      sliver: 6,
      add: 'sm' as const,
    },
  },
  /**
   * The glyph sits in an absolute node beside the caption and the rows get a
   * bordered, recessed tray.
   */
  tray: {
    full: {
      // Only drawn as a disc when current. Absolutely positioned and pulled
      // 4px left so growing 14 → 22px cannot reflow the caption row.
      node: 22,
      nodeIcon: 'h-3.5 w-3.5',
      // 1 (the tray's own border) + 14 (its padding) + 8 (TaskRow's px-2).
      // The border counts: forgetting it is what put the label 1px off the
      // checkboxes, which is visible on a 22px caption sitting right above them.
      // 1 (the tray's own border) + 16 (pr-4) + 8 = 25 on the right, mirroring
      // the pl. No inline glyph here (the tray's lives outside, absolutely
      // positioned), so the label itself takes the checkbox column and there is
      // no second vertical for `labelGap` to hit.
      head: 'h-[22px] pl-[23px] pr-[25px] gap-1.5',
      labelGap: 'gap-1.5',
      cardX: 0,
      body: 'pl-[14px] pr-4 py-4',
      capGap: 6,
      // The tray draws its own edge, so it needs less air between buckets than
      // the spine does to read as separate — the border is already doing it.
      gap: 20,
      slotOpen: 'min-h-11',
      slotArmed: 'min-h-[60px]',
      radius: 'rounded-[20px]',
      sliver: 8,
      add: 'md' as const,
    },
    mini: {
      node: 16,
      nodeIcon: 'h-3 w-3',
      head: 'h-4 pl-[17px] pr-[15px] gap-1', // 1 (border) + 8 + 8 / 1 + 6 + 8
      labelGap: 'gap-1',
      cardX: 0,
      body: 'pl-2 pr-1.5 py-2',
      capGap: 6,
      gap: 8,
      slotOpen: 'min-h-7',
      slotArmed: 'min-h-[38px]',
      radius: 'rounded-xl',
      sliver: 6,
      add: 'sm' as const,
    },
  },
};

/**
 * The space a stack of buckets should put BETWEEN its sections, as a flex
 * `gap`. Single-sourced here so day and week space their stacks from the same
 * table the cards are drawn from.
 */
export function bucketGap(variant: BucketStyle, density: 'full' | 'mini'): number {
  return GEO[variant][density].gap;
}

interface BucketCardProps {
  bucket: TimeBucket;
  count: number;
  onAdd?: (bucket: TimeBucket, type: 'task' | 'habit') => void;
  /** "You are here". Reads as a lime rule down the card's left wall ('spine'),
   *  plus a lime disc on the glyph ('tray') — never a ring in either. */
  isCurrent?: boolean;
  /** Drop highlight while dragging over. */
  isDropTarget?: boolean;
  /** A drag is in progress anywhere: open the latent slot. See the note below. */
  dragging?: boolean;
  /** Nothing at all in this bucket — collapses to the caption row. */
  isEmpty?: boolean;
  /** Caps the scrolling content area (week columns). */
  contentMaxH?: number;
  density?: 'full' | 'mini';
  /** Which drawing of a bucket. Defaults to the card; see BucketStyle. */
  variant?: BucketStyle;
  /** False for a specimen: always open, no chevron, and the shared
   *  `collapsedBuckets` flag is ignored rather than merely unreachable. */
  collapsible?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * A bucket: a stretch of the day, with its rows on an object.
 *
 * TWO DRAWINGS, ONE STRUCTURE (`variant`, from view-store's BucketStyle). They
 * differ only in where the glyph lives and what the body is at rest —
 * everything below is shared, which is the whole reason this is a prop and not
 * two components:
 *
 *   'spine'  Floating cards. The glyph sits inline in the caption, which stays
 *            on the canvas, and the rows sit on a card that floats on it, flush
 *            with the container's edge. (It once had a timeline rail in a
 *            gutter beside the cards; see GEO.spine for why it went.)
 *   'tray'   The icon sits beside the caption and the rows live in
 *            a bordered, recessed tray — the Figma mockup's depth ordering,
 *            restored (canvas → tray is a real 0.022 L step in both themes; the
 *            mockup's own 0.010 only ever read because a #EEEDED border bounded
 *            it, and light mode keeps that border here too).
 *
 * WHY THE CARD. Rows running the container's full width is the list view with
 * captions added; what a bucket lacked was object-ness. The card supplies it without a max-width — a narrower centred
 * column was tried and reverted, because the moat read as the view having
 * shrunk rather than as the buckets having become objects.
 *
 * WHY THE COUNT AND THE + ARE ON THE RIGHT. They used to sit against the name,
 * on the argument that at full width a flex spacer would park them ~950px from
 * the word they belong to. That is true of a caption labelling a POINT and
 * false of one heading an OBJECT: the card gives the row a right edge, so the
 * controls hang off the card rather than drifting in open canvas — the
 * Braindump header's arrangement.
 *
 * WHY THE CAPTION IS INDENTED. Not for air: every one of its four x's is a
 * vertical the rows below already draw. The glyph takes the checkbox column,
 * the label the title column, and the + the trailing-pill column, so the
 * caption reads as the card's column header instead of as a label pasted on its
 * top-left corner. It also means the caption is the one place the whole bucket
 * can be measured from — see GEO's head/labelGap/body arithmetic, which is the
 * single source for all of it.
 *
 * WHY NEITHER HAS A HEADER BAND. Once the glyph, name and count live outside
 * the body, the 45px band was holding a caption, not a surface — so its fill
 * and its bottom divider are gone in both, and an empty bucket costs 22px
 * instead of ~100.
 *
 * WHY THE CAPTION IS QUIETER THAN THE ROWS. It is furniture: it names a group
 * you already know the name of, in a view whose job is scanning what is IN the
 * group. So the label takes BUCKET_LABEL_INK (shared with GroupSection), the
 * glyph is one neutral weight rather than four tints, and the only colour
 * left in the column is lime for "you are here" and whatever the rows carry.
 *
 * WHY THE SLOT OPENS ON DRAG. lib/dnd/CONTRACT.md needs the bare `{bucket}`
 * droppable to have a visible hover state, and four caption-only buckets put
 * their rects ~44px apart — closer than closestCenter can reliably separate. So
 * for the duration of a drag a recess opens: it restores the pitch and gives
 * the drop target a surface to light. In 'tray' the surface is already there
 * and only grows. It is never animated IN (the rect must be stable before the
 * first collision pass) — only its height and fill transition.
 *
 * WHY A COLLAPSED BUCKET STILL TAKES A DROP, AND WHAT IT DROPS ONTO. Collapsing
 * hides the CHILDREN, not the slot: under a drag a shut bucket opens the same
 * empty landing surface an empty one does. That deliberately leaves it without
 * its `unscheduled:{bucket}` and `scheduled:{bucket}:*` droppables, so a drop
 * resolves on the bare `{bucket}` id — which handle-drag-end maps to the exact
 * command `unscheduled:{bucket}` would have produced (bucket, no time), so the
 * outcome is identical and there is no second rect inside the shut card for
 * closestCenter to have to separate. The alternative — rendering the real rows
 * under a drag — would reflow the whole column at drag start, which is the one
 * thing the rect-stability contract forbids.
 *
 * WHY NEITHER USES A RING FOR "NOW". A ring is the grammar of focus. Both
 * variants give the current bucket a mark with EXTENT instead — a lime rule
 * down the left wall of its card or tray — so a busy current bucket shows a
 * long rule and a short one a short rule. That is the difference between
 * position and selection. An empty current bucket has no card to rule, so in
 * 'spine' it says "now" only through its caption stepping up a tone.
 */
export function BucketCard({
  bucket,
  count,
  onAdd,
  isCurrent,
  isDropTarget,
  dragging,
  isEmpty,
  contentMaxH,
  density = 'full',
  variant = 'spine',
  collapsible = true,
  children,
  className,
}: BucketCardProps) {
  const meta = BUCKET_META[bucket];
  const Icon = meta.icon;
  const g = GEO[variant][density];
  const isSpine = variant === 'spine';
  // A boolean, not the array: every bucket card subscribes to this, and week
  // renders 28 of them. Selecting the array would re-render all of them
  // whenever any one bucket is toggled.
  const collapsed = useViewStore((s) => s.collapsedBuckets.includes(bucket));
  const toggleCollapsed = useViewStore((s) => s.toggleBucketCollapsed);
  const expandBucket = useViewStore((s) => s.expandBucket);
  // The breathing glow behind the current glyph. See CurrentGlyphHalo.
  const showHalo = !!isCurrent;
  const haloBleed = density === 'full' ? 8 : 6;

  // An empty bucket has nothing to shut, so it offers no control — a chevron
  // that toggles a stored flag with no visible effect is a dead affordance, and
  // worse here, because "shut" draws a sliver and an empty bucket draws
  // nothing, so collapsing would visibly ADD a mark. The stored flag survives a
  // bucket emptying and re-filling; it just isn't reachable while there is
  // nothing in there.
  // A specimen (the settings Look preview) must be a function of the settings
  // being previewed, not of planner state: `collapsedBuckets` is a persisted,
  // shared flag, so a user who had shut Morning on the grid would open
  // /settings/look and find an empty card that no Look row appears to change.
  const canCollapse = !isEmpty && collapsible;
  const isShut = collapsed && canCollapse;

  // What sits under the caption, in priority order:
  //   dragging  → the slot (children suppressed while shut — see the note above)
  //   shut      → the sliver: this card, closed
  //   empty     → nothing. An empty bucket is its caption, which is the 22px
  //               that made the redesign worth doing.
  //   otherwise → the card
  const showSlot = dragging || (!isShut && !isEmpty);
  const showSliver = !dragging && isShut;

  return (
    <section
      data-testid="bucket-card"
      data-bucket={bucket}
      data-bucket-style={variant}
      data-current={isCurrent ? 'true' : 'false'}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-drop-target={isDropTarget ? 'true' : 'false'}
      // No trailing space of its own — see the GEO note. The parent spaces
      // these with flex `gap`, sourced from bucketGap().
      className={cn('group/bucket relative isolate', className)}
    >
      {/* The tray variant keeps its glyph in an absolute node, which swells to
          a lime disc for "now" alongside the rule down its left wall. */}
      {/* The tray's halo sits under its node rather than inside it: inside,
          the glow would paint over the lime disc's own fill. Same box as the
          current node, one layer down. */}
      {!isSpine && showHalo && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 left-[-4px] z-[2] isolate"
          style={{ width: g.node, height: g.node }}
        >
          <CurrentGlyphHalo bleed={haloBleed} />
        </span>
      )}
      {!isSpine && (
        <span
          aria-hidden
          className={cn(
            'absolute top-0 z-[3] grid place-items-center rounded-full transition-colors',
            'left-[-4px]',
            isCurrent ? 'bg-primary text-primary-foreground' : BUCKET_LABEL_INK
          )}
          style={{
            width: isCurrent ? g.node : g.node - 8,
            height: isCurrent ? g.node : g.node - 8,
            marginTop: isCurrent ? 0 : 4,
            marginLeft: isCurrent ? 0 : 4,
          }}
        >
          <Icon className={g.nodeIcon} />
        </span>
      )}

      {/* The caption sits on the canvas above the card, indented to the rows'
          own columns rather than to the card's edge: glyph over the checkboxes,
          label over the titles, + over the trailing pills (the arithmetic is in
          GEO's head/labelGap). It heads the card without being on it. A darker
          frame carrying the caption was tried here (the Braindump header's
          surface-3 capsule around a shadowed pill) and removed: a second ground
          behind every bucket made the furniture read heavier than the rows it
          was holding. */}
      <>
        {/* justify-between with two children, not a flex-1 spacer between four:
            the spacer took the header's own `gap` on BOTH sides, and a third
            helping of it landed between the count and the +, which is why those
            two read as unrelated controls rather than one cluster. Now `gap` is
            only the minimum between the name and the cluster, and the cluster
            sets its own. */}
        <header className={cn('flex items-center justify-between', g.head)}>
          {/* h3 wrapping the button, not the other way round: a heading is flow
              content and a button only takes phrasing content, so the usual
              accordion nesting is the only one that validates. The negative
              margin cancels the button's own padding, so the hover target grows
              around the glyph without moving it off the caption's x. */}
          <h3 className="flex min-w-0 items-center">
            {(() => {
              const inner = (
                <>
                  {isSpine &&
                    (showHalo ? (
                      // `isolate` keeps the halo's -z-10 above the caption
                      // button's hover fill instead of under it.
                      <span className="relative isolate flex flex-none">
                        <CurrentGlyphHalo bleed={haloBleed} />
                        <Icon className={cn('flex-none', g.nodeIcon, BUCKET_LABEL_INK)} />
                      </span>
                    ) : (
                      <Icon className={cn('flex-none', g.nodeIcon, BUCKET_LABEL_INK)} />
                    ))}
                  {/* The current bucket steps up one tone, not to full ink. The
                      lime rule on the card already says where you are; this only
                      keeps the caption from contradicting it (and is the whole
                      signal on an empty current bucket, which has no card). */}
                  <span
                    className={cn(
                      'truncate font-sans text-xs font-medium',
                      isCurrent ? 'text-muted-foreground' : BUCKET_LABEL_INK
                    )}
                  >
                    {meta.label}
                  </span>
                </>
              );
              // Glyph → label. This is what sets the label's x, and the label's
              // x is what has to equal the row TITLE's below (see GEO's
              // head/body arithmetic) — the header's own `gap` only spaces the
              // title block off the count and the +.
              const gap = g.labelGap;
              return canCollapse ? (
                <button
                  type="button"
                  data-testid="bucket-toggle"
                  aria-expanded={!isShut}
                  onClick={() => toggleCollapsed(bucket)}
                  className={cn(
                    '-mx-1 flex min-w-0 items-center rounded-[5px] px-1 py-0.5 transition-colors hover:bg-accent',
                    gap
                  )}
                >
                  {inner}
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      'h-3 w-3 flex-none text-muted-foreground/50 transition-transform',
                      isShut && '-rotate-90'
                    )}
                  />
                </button>
              ) : (
                <span className={cn('flex min-w-0 items-center', gap)}>{inner}</span>
              );
            })()}
          </h3>

          {/* Count and add live on the RIGHT edge, the Braindump header's
              arrangement: the name owns the left, the controls own the right,
              and the space between them is what tells you the caption spans an
              object rather than labelling a point. They are ONE cluster — a
              readout and the verb that changes it — so they sit at cluster
              spacing, not at the same distance the name is from both. */}
          <div className="flex flex-none items-center gap-1">
            <CountBadge
              count={count}
              testId="bucket-count"
              size={density === 'full' ? 'md' : 'sm'}
            />
            {onAdd && (
              <AddIconButton
                size={g.add}
                // Adding into a shut bucket would drop the new row behind the
                // sliver — same swallow as a drop, same fix.
                onClick={() => {
                  expandBucket(bucket);
                  onAdd(bucket, 'task');
                }}
                aria-label={`Add to ${meta.label}`}
              />
            )}
          </div>
        </header>

        {showSlot && (
          <div
            className={cn(
              'relative transition-[min-height,background-color,box-shadow] duration-150 ease-[var(--ease-out-soft)]',
              g.body,
              g.radius,
              // 'tray' is a real recess at rest, so it carries its fill, its
              // border and its far-wall modelling always. Light keeps the border
              // as well as the value step: the Figma tray only ever read because
              // #EEEDED bounded it, and belt-and-braces is the point of this
              // variant being the conservative one.
              //
              // 'spine' floats its card on the canvas at rest and SINKS it
              // under a drag: the fill drops to the tray value, the float shadow
              // gives way to the recess walls, and the mouth appears. A card
              // that stayed lifted while acting as a drop target would be
              // claiming two depths at once.
              //
              // "Now" in both is a lime rule down the left wall — an inset
              // shadow, so it follows the radius — joined onto whichever
              // shadow the surface is wearing, drag or rest.
              isSpine
                ? dragging
                  ? isCurrent
                    ? 'shadow-[var(--bkt-walls),inset_2px_0_0_var(--primary)]'
                    : 'shadow-[var(--bkt-walls)]'
                  : cn(
                      'bg-[var(--bkt-card)]',
                      isCurrent
                        ? 'bg-[var(--bkt-card-now)] shadow-[var(--bkt-card-shadow-now),inset_2px_0_0_var(--primary)]'
                        : 'shadow-[var(--bkt-card-shadow)]'
                    )
                : 'border border-border shadow-[var(--bkt-walls)]',
              isDropTarget
                ? cn('bg-[var(--bkt-tray-armed)]', g.slotArmed)
                : dragging
                  ? cn('bg-[var(--bkt-tray)]', g.slotOpen)
                  : !isSpine && 'bg-[var(--bkt-tray)]',
              // The lime rule down the tray's left wall — extent, not a loop.
              !isSpine && isCurrent && 'shadow-[var(--bkt-walls),inset_2px_0_0_var(--primary)]'
            )}
            style={{ marginTop: g.capGap, marginLeft: g.cardX }}
          >
            {/* The mouth. A real 1px element, not an inset shadow: the content
                area below can scroll (week caps it), and inset shadows paint
                BELOW child content, so a row scrolled to the top would slide
                over the line. */}
            {(dragging || !isSpine) && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-px"
                style={{ background: isDropTarget ? 'var(--bkt-lip-armed)' : 'var(--bkt-lip)' }}
              />
            )}
            {/* Plain overflow-y-auto, never <ScrollArea> — the Radix wrapper
                silently drops max-h. */}
            <div
              className={cn(contentMaxH != null && 'overflow-y-auto')}
              style={contentMaxH != null ? { maxHeight: contentMaxH } : undefined}
            >
              {/* Shut buckets render no children at all — see the drop note in
                  the component doc for why the droppables going with them is the
                  point rather than a side effect. */}
              {!collapsed && children}
            </div>
          </div>
        )}

        {/* The card, shut. Same edges and the same fill the slot takes under a
            drag — so collapsing reads as the lid coming down on the object that
            was there, rather than as the object being deleted and a rule drawn
            in its place. */}
        {showSliver && (
          <div
            aria-hidden
            className={cn(
              'relative rounded-full bg-[var(--bkt-tray)]',
              // A shut current card keeps its lime rule, so collapsing the
              // bucket you are in doesn't also hide that you are in it.
              isSpine
                ? isCurrent
                  ? 'shadow-[var(--bkt-card-ring),inset_2px_0_0_var(--primary)]'
                  : 'shadow-[var(--bkt-card-ring)]'
                : 'border border-border'
            )}
            style={{
              marginTop: g.capGap,
              marginLeft: g.cardX,
              height: g.sliver,
            }}
          />
        )}
      </>
    </section>
  );
}
