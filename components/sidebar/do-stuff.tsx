'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { Button, ButtonKey } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TaskRow, type RowItem } from '@/components/primitives/task-row';
import { isRowCompletedOn } from '@/lib/sort-rows';
import {
  bySize,
  guessSize,
  itemSizeOf,
  nextUp,
  sizeDef,
  sizeForDigit,
  SIZES,
  type ItemSize,
} from '@/lib/item-size';
import {
  DO_STUFF_MIN_OPEN,
  doneNext,
  putOnToday,
  setSize,
  setSizes,
  skipNext,
  useDoStuffStore,
} from '@/lib/do-stuff';
import type { Task } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * Do stuff: the braindump sorted by size and walked quick-first.
 *
 * Four pieces, each drawn from the design boards (memory/handoffs/
 * stale-braindump.md): the hairline row that starts it (C), the size section
 * headers with a dot and a tinted hairline (H2), the next thing lifted in place
 * inside its section with its actions under it (N2), and unsized things sized
 * in place, guess outlined (S1). The size menu on a row (S2) is SizeControl.
 *
 * Colour lives only in 6px dots and the header hairline, the row rail's rule
 * (pills.tsx). The lime appears as the quick size's dot, the Enter keycap and
 * the "on" ring, and never under anything whose opacity changes.
 */

const isOpen = (row: RowItem) => !isRowCompletedOn(row, null);

function SizeDot({ size, hollow, className }: { size: ItemSize | null; hollow?: boolean; className?: string }) {
  const color = size ? sizeDef(size).color : 'var(--muted-foreground)';
  return (
    <span
      aria-hidden
      className={cn('size-1.5 shrink-0 rounded-full', className)}
      style={hollow || !size ? { boxShadow: `inset 0 0 0 1.5px ${color}` } : { background: color }}
    />
  );
}

/** A small keycap beside a secondary action; the primary one uses ButtonKey. */
function Cap({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      aria-hidden
      className="font-num inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] border border-border px-1 text-[10.5px] text-muted-foreground"
    >
      {children}
    </kbd>
  );
}

/* ── the row that starts it (C) ───────────────────────────────────────── */

/**
 * Whether the row shows at all. A short, unsized braindump reads fine as it
 * is, and a fresh account must see the braindump it always saw; the row
 * arrives once the list is long enough to need it, or once something is sized.
 */
export function wantsDoStuffRow(rows: readonly RowItem[]): boolean {
  const open = rows.filter(isOpen);
  return open.length >= DO_STUFF_MIN_OPEN || open.some((r) => itemSizeOf(r.item));
}

