/** Comfortable hour-row height (px) for the schedule grids — the ceiling the
 *  adaptive fit (useFitHourPx) shrinks down from, never grows past. Lives here,
 *  not in day-schedule, so the fit hook can read it without an import cycle. */
export const HOUR_PX = 75;

/** Cap for <ProjectBlock variant="week"> (issue #193). Day view's ProjectBlock
 *  stays unbounded, since a mini week column can't afford an ever-growing card
 *  the way a full day-width one can. ~4 task rows before it scrolls.
 *  Week × Buckets (components/views/week-buckets.tsx) passes variant="week";
 *  it nests inside the bucket's own WEEK_BUCKET_MAX_H cap, so keep this the
 *  smaller of the two or the inner scroll never engages. */
export const WEEK_PROJECT_BLOCK_MAX_H = 160;

/** Week × Buckets. A single time bucket's content caps out here and scrolls
 *  internally, so a bucket stacked with rows doesn't push the rest of the day
 *  column off-screen. */
export const WEEK_BUCKET_MAX_H = 320;
/* ── Block geometry ────────────────────────────────────────────────────────
   These were private to day-schedule.tsx until the overlap pass needed them.
   They live here for the same reason HOUR_PX does: lib/schedule-overlap.ts is
   a pure function that has to agree with the renderer down to the pixel, and
   importing a 'use client' component into lib/ would be a cycle.
   day-schedule.tsx re-exports LANE_PX, which is what week-schedule imports. */

/** Width of the lane the rail, bead and now-marker live in. The pane starts
 *  here, and so do the hour hairlines, so the lane reads as one unbroken
 *  channel down the grid instead of a series of gaps. */
export const LANE_PX = 12;

/** The pane is nudged down from its true start and shortened by twice that, so
 *  back-to-back blocks show a seam instead of touching. The rail span and bead
 *  ignore the nudge — they sit on the real time. */
export const PANE_OFFSET = 3;
export const PANE_TRIM = 4;

/** Floor for a pane's height: one line of text (17px) plus its 12px padding. */
export const PANE_MIN_H = 34;

/** Above this the block splits its metadata onto a second row. */
export const PANE_TALL_H = 56;

/* ── Overlap geometry (lib/schedule-overlap.ts) ───────────────────────────── */

/** Transparent grid left showing between two crossing plates. The gap IS the
 *  tell that these are two objects rather than one wide one. */
export const COL_GAP = 4;

/** A nested child's left inset inside its parent's band: LANE_PX plus a 2px
 *  seam, so the child's own lane never kisses the parent's pane edge. The child
 *  is flush RIGHT (no inset), so the two 1px borders coincide as one hairline
 *  instead of drawing the mis-registered concentric pair. */
export const NEST_PX = LANE_PX + 2;

/**
 * …and the gap on the child's RIGHT edge.
 *
 * This started at 0 — the child was flush right so its 1px border and the
 * parent's would coincide as a single hairline, avoiding the mis-registered
 * concentric pair the crop-mark comment in day-schedule.tsx disclaims. On screen
 * that read as the child bursting out of the plate it is supposed to sit inside,
 * and it left the pocket visible only as a 12px strip under the child's lane.
 *
 * With a real gap the pocket frames the child on BOTH sides, which is most of
 * what makes containment read at all in light mode — where the well is a ~0.024 L
 * step and needs the area to show it. 8px is deliberate rather than a near-miss:
 * a 2-3px gap is what reads as a misaligned border.
 */
export const NEST_RIGHT_PX = 8;

/**
 * Hover lift for a block with NO descendants — high enough to clear every
 * resting plate so its crop marks and calipers can't be painted over by a flush
 * neighbour, which is the whole reason the lift exists.
 *
 * A block that DOES have descendants gets `z + 1` instead, never this. Raising a
 * container above its own contents is how you make the contents unreachable: the
 * pointer crosses the parent on its way in, the parent latches :hover, the parent
 * is now topmost at every point of the child, and the child can never be hovered
 * or clicked. See `zHover` in lib/schedule-overlap.ts.
 */
