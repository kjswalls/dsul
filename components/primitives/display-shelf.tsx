'use client';

import { useId, useRef } from 'react';
import { RotateCcw, Target, X } from 'lucide-react';
import {
  ContainerSquare,
  PriorityDot,
  type DisplayMenuHandle,
} from '@/components/primitives/display-menu';
import { RailTooltip } from '@/components/primitives/pills';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  clauseText,
  removeDisplaySetting,
  resetDisplay,
  useDisplaySummary,
  type DisplayClause,
  type DisplayGlyph,
  type DisplayRemoval,
  type DisplaySurface,
} from '@/lib/display-summary';
import { NO_PRIORITY } from '@/lib/filters';
import { cn } from '@/lib/utils';

/**
 * The Display shelf — what a surface's Display menu has set, spelled out in
 * words under its header for as long as anything is.
 *
 * The trigger's dot says THAT the surface is shaped; the shelf says how,
 * without a trip into the menu. On the braindump that is more than a
 * convenience: a filter that matches nothing leaves the list showing its
 * empty-state poem, and the shelf is then the only thing on screen that says
 * why.
 *
 * It renders exactly when the dot is lit and names exactly what the dot counts,
 * because both read the one summary in lib/display-summary.ts — a shelf that
 * worked out its own answer would sooner or later disagree with the dot. Its
 * words open the menu, and every setting and every value in it wears a ✕ of
 * its own that takes just that one off (`removeDisplaySetting`).
 *
 * One paragraph (2026-10-01, "Quiet paragraph"; it replaced a measured choice
 * between one line and a stack of one setting per line, which Kirby found
 * looked strange from three settings up). The settings sit side by side and
 * wrap BETWEEN one another like the words of a sentence, a filter's values kept
 * together wherever they fit on one line. Plain CSS wrapping: nothing is
 * measured, so nothing watches a size and nothing writes to the DOM behind
 * React's back.
 *
 * On a fine pointer a setting's ✕ is drawn only while that setting (or the ✕)
 * is under the pointer, or the ✕ has keyboard focus, so at rest the shelf is
 * words alone; and a ✕ that is not drawn is not there to hit either, so the
 * gaps between the words only ever open the menu. Where nothing hovers — the
 * phone mount, and a coarse pointer (a tablet) on the desktop shell — every ✕
 * stays drawn, in flow after its setting, with the phone's reaches.
 *
 * Reset display is the menu row's own glyph and the menu row's own function
 * (`resetDisplay`), at the end of the last line, and only from four things to
 * take off up: with two or three, the ✕s and the menu's row already do it in
 * as many clicks, and the glyph would push three settings onto a second line in
 * the List/Day capsule.
 *
 * No opacity and no transition anywhere in it. The Low dot is --priority-low
 * and a project square can be --accent-8, both lime: they are data glyphs, drawn
 * at rest and under the pointer exactly as the list's own priority bars and the
 * menu's squares are, and the shelf adds no lime CHROME of its own. A ✕ that is
 * not drawn is `text-transparent`, a colour, never an opacity. No live region
 * and no heading either — the menu it opens is modal, so nothing here changes
 * while a screen reader could be reading it.
 */
export function DisplayShelf({
  surface,
  menu,
  touch = false,
  floor,
  className,
}: {
  surface: DisplaySurface;
  /** The menu this shelf describes. Read in handlers only — see DisplayMenuHandle. */
  menu: React.RefObject<DisplayMenuHandle | null>;
  /**
   * The phone mount: every ✕ drawn, in flow, 25 × 28px reach on each, 28px on
   * the opener and on Reset. (The desktop mount takes the same layout under a
   * coarse pointer, from the stylesheet.)
   */
  touch?: boolean;
  /**
   * The narrowest width the shelf lays itself out at, in px, for a mount whose
   * column animates through narrower widths than it ever rests at (the
   * sidebar's fold), so the paragraph does not re-wrap on every frame of it.
   */
  floor?: number;
  /**
   * The mount's own insets, merged over the root's. The canvas capsule passes
   * contain-inline-size so the paragraph takes the capsule's width rather than
   * giving it one.
   */
  className?: string;
}) {
  // Held out here, where it outlives any one body: a pick can take the shelf
  // away and another bring it back while the menu stays open, and the menu
  // reads this ref only as it closes, so focus goes to whichever opener is
  // on screen by then.
  const openerRef = useRef<HTMLButtonElement>(null);
  const { clauses } = useDisplaySummary(surface);
  // The summary guarantees `activeCount > 0` exactly when there are clauses, so
  // this is the dot's own condition.
  if (clauses.length === 0) return null;
  // The body is its own component so its hooks (the media query useIsMobile
  // subscribes to among them) run only while the shelf shows.
  return (
    <ShelfBody
      surface={surface}
      menu={menu}
      touch={touch}
      floor={floor}
      className={className}
      clauses={clauses}
      openerRef={openerRef}
    />
  );
}

