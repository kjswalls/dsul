'use client';

import { Fragment, useEffect, useId, useLayoutEffect, useRef } from 'react';
import { Target, X } from 'lucide-react';
import {
  ContainerSquare,
  PriorityDot,
  type DisplayMenuHandle,
} from '@/components/primitives/display-menu';
import { RailTooltip } from '@/components/primitives/pills';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  clauseText,
  resetDisplay,
  useDisplaySummary,
  type DisplayClause,
  type DisplayGlyph,
  type DisplaySurface,
} from '@/lib/display-summary';
import { NO_PRIORITY } from '@/lib/filters';
import { SIDEBAR_MIN_WIDTH } from '@/lib/sidebar-store';
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
 * text is a single button that opens the menu, and the ✕ beside it IS "Reset
 * display", the same function the menu's row calls.
 *
 * No opacity and no transition anywhere in it. The Low dot is --priority-low
 * and a project square can be --accent-8, both lime: they are data glyphs, drawn
 * at rest exactly as the list's own priority bars and the menu's squares are,
 * and the surface's lime CHROME is still the trigger dot alone. No live region
 * and no heading either — the menu it opens is modal, so nothing here changes
 * while a screen reader could be reading it.
 */
export function DisplayShelf({
  surface,
  menu,
  touch = false,
}: {
  surface: DisplaySurface;
  /** The menu this shelf describes. Read in handlers only — see DisplayMenuHandle. */
  menu: React.RefObject<DisplayMenuHandle | null>;
  /**
   * The phone mount: 28px hit areas on both buttons, and no width floor, since
   * a phone tab has no collapsing column to ride out (see the root's style).
   */
  touch?: boolean;
}) {
  const { clauses } = useDisplaySummary(surface);
  // The summary guarantees `activeCount > 0` exactly when there are clauses, so
  // this is the dot's own condition.
  if (clauses.length === 0) return null;
  // The body is its own component so its measuring effects mount and unmount
  // with the shelf rather than idling behind a null render.
  return <ShelfBody surface={surface} menu={menu} touch={touch} clauses={clauses} />;
}

/* ── the lines ──────────────────────────────────────────────────────────────
 *
 * One line while everything fits, settings 16px apart. Otherwise a stack:
 * grouping and ordering share the first line, as the arrangement of the list,
 * then one line per filter, then Hide finished. Every rule for the stack keys
 * off `data-fit="stack"` on the root (see "fit" below), so both layouts are the
 * same DOM — the width never changes what a screen reader reads.
 */

/** A line of the stack; inside the one line, just a run of clauses. */
const LINE =
  'flex shrink-0 gap-x-4 group-data-[fit=stack]/shelf:min-w-0 group-data-[fit=stack]/shelf:shrink group-data-[fit=stack]/shelf:flex-wrap';
/** Grouping, ordering, Hide finished: one phrase, which ellipsizes rather than wraps. */
const SINGLE =
  'shrink-0 whitespace-nowrap group-data-[fit=stack]/shelf:min-w-0 group-data-[fit=stack]/shelf:max-w-full group-data-[fit=stack]/shelf:truncate';
/**
 * A multi-select's values, which wrap only BETWEEN one another. `shrink` in the
 * stack is load-bearing: a clause that kept `shrink-0` there held its one-line
 * width, and the values past the column's edge were clipped rather than wrapped.
 */
const MULTI =
  'flex shrink-0 gap-x-2.5 group-data-[fit=stack]/shelf:min-w-0 group-data-[fit=stack]/shelf:shrink group-data-[fit=stack]/shelf:flex-wrap';

/** The words the arrangement clauses lead with, as `clauseText` spells them. */
const LEAD = { group: 'Grouped by', sort: 'Sorted by' } as const;

type ShelfLine = { id: string; clauses: DisplayClause[] };

/** Grouping and ordering share the first line; every other clause is a line of its own. */
function shelfLines(clauses: DisplayClause[]): ShelfLine[] {
  const lines: ShelfLine[] = [];
  for (const c of clauses) {
    const id = c.id === 'group' || c.id === 'sort' ? 'arrange' : c.id;
    const line = lines.find((l) => l.id === id);
    if (line) line.clauses.push(c);
    else lines.push({ id, clauses: [c] });
  }
  return lines;
}

