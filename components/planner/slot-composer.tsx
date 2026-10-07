'use client';

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AddIconButton } from '@/components/primitives/add-icon-button';
import { usePlannerStore } from '@/lib/planner-store';
import { getItemTypeConfig } from '@/lib/item-registry';
import { addAt, addableTypes, openAdded, setHoveredSlot, useSlotComposer, type SlotTarget } from '@/lib/slot-add';
import { cn } from '@/lib/utils';

/**
 * The composer: a title field drawn where the add was asked for. One piece for
 * every planner surface (a slot on the grid, an Anytime strip, a day in a list),
 * so the keys mean the same thing wherever it opens:
 *
 *   ↵      add it here, and stay on the canvas
 *   ⇧↵     add it, then open it in the item panel for everything else
 *   esc    put the composer away
 *
 * Clicking away adds a typed title and drops an empty one, so a half-typed
 * title is never lost to a stray click and an accidental open costs nothing.
 *
 * The field wears the field look (globals.css `.field`): an ink hairline with a
 * faint halo, and the accent only in the caret. A draft has no checkbox, since
 * there is nothing to tick yet; the + says what it is.
 */

/** The type chip: task by default; a habit says it repeats, since it lands on every day it repeats. */
function TypeChip({
  type,
  onChange,
  onOpenChange,
  compact,
}: {
  type: string;
  onChange: (type: string) => void;
  onOpenChange: (open: boolean) => void;
  compact?: boolean;
}) {
  const itemTypes = usePlannerStore((s) => s.itemTypes);
  const label = getItemTypeConfig(type).label;
  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        data-testid="slot-composer-type"
        // Keeps focus in the title field: the press that opens the menu would
        // otherwise blur it, and a blur adds what is typed.
        onPointerDown={(e) => e.preventDefault()}
        className={cn(
          'flex flex-none items-center gap-0.5 rounded-[4px] border border-border px-1.5 py-px text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          compact && 'hidden'
        )}
      >
        {type === 'habit' ? `${label} · every day` : label}
        <ChevronDown className="h-2.5 w-2.5" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36" onCloseAutoFocus={(e) => e.preventDefault()}>
        {addableTypes(itemTypes).map((t) => (
          <DropdownMenuItem key={t.name} onSelect={() => onChange(t.name)} className="text-xs">
            {t.label}
            {t.name === 'habit' && <span className="ml-auto text-2xs text-muted-foreground">every day</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The keys and the blur rule, shared by both shapes. `keepOpen` is a row that
 * stays after ↵ for the next title (an Anytime list); a grid slot closes,
 * because the block it made now stands where it was.
 */
function useComposer(target: SlotTarget, { keepOpen, onDone }: { keepOpen: boolean; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState(target.type ?? 'task');
  const menuOpen = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // A composer whose surface goes away (a view or date switch while it is
  // open) lets the store go too, or the next click would read one as open.
  useEffect(
    () => () => {
      if (useSlotComposer.getState().target === target) useSlotComposer.getState().close();
    },
    [target]
  );

  const commit = (thenOpen: boolean) => {
    const id = addAt(target, type, title);
    setTitle('');
    if (thenOpen && id) {
      onDone();
      openAdded(id);
      return;
    }
    if (!keepOpen) onDone();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!title.trim()) {
        if (!keepOpen) onDone();
        return;
      }
      commit(e.shiftKey);
    } else if (e.key === 'Escape') {
      // Ours alone: Escape also closes the item panel, and the composer is in front of it.
      e.preventDefault();
      e.stopPropagation();
      setTitle('');
      if (keepOpen) inputRef.current?.blur();
      onDone();
    }
  };

  const onBlur = () => {
    if (menuOpen.current) return;
    if (title.trim()) commit(false);
    else if (!keepOpen) onDone();
  };

  const onMenuOpenChange = (open: boolean) => {
    menuOpen.current = open;
    if (!open) requestAnimationFrame(() => inputRef.current?.focus());
  };

  return { title, setTitle, type, setType, inputRef, onKeyDown, onBlur, onMenuOpenChange };
}

const kbd = 'rounded-xs border border-border px-1 font-mono text-[10px] text-muted-foreground';

/**
 * The grid's composer, positioned by the layer over the slot it was opened for.
 * Its own container query decides what fits: in a narrow week column the chip
 * and the time step aside and the hint shortens.
 */
export function GridComposer({
  target,
  style,
  timeLabel,
  hintBelow = true,
}: {
  target: Extract<SlotTarget, { kind: 'grid' }>;
  style: CSSProperties;
  timeLabel: string;
  hintBelow?: boolean;
}) {
  const close = useSlotComposer((s) => s.close);
  const { title, setTitle, type, setType, inputRef, onKeyDown, onBlur, onMenuOpenChange } = useComposer(target, {
    keepOpen: false,
    onDone: close,
  });

  useEffect(() => {
    inputRef.current?.focus();
    // Once per open; the target object is the open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return (
    <div
      data-testid="slot-composer"
      data-click-away-ignore=""
      className="@container/composer absolute"
      style={style}
    >
      <div
        className="field flex h-full items-center gap-2 border bg-[var(--sched-pane-hover)] pl-2.5 pr-2 shadow-[var(--sched-shadow-hover)]"
        // The field's focus look, held: the box IS the field.
        style={{
          borderColor: 'color-mix(in oklab, var(--input), var(--foreground) 55%)',
          boxShadow: 'var(--sched-shadow-hover), 0 0 0 3px color-mix(in oklab, var(--foreground) 7%, transparent)',
          borderRadius: 5,
        }}
      >
        <Plus className="h-3 w-3 flex-none text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          data-testid="slot-composer-input"
          aria-label={`New ${getItemTypeConfig(type).label.toLowerCase()} at ${timeLabel}`}
          placeholder={`New ${getItemTypeConfig(type).label.toLowerCase()}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          className="-mx-1 min-w-0 flex-1 bg-transparent px-1 font-content text-content text-foreground caret-[var(--success-text)] outline-none placeholder:text-muted-foreground"
        />
        <span className="hidden @min-[220px]/composer:contents">
          <TypeChip type={type} onChange={setType} onOpenChange={onMenuOpenChange} />
        </span>
        <span className="hidden flex-none font-num text-2xs text-muted-foreground @min-[300px]/composer:inline">
          {timeLabel}
        </span>
      </div>
      {hintBelow && (
        <div aria-hidden className="mt-1.5 flex flex-wrap gap-x-2.5 text-2xs text-muted-foreground">
          <span>
            <kbd className={kbd}>↵</kbd> add
          </span>
          <span>
            <kbd className={kbd}>⇧↵</kbd> <span className="hidden @min-[220px]/composer:inline">more details</span>
            <span className="@min-[220px]/composer:hidden">more</span>
          </span>
          <span>
            <kbd className={kbd}>esc</kbd> <span className="hidden @min-[220px]/composer:inline">cancel</span>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The row composer: an "Add to …" line at the end of a list, shaped like the
 * braindump's own add row. `persistent` rows are always there (Day × Schedule's
 * Anytime, Day × List) and keep focus after ↵ for the next title; a transient
 * one (a week column's strip, a week list's day) opens on its + and goes when
 * left empty.
 */
export function AddRow({
  target,
  placeholder,
  persistent,
  className,
}: {
  target: Extract<SlotTarget, { kind: 'row' }>;
  placeholder: string;
  persistent?: boolean;
  className?: string;
}) {
  const close = useSlotComposer((s) => s.close);
  const opened = useSlotComposer((s) => s.target?.scope === target.scope);
  const { title, setTitle, type, setType, inputRef, onKeyDown, onBlur, onMenuOpenChange } = useComposer(target, {
    keepOpen: !!persistent,
    onDone: () => !persistent && close(),
  });

  // A transient row mounts open, so it takes focus on mount. A persistent row
  // is always there and "opening" it (the grid's right-click "New task in
  // Anytime", or `n` over it) only focuses it; the store is let go at once so
  // nothing else reads a composer as open.
  useEffect(() => {
    if (!persistent) inputRef.current?.focus();
    else if (opened) {
      inputRef.current?.focus();
      close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  return (
    <div
      data-testid="add-row"
      data-add-row={target.scope}
      data-slot-scope={target.scope}
      data-click-away-ignore=""
      onPointerEnter={() => setHoveredSlot(target)}
      onPointerLeave={() => setHoveredSlot(null)}
      className={cn(
        'group/addrow flex items-center gap-3 rounded-[5px] px-2 py-1.5 transition-colors hover:bg-accent focus-within:bg-transparent',
        className
      )}
    >
      <AddIconButton
        size="md"
        aria-label="Add with all the details"
        title="Add with all the details (⇧↵)"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => {
          if (title.trim()) {
            const id = addAt(target, type, title);
            setTitle('');
            if (id) openAdded(id);
          } else inputRef.current?.focus();
        }}
      />
      <input
        ref={inputRef}
        data-testid="add-row-input"
        aria-label={placeholder}
        placeholder={placeholder}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className="-mx-1 min-w-0 flex-1 bg-transparent px-1 font-content text-content text-foreground caret-[var(--success-text)] outline-none placeholder:text-muted-foreground"
      />
      {title.trim() && (
        <span className="contents">
          <TypeChip type={type} onChange={setType} onOpenChange={onMenuOpenChange} />
          <kbd aria-hidden className={cn('pointer-events-none flex-shrink-0', kbd)}>
            ↵
          </kbd>
        </span>
      )}
    </div>
  );
}