/* ── the paragraph ──────────────────────────────────────────────────────────
 *
 * Three spacings, and the eye groups by them, glyph to glyph:
 *
 *   · a filter's values, 16px apart,
 *   · one phrase and the next ("Grouped by Project   Sorted by Priority"),
 *     20px — the muted lead words already say where a phrase starts,
 *   · a SEAM, 28px, wherever a filter meets what is next to it, so the sort
 *     never reads on into "● High ● Medium" and one filter's values never run
 *     on into the next's. Never between two phrases.
 *
 * Lines 5px apart. A setting is one flex item; a filter is one flex item that
 * wraps inside itself only when it is wider than a whole line, so its values
 * break apart only when they must. A phrase longer than a line ellipsizes.
 *
 * A seam is a margin on the setting BEFORE it, not a gap, so a line never
 * starts indented; at the end of a line it costs at most its 8px of room.
 *
 * On a fine pointer a ✕ takes no room of its own. It is drawn in the gap after
 * its setting, 1px off the words, which is what the 16 is sized for (15 in the
 * class, plus the words' 1px of padding, around a 14px ✕), and the last one on
 * a line hangs into the shelf's right inset (14px on the canvas, 15 in the
 * sidebar). Everything here is in px, the ✕ included: the 11px type does not
 * follow the browser's font-size setting, so neither may the room for a ✕.
 *
 * Where nothing hovers, the ✕ is in flow, 4px after its words, and the gaps
 * are measured from the ✕: 10 between values, 16 between phrases, 24 at a
 * seam. The phone mount says so with `touch`; the desktop mount gets the same
 * classes under `pointer-coarse:`, from the stylesheet, so a tablet never
 * paints a frame of the pointer layout first.
 */

/** The words: one wrapping paragraph, over the opener. */
const FLOW = 'pointer-events-none relative flex min-w-0 flex-1 flex-wrap items-start gap-y-[5px]';
const FLOW_GAP = { fine: 'gap-x-[19px] pointer-coarse:gap-x-[16px]', touch: 'gap-x-[16px]' };
/** One phrase setting. */
const CLAUSE = 'inline-flex min-w-0 max-w-full items-center';
/** A filter's run of values, which wraps only between one another. */
const MULTI = 'inline-flex min-w-0 max-w-full flex-wrap items-start gap-y-[5px]';
const MULTI_GAP = { fine: 'gap-x-[15px] pointer-coarse:gap-x-[10px]', touch: 'gap-x-[10px]' };
/**
 * The extra room at a seam, as a margin on the setting before it. Never
 * shrunk: a filter wider than a line is already the line's whole width, and
 * the margin must hang past it rather than take 8px from its values.
 */
const SEAM = 'mr-[8px] shrink-0';
/**
 * One removable thing — a phrase or a value — and the pointer's target for its
 * ✕. It takes the pointer, where the words of the old layout let it through to
 * the opener underneath, so it says what the opener did: the arrow, not a text
 * cursor, and no selection from a drag, a double-click or a long press.
 */
const UNIT =
  'group/unit pointer-events-auto relative inline-flex min-w-0 max-w-full cursor-default select-none items-center';