/**
 * The button's description: the section each value belongs to, which the
 * glyphs say to the eye and the visible text never says in words — "High" and
 * "Work" read the same to a screen reader until something names them.
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

function Clause({ clause: c }: { clause: DisplayClause }) {
  switch (c.id) {
    case 'group':
    case 'sort':
      return (
        <span data-clause={c.id} className={SINGLE}>
          <span className="font-normal text-muted-foreground">{LEAD[c.id]}</span> {c.label}
        </span>
      );
    case 'type':
    case 'hide-finished':
      return (
        <span data-clause={c.id} className={SINGLE}>
          {clauseText(c)}
        </span>
      );
    case 'priority':
    case 'project':
    case 'goal':
      return (
        <span data-clause={c.id} className={MULTI}>
          {c.values.map((v, i) => (
            <Fragment key={v.key}>
              <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                <Glyph glyph={v.glyph} />
                <span className="truncate">{v.label}</span>
              </span>
              {/* sr-only is absolutely positioned, so it is no flex item and
                  takes no gap: the pause is for the accessible name alone. */}
              {i < c.values.length - 1 && <span className="sr-only">{', '}</span>}
            </Fragment>
          ))}
        </span>
      );
  }
}

/* ── fit: one line, or the stack ────────────────────────────────────────────
 *
 * Whether the text fits on one line is a fact about layout, and it changes on
 * every frame of a sash drag without React hearing of it — the column is resized
 * through a CSS variable precisely so that the braindump does not re-render 60
 * times a second. So it is not state. The shelf writes `data-fit` on its own
 * root, React never renders the attribute (so no render can reset it), and with
 * no attribute at all the one-line layout applies.
 *
 * The one-line width is MEASURED once per change of text, and a resize only
 * COMPARES that number with the width on offer. Measuring means forcing the
 * one-line layout; doing that inside ResizeObserver delivery is how a measure →
 * resize → measure loop starts, and the "ResizeObserver loop" errors it raises
 * land on every other observer on the page.
 */

/**
 * The width the clauses take laid out on ONE line, whatever the column's width.
 *
 * In the one-line layout every line and clause is shrink-0, so the span from
 * the first line's left edge to the last one's right edge is a property of the
 * text alone. Rects rather than `scrollWidth`, which clamps to `clientWidth`
 * whenever the content fits and so cannot say by how much.
 */
function measureLineWidth(root: HTMLElement, lines: HTMLElement): number {
  root.dataset.fit = 'line';
  const rows = Array.from(lines.children).filter((el) => el.hasAttribute('data-line'));
  if (rows.length === 0) return 0;
  return rows[rows.length - 1].getBoundingClientRect().right - rows[0].getBoundingClientRect().left;
}

/**
 * The stack if the measured line would overflow the lines box, one line if not.
 * The box is flex-1 min-w-0 in both layouts, so its width is the column's answer
 * and never the fit's own. Written only on a change, so a drag that crosses no
 * threshold writes nothing at all.
 */
function applyFit(root: HTMLElement, lines: HTMLElement, lineWidth: number): void {
  const fit = lineWidth > lines.getBoundingClientRect().width + 0.5 ? 'stack' : 'line';
  if (root.dataset.fit !== fit) root.dataset.fit = fit;
}