export function DoStuffRow({ rows }: { rows: readonly RowItem[] }) {
  const on = useDoStuffStore((s) => s.on);
  const doneCount = useDoStuffStore((s) => s.doneCount);
  const skipped = useDoStuffStore((s) => s.skipped);
  const { start, stop } = useDoStuffStore.getState();

  const { sized } = useMemo(() => bySize(rows), [rows]);
  const counts = SIZES.map((s) => ({ ...s, n: sized[s.key].filter(isOpen).length }));
  const next = on ? nextUp(sized, isOpen, skipped) : undefined;
  const nextSize = next ? itemSizeOf(next.item) : undefined;
  const left = nextSize ? sized[nextSize].filter(isOpen).length : 0;

  if (!on) {
    return (
      <button
        type="button"
        onClick={start}
        data-testid="do-stuff-start"
        className="group/do mx-[14px] flex h-[34px] shrink-0 items-center gap-2 rounded-[8px] border border-border px-3 text-left text-sm font-medium text-foreground hover-wash"
      >
        do stuff
        <span className="font-num ml-auto flex items-center gap-2.5 text-[11.5px] text-muted-foreground">
          {counts
            .filter((c) => c.n > 0)
            .map((c) => (
              <span key={c.key} className="flex items-center gap-1">
                <SizeDot size={c.key} />
                {c.n}
                {/* Names on hover: the dots alone are a legend you have to learn. */}
                <span className="hidden group-hover/do:inline group-focus-visible/do:inline">{c.plural}</span>
              </span>
            ))}
        </span>
      </button>
    );
  }

  // On: the dots become progress through the size being walked, filled for
  // what was done this run and hollow for what is left, eight at most.
  const filled = Math.min(doneCount, 8);
  const hollow = Math.max(0, Math.min(left, 8 - filled));
  const label = nextSize
    ? `${doneCount} done · ${left} ${sizeDef(nextSize).plural} left`
    : doneCount > 0
      ? `${doneCount} done`
      : '';
  return (
    <div
      data-testid="do-stuff-on"
      className="mx-[14px] flex h-[34px] shrink-0 items-center gap-2 rounded-[8px] border border-[var(--size-quick)] bg-surface-2 pl-3 pr-1 text-sm font-medium shadow-[0_0_0_3px_color-mix(in_oklab,var(--size-quick)_18%,transparent)]"
    >
      doing stuff
      <span className="truncate text-xs font-normal text-muted-foreground">{label}</span>
      <span aria-hidden className="ml-auto flex shrink-0 items-center gap-[3px]">
        {Array.from({ length: filled }, (_, i) => (
          <SizeDot key={`f${i}`} size="quick" />
        ))}
        {Array.from({ length: hollow }, (_, i) => (
          <SizeDot key={`h${i}`} size={nextSize ?? 'quick'} hollow />
        ))}
      </span>
      <button
        type="button"
        onClick={stop}
        aria-label="Stop doing stuff"
        data-testid="do-stuff-stop"
        className="flex size-[26px] shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/* ── section headers (H2) ─────────────────────────────────────────────── */

function SectionHeader({
  size,
  label,
  count,
  hint,
  open,
  onToggle,
  index,
  action,
}: {
  size: ItemSize | null;
  label: string;
  count: number;
  hint?: string;
  open: boolean;
  onToggle: () => void;
  index: number;
  action?: React.ReactNode;
}) {
  const color = size ? sizeDef(size).color : 'var(--muted-foreground)';
  return (
    <div className="flex flex-col">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          data-testid={`do-stuff-section-${size ?? 'new'}`}
          className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-[8px] px-2 text-left text-[13px] hover:bg-accent"
        >
          <ChevronRight
            aria-hidden
            className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          />
          <SizeDot size={size} />
          <span className="font-semibold">{label}</span>
          <span className="font-num text-[12.5px] text-muted-foreground">{count}</span>
          {hint && !action && <span className="ml-auto truncate text-xs text-muted-foreground">{hint}</span>}
        </button>
        {action}
      </div>
      {/* The tinted hairline, and the one shimmer that runs along it when the
          mode opens (do-stuff-rule in globals.css: once, staggered, and off
          under either motion veto). */}
      <div
        aria-hidden
        className="do-stuff-rule mx-1 h-[1.5px] rounded-full"
        style={
          {
            '--rule': color,
            '--rule-delay': `${index * 80}ms`,
          } as React.CSSProperties
        }
      />
    </div>
  );
}

/* ── the next thing, lifted (N2) ──────────────────────────────────────── */

/**
 * Focus follows the walk: the card takes focus when it appears, but only if
 * focus was already in the list or nowhere at all — never out of the capture
 * row or a dialog the user is typing in.
 */
function useWalkFocus(ref: React.RefObject<HTMLDivElement | null>, id: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const active = document.activeElement;
    const list = el.closest('[data-do-stuff-list]');
    if (!active || active === document.body || (list && list.contains(active))) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [ref, id]);
}

function plainKey(e: React.KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target as HTMLElement;
  return !(t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}

function NextCard({ row }: { row: RowItem }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = row.item.id;
  useWalkFocus(ref, id);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!plainKey(e)) return;
    const k = e.key.toLowerCase();
    if (k === 'enter' && e.target === e.currentTarget) doneNext(id);
    else if (k === 's') skipNext(id);
    else if (k === 't') putOnToday(id);
    else return;
    e.preventDefault();
  };
  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="do-stuff-next"
      aria-label={`Up next: ${row.item.title}`}
      className="my-1 rounded-[10px] border border-border bg-surface-2 pb-2 shadow-elev-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <TaskRow row={row} context="braindump" trailing={<SizeControl item={row.item as Task} />} />
      <div className="flex items-center gap-1 pl-[30px] pr-2">
        <Button size="sm" onClick={() => doneNext(id)} data-testid="do-stuff-done" aria-keyshortcuts="Enter">
          done
          <ButtonKey />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => skipNext(id)}
          data-testid="do-stuff-skip"
          aria-keyshortcuts="S"
          className="text-muted-foreground"
        >
          skip <Cap>S</Cap>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => putOnToday(id)}
          data-testid="do-stuff-today"
          aria-keyshortcuts="T"
          className="text-muted-foreground"
        >
          today <Cap>T</Cap>
        </Button>
      </div>
    </div>
  );
}