/** A unit's words: 1px of padding on a fine pointer, so its ✕ starts clear of the last glyph. */
const WORDS_PAD = { fine: 'pr-px pointer-coarse:pr-0', touch: '' };
/**
 * The last PHRASE and Reset: one unbreakable pair that grows to the end of its
 * line, with Reset pushed to that end. A phrase is one word to the wrap, so
 * holding Reset to it splits nothing, and after a phrase Reset never takes a
 * line alone. (After a filter it is the run's own last item instead: see
 * Clause.)
 */
const TAIL = 'inline-flex min-w-0 max-w-full grow items-center';
/**
 * Reset's slot: pushed to the end of its line, never nearer the words than
 * 24px on a fine pointer (9px clear of a drawn ✕) or 16px past an in-flow ✕.
 * After a phrase the padding is all of that; at the end of a filter, where
 * Reset is the run's last item and may wrap on its own rather than take the
 * last value with it, the run's own gap is part of it.
 */
const RESET_SLOT = 'ml-auto flex shrink-0';
const RESET_PAD = {
  phrase: { fine: 'pl-[23px] pointer-coarse:pl-[16px]', touch: 'pl-[16px]' },
  filter: { fine: 'pl-[8px] pointer-coarse:pl-[6px]', touch: 'pl-[6px]' },
};

/** The words the arrangement and type clauses lead with, as `clauseText` spells them. */
const LEAD = { group: 'Grouped by', sort: 'Sorted by', type: 'Showing' } as const;

/** The settings with values of their own; a seam falls on either side of one. */
function isFilter(c: DisplayClause | undefined): boolean {
  return c?.id === 'priority' || c?.id === 'project' || c?.id === 'goal';
}

/**
 * The opener's description: the section each value belongs to, which the
 * glyphs say to the eye and the visible text never says in words.
 */
function shelfDescription(clauses: DisplayClause[]): string {
  const nouns = clauses.flatMap((c) =>
    c.id === 'priority' || c.id === 'project' || c.id === 'goal'
      ? [`${c.noun}: ${c.values.map((v) => v.label).join(', ')}.`]
      : []
  );
  return ['Display settings.', ...nouns].join(' ');
}

/** A value's mark: the menu row's own for priorities and projects, Target for goals. */
function Glyph({ glyph }: { glyph: DisplayGlyph }) {
  switch (glyph.kind) {
    case 'dot':
      return <PriorityDot value={glyph.value} />;
    case 'ring':
      return <PriorityDot value={NO_PRIORITY} />;
    case 'square':
      return <ContainerSquare color={glyph.color} />;
    case 'target':
      return <Target className="size-[11px] shrink-0 text-muted-foreground" aria-hidden />;
  }
}

/** A ✕'s accessible name: the setting it takes off, with its section's noun for a value. */
function removeLabel(c: DisplayClause, valueLabel?: string): string {
  return 'noun' in c && valueLabel !== undefined
    ? `Remove ${c.noun}: ${valueLabel}`
    : `Remove ${clauseText(c)}`;
}

type Remove = (removal: DisplayRemoval, label: string) => React.ReactNode;

/**
 * One setting as the shelf draws it. The words are aria-hidden: the opener
 * underneath says all of them as its name, so what a screen reader meets here
 * is the ✕s alone. Each phrase and value is a pointer target of its own (the
 * ✕ shows for the one under the pointer), and a click on its words opens the
 * menu, as a click on the opener does. `seam` sets it apart from the next
 * setting; `tail` is Reset, for the last one.
 */
