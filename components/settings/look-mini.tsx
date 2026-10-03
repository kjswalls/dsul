'use client';

import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { addDays, format } from 'date-fns';
import { Check } from 'lucide-react';
import { BucketCard } from '@/components/primitives/bucket-card';
import { layoutAttributes, type LayoutDef } from '@/lib/layout-themes';
import {
  DEFAULT_DARK_LOOK,
  DEFAULT_LIGHT_LOOK,
  type DarkLook,
  type LightLook,
  type LookMode,
} from '@/lib/theme-looks';
import { DEFAULT_PALETTE, type ThemePalette } from '@/lib/theme-palettes';
import type { BucketStyle, TypeMode } from '@/lib/view-store';
import { cn } from '@/lib/utils';

/**
 * A miniature dsul in any theme, tint and layout: the Look pane's previews,
 * its Looks cards and the chips on its theme swatches.
 *
 * THEME. Every token resolves on <html>, so a subtree cannot show a theme that
 * is not the live one by attributes alone. The preview root carries
 * `data-theme-preview` and the picks it draws, and app/globals.css lists that
 * root beside :root on every base block and gives every palette and theme block
 * a twin keyed on it ("Theme previews" there has the whole contract). So the
 * root re-resolves the token chain exactly as <html> does, and everything
 * inside reads the previewed values through the same utilities the app uses.
 *
 * LAYOUT. The styled slots are plain `[data-layout-<slot>]` rules, so the shell
 * div stamps layoutAttributes(def) and every one of them applies unchanged: the
 * bucket captions, the ticks, the headers, the type, Retro's skin. The
 * structural slots (where the braindump sits, the capture, the canvas, the
 * tabs, the ornaments) live in DesktopShell's own markup, so they are drawn
 * here by hand from def.slots, never by asking useLayoutDef(), which only
 * knows the live layout.
 *
 * WHAT IS REAL. The bucket is the actual BucketCard (no dnd, reads view-store
 * only, `collapsible={false}` so a bucket shut on the grid cannot empty it).
 * The rows are hand-built with the hooks the rows slot's CSS keys on (the
 * item-card and item-complete-button test ids, data-checked, data-completed,
 * a <p> title), because the real TaskRow is live-wired to the selection, the
 * item panel and the confirm dialog. Every word is fixture text: /settings
 * never loads items (tests/unit/route-data.test.ts).
 *
 * It is a picture. aria-hidden, inert, no interactive element anywhere inside,
 * so a caller can lay a button over it without nesting one control in another.
 */

/** The size the miniature is drawn at before it is scaled to its box. */
export const MINI_W = 560;
export const MINI_H = 380;

/**
 * The attributes that make an element a theme preview root. Exported for the
 * swatch chips, which are previews too (one ground, two ink lines, the accent).
 * A tint only rides Paper and Night, as on <html>.
 */
export function themeScope(
  mode: LookMode,
  picks: { light: LightLook; dark: DarkLook; tint: ThemePalette }
): Record<string, string | undefined> {
  const theme = mode === 'light' ? picks.light : picks.dark;
  const plain = mode === 'light' ? theme === DEFAULT_LIGHT_LOOK : theme === DEFAULT_DARK_LOOK;
  return {
    'data-theme-preview': '',
    'data-preview-light': mode === 'light' && !plain ? picks.light : undefined,
    'data-preview-dark': mode === 'dark' && !plain ? picks.dark : undefined,
    'data-preview-tint': plain && picks.tint !== DEFAULT_PALETTE ? picks.tint : undefined,
    'data-preview-mode': mode,
  };
}

/**
 * Serif titles, set directly. `data-type-mode` only works on <html> (and only
 * AppShell stamps it), and `var(--font-serif)` cannot be used here: Tailwind
 * declares it at :root, where next/font's --font-source-serif (a class on
 * <body>) does not exist yet, so it computes to nothing.
 */