function ShelfBody({
  surface,
  menu,
  touch,
  clauses,
}: {
  surface: DisplaySurface;
  menu: React.RefObject<DisplayMenuHandle | null>;
  touch: boolean;
  clauses: DisplayClause[];
}) {
  // The hook DisplayMenu picks its shell with, so the popup this announces is
  // the one that opens. `touch` is the mount's, and only sizes targets.
  const isTouch = useIsMobile();
  const descId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const linesRef = useRef<HTMLSpanElement>(null);
  /** The current text's one-line width; 0 until something laid out has been measured. */
  const lineWidth = useRef(0);

  // The FULL text, every value in it: adding a value to an open multi-select
  // lengthens the line without adding a clause, and a key that missed it would
  // leave the added value clipped.
  const text = clauses.map(clauseText).join('; ');
  const lines = shelfLines(clauses);
  const lastClause = clauses[clauses.length - 1];

  // Before paint, so a change of text never shows a frame in the wrong fit.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const box = linesRef.current;
    if (!root || !box) return;
    lineWidth.current = measureLineWidth(root, box);
    applyFit(root, box, lineWidth.current);
  }, [text]);

  // Once on mount: a web font that swaps in late changes every width without
  // resizing anything, so no observer would hear of it. (jsdom has no
  // `document.fonts`.)
  useEffect(() => {
    let alive = true;
    document.fonts?.ready.then(() => {
      const root = rootRef.current;
      const box = linesRef.current;
      if (!alive || !root || !box) return;
      lineWidth.current = measureLineWidth(root, box);
      applyFit(root, box, lineWidth.current);
    });
    return () => {
      alive = false;
    };
  }, []);

  // The observer watches the zero-height probe rather than the shelf: the
  // probe's width is the root's and nothing else, where the shelf's own box
  // changes height with the very fit this is deciding. Guarded: jsdom has no
  // ResizeObserver, suites mount an active braindump without stubbing one
  // (tests/unit/braindump-grouping.test.tsx), and a shelf with no observer
  // simply keeps the fit it measured.
  useEffect(() => {
    const root = rootRef.current;
    const probe = probeRef.current;
    const box = linesRef.current;
    if (typeof ResizeObserver === 'undefined' || !root || !probe || !box) return;
    const ro = new ResizeObserver(() => {
      // The one exception to comparing only: a shelf that mounted where
      // nothing is laid out (display:none, jsdom) measured 0, and measures once
      // here, the first time its lines box has a width to measure against.
      if (lineWidth.current === 0 && box.getBoundingClientRect().width > 0) {
        lineWidth.current = measureLineWidth(root, box);
      }
      applyFit(root, box, lineWidth.current);
    });
    ro.observe(probe);
    return () => ro.disconnect();
  }, []);

  const resetButton = (
    <button
      type="button"
      data-testid={`display-shelf-reset-${surface}`}
      aria-label="Reset display"
      onClick={() => {
        // Focus goes to the trigger FIRST. A reset always takes the count to
        // zero, so the shelf unmounts under the pressed button, and a focused
        // element that unmounts leaves focus on <body>.
        menu.current?.focus();
        resetDisplay(surface);
      }}
      className={cn(
        'grid h-[18px] w-4 shrink-0 place-items-center rounded-[4px] text-muted-foreground hover:bg-accent hover:text-foreground',
        touch && "relative before:absolute before:-inset-x-[6px] before:-inset-y-[5px] before:content-['']"
      )}
    >
      <X className="size-[11px]" aria-hidden />
    </button>
  );

  return (
    <div
      ref={rootRef}
      data-testid={`display-shelf-${surface}`}
      className="group/shelf relative flex items-start gap-2 px-[15px] pb-[3px] pt-2 text-[11px] font-medium leading-[18px] text-secondary-foreground"
      // The sidebar shelf keeps the fit of the narrowest column it can have.
      // Collapse and hover-peek animate the column between w-0 and its width
      // over 300ms with the braindump still mounted, so without a floor every
      // frame of the fold would re-fit, and the collapsed shelf would sit in a
      // one-value-per-row stack that every expand then unfolds from. At rest
      // the floor never binds — the column is never narrower than
      // SIDEBAR_MIN_WIDTH, less the capsule's 10px sides — and while it folds,
      // the column's own overflow clips the rest.
      style={touch ? undefined : { minWidth: SIDEBAR_MIN_WIDTH - 20 }}
    >
      <span
        ref={probeRef}
        data-shelf-probe=""
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-0"
      />
      {/* No aria-label: the name is the visible text, so what a voice-control
          user reads off the screen is what they can say (WCAG 2.5.3, Label in
          Name). The sr-only separators give that name its pauses, and the
          description carries the nouns. No aria-expanded either: what opens is
          modal, and hides this whole section while it is up. */}
      <button
        type="button"
        data-testid={`display-shelf-open-${surface}`}
        aria-haspopup={isTouch ? 'dialog' : 'menu'}
        aria-describedby={descId}
        // The menu the trigger opens, opened the way the trigger opens it: the
        // handle picks the shell. Handing itself over brings focus back here
        // on close, while this text is still on screen to take it.
        onClick={(e) => menu.current?.open(e.currentTarget)}
        className={cn(
          'relative flex min-w-0 flex-1 text-left hover:text-foreground',
          // The hit area rides on the BUTTON, while the clipping is the lines
          // box's inside it, so the 28px reach is never cut off.
          touch && "before:absolute before:inset-x-0 before:-inset-y-[5px] before:content-['']"
        )}
      >
        <span
          ref={linesRef}
          data-shelf-lines=""
          className="flex min-w-0 flex-1 gap-x-4 overflow-hidden group-data-[fit=stack]/shelf:flex-col group-data-[fit=stack]/shelf:gap-y-[5px]"
        >
          {lines.map((line) => (
            <span key={line.id} data-line={line.id} className={LINE}>
              {line.clauses.map((c) => (
                <Fragment key={c.id}>
                  <Clause clause={c} />
                  {c !== lastClause && <span className="sr-only">{'; '}</span>}
                </Fragment>
              ))}
            </span>
          ))}
        </span>
      </button>
      <span id={descId} className="sr-only">
        {shelfDescription(clauses)}
      </span>
      {/* The header's tooltip, which every icon-only control in it wears; the
          text beside it names itself, so it has none. None on the phone, where
          no hover earns one and a tap would pop it over the thumb. */}
      {touch ? (
        resetButton
      ) : (
        <RailTooltip side="bottom" label="Reset display">
          {resetButton}
        </RailTooltip>
      )}
    </div>
  );
}