/* ── sizing in place (S1) ─────────────────────────────────────────────── */

function SizingCard({ row }: { row: RowItem }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = row.item.id;
  useWalkFocus(ref, id);
  const guess = guessSize(row.item.title);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!plainKey(e)) return;
    const size = sizeForDigit(e.key);
    if (!size) return;
    e.preventDefault();
    setSize(id, size);
  };
  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="do-stuff-sizing"
      aria-label={`How big is ${row.item.title}?`}
      className="my-1 rounded-[10px] border border-border bg-surface-2 pb-2 shadow-elev-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <TaskRow row={row} context="braindump" />
      <div className="grid grid-cols-2 gap-1 pl-[30px] pr-2">
        {SIZES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSize(id, s.key)}
            data-testid={`do-stuff-size-${s.key}`}
            aria-keyshortcuts={s.digit}
            className={cn(
              'flex h-[30px] items-center gap-1.5 rounded-[7px] border bg-surface-2 px-2 text-left text-[12.5px] font-medium hover-wash',
              guess === s.key ? 'border-[1.5px]' : 'border-border'
            )}
            style={guess === s.key ? { borderColor: s.color } : undefined}
          >
            <SizeDot size={s.key} />
            {s.label}
            {guess === s.key && <span className="text-[11px] font-normal text-muted-foreground">guess</span>}
            <span className="ml-auto">
              <Cap>{s.digit}</Cap>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** An unsized row's guess, drawn in the trailing slot while the mode is on. */
function GuessHint({ title }: { title: string }) {
  const guess = guessSize(title);
  if (!guess) return null;
  return (
    <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground" data-testid="do-stuff-guess">
      <SizeDot size={guess} hollow />
      {sizeDef(guess).label}?
    </span>
  );
}

/* ── the list ─────────────────────────────────────────────────────────── */

/**
 * The braindump while the mode is on. `rows` is the list as the braindump
 * would draw it, already narrowed by the Display menu and in its order; only
 * the grouping is replaced (by size), never what is in it.
 */