const SERIF_VARS: CSSProperties = {
  ['--font-content' as string]: "var(--font-source-serif), 'Source Serif 4', Georgia, serif",
  ['--font-content-weight' as string]: '600',
};

export interface LookMiniProps {
  def: LayoutDef;
  mode: LookMode;
  light: LightLook;
  dark: DarkLook;
  tint: ThemePalette;
  bucketStyle: BucketStyle;
  typeMode: TypeMode;
  showCompleted: boolean;
  /** A phone's preview: the canvas alone. The phone has no layouts. */
  phone?: boolean;
  className?: string;
}

export function LookMini({
  def,
  mode,
  light,
  dark,
  tint,
  bucketStyle,
  typeMode,
  showCompleted,
  phone,
  className,
}: LookMiniProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  // Scaled imperatively: the box's width is the only input, and a state round
  // trip would draw one frame at the wrong size. Measured before paint, then
  // kept in step by a ResizeObserver (absent in jsdom, where the picture simply
  // stays hidden).
  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const fit = () => {
      // The padding box, where the inner is placed and clipped: the border
      // box would overhang the 1px border on the right and bottom.
      const width = outer.clientWidth;
      inner.style.transform = `scale(${width / MINI_W})`;
      inner.style.visibility = width > 0 ? 'visible' : 'hidden';
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(outer);
    return () => observer.disconnect();
  }, []);

  const scope = themeScope(mode, { light, dark, tint });

  return (
    <div
      ref={outerRef}
      aria-hidden
      inert
      className={cn('pointer-events-none relative w-full overflow-hidden select-none', className)}
      style={{ aspectRatio: `${MINI_W} / ${MINI_H}` }}
    >
      <div
        ref={innerRef}
        {...scope}
        className={cn('absolute top-0 left-0 origin-top-left', mode === 'dark' && 'dark')}
        style={{
          width: MINI_W,
          height: MINI_H,
          visibility: 'hidden',
          ...(typeMode === 'serif' ? SERIF_VARS : null),
        }}
      >
        {phone ? (
          <div className="bg-canvas flex h-full flex-col px-5 pt-5">
            <Canvas def={def} bucketStyle={bucketStyle} showCompleted={showCompleted} />
          </div>
        ) : (
          <Shell def={def} bucketStyle={bucketStyle} showCompleted={showCompleted} />
        )}
      </div>
    </div>
  );
}

/* ── fixture ─────────────────────────────────────────────────────────────── */

const THOUGHTS = ['Call the bank', 'Mum’s birthday', 'Bike light'];
const MORNING = [
  { title: 'Send the Q4 invoice', done: false },
  { title: 'Stretch for 10 minutes', done: true },
];
const AFTERNOON = [{ title: 'Groceries', done: false }];

/** A row, drawn with the hooks the `rows` slot's CSS keys on. */
function Row({ title, done = false, compact }: { title: string; done?: boolean; compact?: boolean }) {
  return (
    <div
      data-testid="item-card"
      data-completed={done ? 'true' : 'false'}
      className={cn(
        'relative flex w-full items-center gap-3 rounded-[5px] px-2',
        compact ? 'py-1' : 'py-1.5'
      )}
    >
      <span
        data-testid="item-complete-button"
        data-checked={done ? 'true' : 'false'}
        className={cn(
          'relative z-10 flex h-4 w-4 flex-shrink-0 items-center justify-center overflow-hidden rounded-[5px] border',
          done ? 'border-primary bg-primary' : 'border-muted-foreground/45 bg-surface-3'
        )}
      >
        {done && <Check className="text-primary-foreground h-2.5 w-2.5" />}
      </span>
      <p
        className={cn(
          'font-content text-content text-foreground line-clamp-1 min-w-0 flex-1',
          done && 'text-muted-foreground line-through opacity-60'
        )}
      >
        {title}
      </p>
    </div>
  );
}