function Clause({
  clause: c,
  remove,
  open,
  touch,
  seam,
  tail,
}: {
  clause: DisplayClause;
  remove: Remove;
  open: () => void;
  touch: boolean;
  seam: boolean;
  tail?: React.ReactNode;
}) {
  const mode = touch ? 'touch' : 'fine';
  /** Under the pointer, or with its ✕ focused, the setting's words take full ink; lead words stay muted. */
  const hot =
    !touch && 'group-hover/unit:text-foreground group-has-[:focus-visible]/unit:text-foreground';
  const unit = (
    key: string | undefined,
    label: React.ReactNode,
    x: React.ReactNode,
    glyphed = false
  ) => (
    <span key={key} data-value={key} className={UNIT} onClick={open}>
      <span
        data-chip-label=""
        aria-hidden
        className={cn(
          glyphed ? 'inline-flex min-w-0 items-center gap-1' : 'min-w-0 truncate',
          WORDS_PAD[mode],
          hot
        )}
      >
        {label}
      </span>
      {x}
    </span>
  );
  const slot = (kind: 'phrase' | 'filter') =>
    tail ? <span className={cn(RESET_SLOT, RESET_PAD[kind][mode])}>{tail}</span> : null;
  /** The last phrase, held to Reset. */
  const phrase = (node: React.ReactNode) =>
    tail ? (
      <span className={TAIL}>
        {node}
        {slot('phrase')}
      </span>
    ) : (
      node
    );
  const root = (base: string) => cn(base, seam && SEAM, tail && 'grow');
  switch (c.id) {
    case 'group':
    case 'sort':
    case 'type':
      return (
        <span data-clause={c.id} className={root(CLAUSE)}>
          {phrase(
            unit(
              undefined,
              <>
                <span className="font-normal text-muted-foreground">{LEAD[c.id]}</span> {c.label}
              </>,
              remove({ id: c.id }, removeLabel(c))
            )
          )}
        </span>
      );
    case 'hide-finished':
      return (
        <span data-clause={c.id} className={root(CLAUSE)}>
          {phrase(unit(undefined, clauseText(c), remove({ id: c.id }, removeLabel(c))))}
        </span>
      );
    case 'priority':
    case 'project':
    case 'goal':
      return (
        <span data-clause={c.id} className={root(cn(MULTI, MULTI_GAP[mode]))}>
          {c.values.map((v) =>
            unit(
              v.key,
              <>
                <Glyph glyph={v.glyph} />
                <span className="truncate">{v.label}</span>
              </>,
              remove({ id: c.id, key: v.key }, removeLabel(c, v.label)),
              true
            )
          )}
          {slot('filter')}
        </span>
      );
  }
}

/**
 * Focus, drawn INSIDE the control's own box, in the app's ring colour (the
 * base layer's outline-ring/50; only the shape changes): a 1.5px line. On a
 * ✕ it sits 2px in, so it clears the words 1px to its left and the next
 * value's glyph 1px to its right by 3px each; Reset has room around it, so
 * its line runs on its own edge.
 */
const FOCUS_RING = 'focus-visible:outline-solid focus-visible:outline-[1.5px]';
const FOCUS_IN = { x: 'focus-visible:outline-offset-[-2px]', reset: 'focus-visible:outline-offset-[-1.5px]' };

/** A ✕ or Reset's 28px reach where nothing hovers, around a box of its own. */
const X_REACH = {
  touch:
    "pointer-events-auto relative ml-[4px] before:absolute before:-left-[4px] before:-right-[7px] before:-inset-y-[5px] before:content-['']",
  // The same, for the desktop mount under a coarse pointer. Literal, so the
  // stylesheet has every one of them.
  coarse:
    "pointer-coarse:pointer-events-auto pointer-coarse:relative pointer-coarse:left-auto pointer-coarse:top-auto pointer-coarse:ml-[4px] pointer-coarse:text-muted-foreground pointer-coarse:before:absolute pointer-coarse:before:-left-[4px] pointer-coarse:before:-right-[7px] pointer-coarse:before:-inset-y-[5px] pointer-coarse:before:content-['']",
};
const RESET_REACH = {
  touch: "relative before:absolute before:-inset-x-[6px] before:-inset-y-[5px] before:content-['']",
  coarse:
    "pointer-coarse:relative pointer-coarse:before:absolute pointer-coarse:before:-inset-x-[6px] pointer-coarse:before:-inset-y-[5px] pointer-coarse:before:content-['']",
};
const OPENER_REACH = {
  touch: "before:absolute before:inset-x-0 before:-inset-y-[5px] before:content-['']",
  coarse:
    "pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-[5px] pointer-coarse:before:content-['']",
};