export const HOVER_Z = 15;

/**
 * The live-time marker sits above every plate, hovered or not.
 *
 * Its stub crosses a pane and is legible only because it paints ON TOP of the
 * 80%-opaque glass — lime under glass composites to olive, and lime is the one
 * accent that never dims. That invariant used to hold by accident (marker z-5,
 * blocks z-2); now that blocks span a real range it is stated once, here, and
 * both the marker and the overlap pass are held to it.
 */
export const NOW_MARKER_Z = 20;

/**
 * The week columns' pinned heads (boundary rail, day header, Anytime strip) sit
 * above the marker too: the hour grid scrolls UNDER them, and on today's column
 * that includes the marker and any hovered block. They stay below the gutter,
 * because sideways the heads are what scroll under it.
 */
export const WEEK_HEAD_Z = 21;

/**
 * …and the week grid's pinned hour gutter sits above even that.
 *
 * One above NOW_MARKER_Z, deliberately, because this is the one thing that must
 * out-paint the marker: once columns are user-sized the grid scrolls sideways,
 * and a column passing UNDER the gutter would otherwise draw its now-marker
 * (z 20) and any hovered block (HOVER_Z 15) straight across the hour labels.
 *
 * Why those escape a z-10 gutter at all: non-selected columns carry
 * `opacity-60`, which creates a stacking context that traps their descendants'
 * z-indexes. The SELECTED column has no opacity and no transform, so it creates
 * no stacking context and its descendants' z values compete in the root layer.
 * The bug is therefore invisible until you scroll the selected day under the
 * gutter — which is exactly the case the pin exists for.
 */
export const WEEK_GUTTER_Z = 22;

/**
 * …and the grouping cap row sits above even the gutter.
 *
 * It has to out-paint everything that scrolls under it, and on Week that
 * includes the pinned hour gutter — which is itself pinned above the now-marker
 * and any hovered block. A cap row below the gutter would have the gutter's
 * opaque background slide over the lane captions on the first vertical scroll,
 * which is precisely the case the caps exist for.
 */
export const LANE_CAP_Z = 23;

/** One line of content (12/17). A free band shorter than this cannot hold a
 *  title at all. */
export const LINE_H = 17;

/** A free band this tall centres a 17px line with 6px of air above and below —
 *  day's content column has no vertical padding of its own, so a band at the
 *  floor would put the title flush against the plate's border. */
export const BAND_COMFORT = LINE_H + 12;

/** Week's one gesture. Week does not attempt containment: every overlap
 *  shingles by this much, right-flush, z ascending. */
export const SHINGLE_PX = 10;

/** How deep containment may nest before a child is demoted to a sibling. Day
 *  gets one level of nesting; week gets none (it shingles instead). */
export const MAX_DEPTH_DAY = 2;

/**
 * The narrowest a channel — lane plus pane — is ever allowed to get.
 *
 * Not invented: week columns are already `min-w-[140px]`, so 140 is the width
 * this codebase has ALREADY accepted as the floor for a readable block. Deriving
 * it from the content box independently lands in the same place — 18px of pane
 * padding, a 16px checkbox with its gap, and ~85px of title (about fifteen
 * characters at 12/17) plus the 12px lane.
 *
 * This one number replaces the per-shell column caps it used to take. A ~900px
 * desktop field yields six channels and a ~294px mobile field yields two, both
 * derived rather than declared, so no caller has to know which shell it is in.
 */
export const MIN_CHANNEL_PX = 140;

/**
 * Below this pane width a block stops truncating one line and starts WRAPPING —
 * the treatment week has always used. The gate is the pane's real width rather
 * than which view it is in, so a narrow day channel and a week column look
 * identical, which is the whole point.
 *
 * At 200px the title has ~158px after the padding and checkbox — about
 * twenty-five characters. Below that a single truncated line is mostly ellipsis
 * and a wrapped, clamped one carries strictly more.
 */
export const PANE_WRAP_PX = 200;