function Header() {
  return (
    <div
      data-header-capsule=""
      className="bg-surface-3 inline-flex flex-col gap-1 self-start rounded-[10px] p-2 shadow-[var(--shadow-elev-bar)]"
    >
      <span
        data-testid="header-date"
        className="text-foreground px-1.5 font-sans text-base font-semibold whitespace-nowrap"
      >
        {format(new Date(), 'EEEE, MMMM d')}
      </span>
      <span
        data-header-pill=""
        className="bg-surface-2 text-muted-foreground flex items-center gap-3 rounded-[10px] px-3 py-1.5 font-sans text-xs shadow-[var(--shadow-elev-sm)]"
      >
        <span>Buckets</span>
        <span>Day</span>
      </span>
    </div>
  );
}

function Canvas({
  def,
  bucketStyle,
  showCompleted,
}: {
  def: LayoutDef;
  bucketStyle: BucketStyle;
  showCompleted: boolean;
}) {
  const morning = MORNING.filter((r) => showCompleted || !r.done);
  return (
    <div
      className={cn(
        'flex min-h-0 flex-col gap-4',
        def.slots.measure === 'narrow' && 'mx-auto w-full max-w-[300px]'
      )}
    >
      <Header />
      <div className="flex flex-col gap-4">
        <BucketCard bucket="morning" count={morning.length} variant={bucketStyle} collapsible={false}>
          <div className="flex flex-col">
            {morning.map((r) => (
              <Row key={r.title} title={r.title} done={r.done} />
            ))}
          </div>
        </BucketCard>
        <BucketCard
          bucket="afternoon"
          count={AFTERNOON.length}
          variant={bucketStyle}
          collapsible={false}
          isCurrent
        >
          <div className="flex flex-col">
            {AFTERNOON.map((r) => (
              <Row key={r.title} title={r.title} done={r.done} />
            ))}
          </div>
        </BucketCard>
      </div>
    </div>
  );
}

/** The braindump's title, with the hooks the masthead and plain headers key on. */
function BraindumpTitle() {
  return (
    <div
      data-surface-header=""
      className="bg-surface-3 shrink-0 rounded-[10px] px-[8px] py-[5px] shadow-[var(--shadow-elev-bar)]"
    >
      <div
        data-surface-pill=""
        className="bg-surface-2 flex h-[30px] items-center rounded-[10px] px-[12px] shadow-[var(--shadow-elev-sm)]"
      >
        <span data-surface-title="" className="text-foreground font-sans text-sm font-medium">
          Braindump
        </span>
      </div>
    </div>
  );
}

/** Where a thought is captured, per the `capture` slot. The bottom prompt is the shell's. */
function Capture({ def }: { def: LayoutDef }) {
  switch (def.slots.capture) {
    case 'dock':
      return (
        <div className="bg-surface-3 mt-auto rounded-[14px] p-[6px] shadow-[var(--shadow-elev-bar)]">
          <div className="bg-surface-2 text-muted-foreground flex h-[30px] items-center rounded-full px-3 font-sans text-xs shadow-[var(--shadow-elev-sm)]">
            Add a thought
          </div>
        </div>
      );
    case 'page-foot':
      return (
        <div
          className="text-muted-foreground mt-auto border-b border-[var(--nb-ink)] pb-0.5 text-[14px] italic"
          style={{ fontFamily: 'var(--font-serif-display)' }}
        >
          write a line…
        </div>
      );
    case 'caret':
      return (
        <div className="text-muted-foreground mt-auto flex items-center gap-1 px-2 text-xs">
          <span className="bg-primary inline-block h-[13px] w-[1.5px]" />
          Add a thought
        </div>
      );
    default:
      return null;
  }
}