export function DoStuffList({ rows }: { rows: readonly RowItem[] }) {
  const skipped = useDoStuffStore((s) => s.skipped);
  const opened = useDoStuffStore((s) => s.opened);
  const toggle = useDoStuffStore.getState().open;

  // Habits never take a size (they recur), so they never wait to be sized.
  const sizeable = useMemo(() => rows.filter((r) => r.itemType === 'task'), [rows]);
  const others = useMemo(() => rows.filter((r) => r.itemType !== 'task'), [rows]);
  const { sized, unsized } = useMemo(() => bySize(sizeable), [sizeable]);
  const unsizedOpen = unsized.filter(isOpen);
  const next = nextUp(sized, isOpen, skipped);
  const nextSize = next ? itemSizeOf(next.item) : undefined;

  // Sizing comes first: an unsized thing cannot be walked to.
  const auto: ItemSize | 'new' | null = unsizedOpen.length > 0 ? 'new' : (nextSize ?? null);
  const current = opened ?? auto;

  const guesses = useMemo(() => {
    const map = new Map<string, ItemSize>();
    for (const r of unsizedOpen) {
      const g = guessSize(r.item.title);
      if (g) map.set(r.item.id, g);
    }
    return map;
  }, [unsizedOpen]);

  const fuzzyOpen = sized.fuzzy.filter(isOpen).length;
  const walkedOpen = sized.quick.filter(isOpen).length + sized.errand.filter(isOpen).length + sized.big.filter(isOpen).length;

  return (
    <div data-do-stuff-list className="flex flex-col gap-1" data-testid="do-stuff-list">
      {unsized.length > 0 && (
        <section>
          <SectionHeader
            size={null}
            label="new"
            count={unsizedOpen.length}
            open={current === 'new'}
            onToggle={() => toggle('new')}
            index={0}
            action={
              guesses.size > 0 ? (
                <button
                  type="button"
                  onClick={() => setSizes(guesses)}
                  data-testid="do-stuff-keep-guesses"
                  className="h-6 shrink-0 rounded-[6px] px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  keep all guesses
                </button>
              ) : undefined
            }
          />
          {current === 'new' && (
            <div className="pt-1">
              {unsized.map((r) =>
                r === unsizedOpen[0] ? (
                  <SizingCard key={r.item.id} row={r} />
                ) : (
                  <TaskRow
                    key={r.item.id}
                    row={r}
                    context="braindump"
                    trailing={isOpen(r) ? <GuessHint title={r.item.title} /> : <SizeControl item={r.item as Task} />}
                  />
                )
              )}
            </div>
          )}
        </section>
      )}

      {SIZES.map((s, i) => {
        const list = sized[s.key];
        if (list.length === 0) return null;
        const open = current === s.key;
        return (
          <section key={s.key} className="pt-2">
            <SectionHeader
              size={s.key}
              label={s.plural}
              count={list.filter(isOpen).length}
              hint={s.hint}
              open={open}
              onToggle={() => toggle(s.key)}
              index={i + 1}
            />
            {open && (
              <div className="pt-1">
                {list.map((r) =>
                  r === next ? (
                    <NextCard key={r.item.id} row={r} />
                  ) : (
                    <TaskRow
                      key={r.item.id}
                      row={r}
                      context="braindump"
                      trailing={<SizeControl item={r.item as Task} />}
                    />
                  )
                )}
              </div>
            )}
          </section>
        );
      })}

      {others.length > 0 && (
        <section className="pt-3">
          {others.map((r) => (
            <TaskRow key={r.item.id} row={r} context="braindump" />
          ))}
        </section>
      )}

      {!next && unsizedOpen.length === 0 && (
        <p className="px-2 pt-4 text-sm text-muted-foreground" data-testid="do-stuff-clear">
          {walkedOpen === 0 && fuzzyOpen > 0
            ? 'nothing ready to do. the fuzzy ones each need a first step.'
            : 'all done here. nice.'}
        </p>
      )}
    </div>
  );
}

/* ── the size on a row (S2) ───────────────────────────────────────────── */

/**
 * The trailing size control on a braindump row. A sized row shows its dot at
 * rest; an unsized one shows nothing until hovered, so a braindump nobody has
 * sized looks exactly as it always did. Opens the size menu: four sizes on
 * 1–4, and "no size" on 0.
 */
export function SizeControl({ item }: { item: Task }) {
  const size = itemSizeOf(item) ?? null;
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={size ? `Size: ${size}. Change size` : 'Give this a size'}
          data-testid="item-size-button"
          data-size={size ?? undefined}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            '-my-1.5 flex h-[22px] shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent',
            !size &&
              'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 data-[state=open]:opacity-100'
          )}
        >
          <SizeDot size={size} hollow={!size} />
          <span className={cn(size && 'hidden group-hover:inline')}>{size ? sizeDef(size).label : 'size'}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[196px]"
        onKeyDown={(e) => {
          const picked = sizeForDigit(e.key);
          if (picked === undefined) return;
          e.preventDefault();
          setSize(item.id, picked);
          setOpen(false);
        }}
      >
        {SIZES.map((s) => (
          <DropdownMenuItem
            key={s.key}
            onSelect={() => setSize(item.id, s.key)}
            data-testid={`item-size-${s.key}`}
            className={cn(size === s.key && 'font-medium')}
          >
            <SizeDot size={s.key} />
            {s.label}
            <span className="ml-auto">
              <Cap>{s.digit}</Cap>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => setSize(item.id, null)}
          disabled={!size}
          data-testid="item-size-none"
          className="text-muted-foreground"
        >
          <SizeDot size={null} hollow />
          no size
          <span className="ml-auto">
            <Cap>0</Cap>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