function ShelfBody({
  surface,
  menu,
  touch,
  floor,
  className,
  clauses,
  openerRef,
}: {
  surface: DisplaySurface;
  menu: React.RefObject<DisplayMenuHandle | null>;
  touch: boolean;
  floor: number | undefined;
  className: string | undefined;
  clauses: DisplayClause[];
  openerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  // The hook DisplayMenu picks its shell with, so the popup this announces is
  // the one that opens. `touch` is the mount's, and only shapes targets.
  const isTouch = useIsMobile();
  const descId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const text = clauses.map(clauseText).join('; ');
  const open = () => menu.current?.open(openerRef);
  const mode = touch ? 'touch' : 'fine';

  /**
   * The header's tooltip, which every icon-only control in it wears. None on
   * the phone, where no hover earns one and a tap would pop it over the thumb.
   * A click passes through it: a ✕'s tip hangs over the line below, and moving
   * down to press something there pressed the tip instead.
   */
  const tipped = (label: string, button: React.ReactElement) =>
    touch ? (
      button
    ) : (
      <RailTooltip side="bottom" label={label} passThrough>
        {button}
      </RailTooltip>
    );

  /**
   * One setting's ✕. Its own setting is all it takes off, so its button
   * unmounts under the press, and focus is handed on FIRST, as Reset's is: to
   * the next setting's ✕, or the one before it when this was the last, or to
   * the trigger when nothing else is left and the shelf is about to go. Never
   * to Reset, which goes once fewer than four things are left to take off.
   * Every other setting's ✕ survives the removal — the model takes off exactly
   * the one value named (display-summary.test.ts holds it to that over every
   * combination) and each ✕ is keyed by what it names.
   */
  const removeButton = (removal: DisplayRemoval, label: string) => (
    <button
      type="button"
      data-shelf-remove=""
      data-testid={`display-shelf-remove-${surface}`}
      aria-label={label}
      // A HELD Enter would otherwise clear the whole shelf: each press hands
      // focus to the next ✕, and the key's autorepeat presses that one too.
      // Space activates on release, so it cannot repeat.
      onKeyDown={(e) => {
        if (e.repeat && e.key === 'Enter') e.preventDefault();
      }}
      onClick={(e) => {
        // Its setting's words open the menu; the ✕ must not.
        e.stopPropagation();
        const all = Array.from(
          rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-shelf-remove]') ?? []
        );
        const i = all.indexOf(e.currentTarget);
        const next = all[i + 1] ?? all[i - 1];
        if (next) next.focus();
        else menu.current?.focus();
        removeDisplaySetting(surface, removal);
      }}
      className={cn(
        'grid h-[18px] w-[14px] shrink-0 place-items-center rounded-[4px] text-muted-foreground hover:bg-accent hover:text-foreground',
        FOCUS_RING,
        FOCUS_IN.x,
        touch
          ? X_REACH.touch
          : // In the gap after its words, from the setting's own edge (the
            // words' 1px of padding past their last glyph). Clear ink AND no
            // hit until its setting is under the pointer: the gap is the
            // opener's ground, so a click aimed between two settings opens the
            // menu and can never land on a ✕ that was not drawn when the
            // pointer arrived. Once its setting is under the pointer the ✕ takes
            // hits too, and the two boxes touch, so a sweep from the words onto
            // the ✕ keeps both lit with no dead ground to cross. The 1px keeps
            // the hit boundary off the last glyph (Chromium snaps a fractional
            // edge up to half a pixel in), so a click on a name's last pixel
            // opens the menu. Keyboard focus reaches it regardless and draws it
            // (and a drawn ✕ takes a click); under the pointer as well, it takes
            // the full ink a plain hover gives (hover:focus-visible: outranks the
            // focus rule, which would otherwise keep it muted). Forced colours
            // (Windows High Contrast) paint clear ink in a system colour, so
            // there every ✕ is drawn at rest, and takes its hit at rest too: ink
            // and hits always come back together. Under a coarse pointer, which
            // never hovers, it is the phone's ✕ instead: in flow, drawn, with
            // reach.
            cn(
              'pointer-events-none absolute left-full top-0 text-transparent group-hover/unit:pointer-events-auto group-hover/unit:text-muted-foreground focus-visible:pointer-events-auto focus-visible:text-muted-foreground hover:focus-visible:text-foreground forced-colors:pointer-events-auto',
              X_REACH.coarse
            )
      )}
    >
      <X className="size-[10px]" aria-hidden />
    </button>
  );

  const remove: Remove = (removal, label) => tipped('Remove', removeButton(removal, label));

  /** How many ✕s the settings wear: one per phrase, one per value. */
  const removable = clauses.reduce((n, c) => n + ('values' in c ? c.values.length : 1), 0);

  /**
   * Reset display, at the end of the paragraph: the menu row's own function
   * and the menu row's own glyph, so it reads as an action wherever the line
   * leaves it, never as one more setting. Named in words for a screen reader
   * and, on a pointer, in its tip. Only from four things to take off up (see
   * the top of the file).
   */
  const reset =
    removable > 3
      ? tipped(
          'Reset display',
          <button
            type="button"
            data-testid={`display-shelf-reset-${surface}`}
            aria-label="Reset display"
            onClick={(e) => {
              e.stopPropagation();
              // Focus to the trigger FIRST: a reset takes the count to zero, so
              // the shelf unmounts under the pressed button.
              menu.current?.focus();
              resetDisplay(surface);
            }}
            className={cn(
              'pointer-events-auto grid h-[18px] w-[16px] shrink-0 place-items-center rounded-[4px] text-muted-foreground hover:bg-accent hover:text-foreground',
              FOCUS_RING,
              FOCUS_IN.reset,
              touch ? RESET_REACH.touch : RESET_REACH.coarse
            )}
          >
            <RotateCcw className="size-[11px]" aria-hidden />
          </button>
        )
      : undefined;

  const lastIndex = clauses.length - 1;

  return (
    <div
      ref={rootRef}
      data-testid={`display-shelf-${surface}`}
      className={cn(
        'relative flex items-start px-[15px] pb-[3px] pt-2 text-[11px] font-medium leading-[18px] text-secondary-foreground',
        className
      )}
      style={floor === undefined ? undefined : { minWidth: floor }}
    >
      <div className="relative flex min-w-0 flex-1">
        {/* The opener, UNDER the words rather than around them: a button
            cannot hold the ✕ buttons, so it covers the paragraph's box from
            behind, and takes the clicks that land between the words (a click
            on the words opens the menu through the same handle). It is the
            keyboard's and the screen reader's way in, named by the same text,
            said once, in its own sr-only copy — the words on screen are
            aria-hidden — so what a voice-control user reads off the screen is
            what they can say (WCAG 2.5.3, Label in Name). No aria-expanded:
            what opens is modal, and hides this whole section while it is up.
            Outside the paragraph's box, so its focus ring is not clipped. */}
        <button
          type="button"
          data-testid={`display-shelf-open-${surface}`}
          aria-haspopup={isTouch ? 'dialog' : 'menu'}
          aria-describedby={descId}
          // The menu the trigger opens, opened the way the trigger opens it: the
          // handle picks the shell. Handing over the ref brings focus back here
          // on close, while this text is still on screen to take it.
          ref={openerRef}
          onClick={open}
          className={cn(
            'absolute inset-0 rounded-[4px]',
            touch ? OPENER_REACH.touch : OPENER_REACH.coarse
          )}
        >
          <span className="sr-only">{text}</span>
        </button>
        {/* The words, over the opener: `relative` so they paint above it, and
            pointer-events-none so a click in the gaps between the settings
            still lands on it; each setting takes its own pointer (UNIT). */}
        <span data-shelf-lines="" className={cn(FLOW, FLOW_GAP[mode])}>
          {clauses.map((c, i) => (
            <Clause
              key={c.id}
              clause={c}
              remove={remove}
              open={open}
              touch={touch}
              seam={i < lastIndex && (isFilter(c) || isFilter(clauses[i + 1]))}
              tail={i === lastIndex ? reset : undefined}
            />
          ))}
        </span>
      </div>
      {/* Hidden rather than sr-only: each value's ✕ says its noun in the
          reading order, so this is for the opener's description alone, which
          aria-describedby reads from a hidden node just the same. */}
      <span id={descId} hidden>
        {shelfDescription(clauses)}
      </span>
    </div>
  );
}