function Braindump({ def, wordmark }: { def: LayoutDef; wordmark: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {wordmark && (
        <div className="text-foreground px-2 pt-0.5 font-sans text-[15px] font-semibold tracking-tight">
          dsul
        </div>
      )}
      <BraindumpTitle />
      <div className="flex flex-col">
        {THOUGHTS.map((t) => (
          <Row key={t} title={t} compact />
        ))}
      </div>
      <Capture def={def} />
    </div>
  );
}

function DayTabsStrip({ variant }: { variant: LayoutDef['slots']['tabs'] }) {
  const today = new Date();
  const name = (date: Date, on: boolean) =>
    variant === 'md'
      ? `${format(date, 'yyyy-MM-dd')}.md`
      : variant === 'txt'
        ? `${format(date, 'EEE, MMM d')}.txt`
        : format(date, on ? 'EEE d MMM' : 'EEE d');
  const tab = 'flex h-[28px] min-w-0 items-center gap-2 rounded-t-[8px] px-3 whitespace-nowrap';
  return (
    <div className="flex h-[34px] flex-shrink-0 items-end gap-0.5 pr-3 pl-3 font-mono text-[12px] font-medium">
      <span className={cn(tab, 'bg-canvas text-foreground')}>
        <span className="bg-success-text size-1.5 flex-none rounded-full" />
        braindump
      </span>
      <span className="ml-3 flex min-w-0 items-end gap-0.5">
        {[-1, 0, 1].map((offset) => (
          <span
            key={offset}
            className={cn(
              tab,
              offset === 0 ? 'bg-canvas text-foreground' : 'text-muted-foreground'
            )}
          >
            <span className="truncate">{name(addDays(today, offset), offset === 0)}</span>
          </span>
        ))}
      </span>
    </div>
  );
}

/** The window: the structural slots, drawn from def the way DesktopShell draws them. */
function Shell({
  def,
  bucketStyle,
  showCompleted,
}: {
  def: LayoutDef;
  bucketStyle: BucketStyle;
  showCompleted: boolean;
}) {
  const { slots, ornaments } = def;
  const canvas = <Canvas def={def} bucketStyle={bucketStyle} showCompleted={showCompleted} />;
  const drawer = slots.edge === 'tab';

  let body: ReactNode;
  if (slots.canvas === 'spread') {
    body = (
      <div className="flex h-full bg-[var(--nb-desk)] p-[14px] pr-[34px]">
        <div data-book="" className="relative flex min-w-0 flex-1 gap-3">
          <div className="w-[170px] flex-shrink-0 px-[14px] py-[12px] shadow-[inset_-22px_0_22px_-22px_var(--nb-spine)]">
            <Braindump def={def} wordmark={false} />
          </div>
          <div data-preview-canvas="" className="relative min-w-0 flex-1 overflow-hidden px-4 pt-3">
            {canvas}
          </div>
          {ornaments.includes('ribbon') && (
            <span
              className="absolute top-0 right-3 z-[5] h-[52px] w-[13px] bg-[var(--nb-ribbon)]"
              style={{ clipPath: 'polygon(0 0, 100% 0, 100% 100%, 50% 82%, 0 100%)' }}
            />
          )}
          {ornaments.includes('page-tabs') && (
            <div className="absolute top-[72px] left-full z-[5] flex flex-col gap-1.5 font-sans text-2xs font-semibold tracking-wide">
              <span className="rounded-r-[6px] bg-[var(--nb-ribbon)] py-1.5 pr-2 pl-1.5 text-[var(--nb-ribbon-ink)]">
                Day
              </span>
              <span className="text-muted-foreground rounded-r-[6px] bg-[var(--nb-tab)] py-1.5 pr-2 pl-1.5">
                Week
              </span>
            </div>
          )}
        </div>
      </div>
    );
  } else if (slots.canvas === 'sheet') {
    body = (
      <div className="flex h-full flex-col bg-[var(--np-chrome)]">
        {slots.tabs !== 'none' && <DayTabsStrip variant={slots.tabs} />}
        <div data-sheet="" className="bg-canvas relative flex min-h-0 flex-1">
          {drawer ? (
            // Writer: the braindump closed behind its tab on the page's edge,
            // drawn with the same hook the edge slot's CSS styles.
            <span
              data-testid="sidebar-expand-grip"
              className="absolute top-1/2 left-0 z-[5] flex items-center"
            />
          ) : (
            <div className="border-border w-[160px] flex-shrink-0 border-r px-3 pt-3 pb-2">
              <Braindump def={def} wordmark={false} />
            </div>
          )}
          <div
            data-preview-canvas=""
            className={cn('relative min-w-0 flex-1 overflow-hidden px-5 pt-4', drawer && 'pl-12')}
          >
            {canvas}
          </div>
        </div>
        {ornaments.includes('status-bar') && (
          <div className="border-border text-muted-foreground flex h-[26px] flex-shrink-0 items-center gap-5 border-t px-[18px] font-mono text-[11.5px] whitespace-nowrap">
            <span>
              <b className="text-foreground font-medium">4</b> items ·{' '}
              <b className="text-foreground font-medium">1</b> done
            </span>
            <span className="flex-1" />
            <span>Ln 3, Col 1</span>
            <span>UTF-8</span>
          </div>
        )}
        {ornaments.includes('page-count') && (
          <div className="bg-canvas text-muted-foreground flex h-9 flex-shrink-0 items-center justify-center font-mono text-xs whitespace-nowrap">
            <span>
              <b className="text-foreground font-normal">4</b> items ·{' '}
              <b className="text-foreground font-normal">1</b> done
            </span>
          </div>
        )}
      </div>
    );
  } else if (slots.canvas === 'flat') {
    body = (
      <div className="bg-canvas flex h-full flex-col">
        {ornaments.includes('status-line') && (
          <div className="border-border text-muted-foreground flex h-8 flex-shrink-0 items-center gap-5 border-b px-4 font-mono text-xs whitespace-nowrap">
            <span className="text-foreground font-semibold">dsul</span>
            <span className="text-success-text">{format(new Date(), 'EEE dd MMM').toLowerCase()}</span>
            <span>
              <span className="text-foreground">3</span> open · <span className="text-foreground">1</span> done
            </span>
            <span className="ml-auto tabular-nums">{format(new Date(), 'HH:mm')}</span>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          {slots.sidebar === 'left' && (
            <div className="border-border w-[160px] flex-shrink-0 border-r p-3">
              <Braindump def={def} wordmark />
            </div>
          )}
          <div data-preview-canvas="" className="relative min-w-0 flex-1 overflow-hidden px-5 pt-4">
            {canvas}
          </div>
          {slots.sidebar === 'pane-right' && (
            <div className="border-border w-[150px] flex-shrink-0 border-l px-3 pt-4">
              <Braindump def={def} wordmark={false} />
            </div>
          )}
        </div>
        {slots.capture === 'prompt-bottom' && (
          <div className="border-border text-muted-foreground flex h-9 flex-shrink-0 items-center gap-2 border-t px-4 font-mono text-xs">
            <span className="text-success-text">›</span>
            Add a thought
          </div>
        )}
      </div>
    );
  } else {
    // plate: the shipped look, the canvas a rounded card on the backdrop.
    body = (
      <div className="bg-surface-0 flex h-full gap-3 p-3">
        {slots.sidebar === 'left' && (
          <div className="w-[150px] flex-shrink-0 pt-1">
            <Braindump def={def} wordmark />
          </div>
        )}
        <div
          data-preview-canvas=""
          className="bg-canvas border-border relative min-w-0 flex-1 overflow-hidden rounded-[24px] border px-5 pt-4 shadow-[var(--shadow-elev-panel)]"
        >
          {canvas}
        </div>
      </div>
    );
  }

  return (
    <div {...layoutAttributes(def)} className="relative h-full w-full overflow-hidden">
      {body}
    </div>
  );
}
