'use client';

import { useEffect, useMemo, useRef } from 'react';
import { Button, ButtonKey } from '@/components/ui/button';
import { TypeChip, useComposer } from '@/components/planner/slot-composer';
import { getItemTypeConfig } from '@/lib/item-registry';
import { addAt, useSlotComposer, zenAddTarget, type SlotTarget } from '@/lib/slot-add';
import { cn } from '@/lib/utils';

/**
 * Adding from Zen (Kirby's pick "B, a key by the exit", 2026-11-05).
 *
 * At rest the room gains one thing: an "n add to today" hint beside the exit.
 * `n` (lib/commands/registry.ts, create.task) or a click on it raises a small
 * composer above the footer: a serif title line over a recessed deck holding
 * where it lands, the type chip and the lime Add key. It is the planner's own
 * composer underneath (components/planner/slot-composer.tsx `useComposer`, so
 * ↵ / ⇧↵ / esc mean what they mean on the canvas) committing through `addAt`
 * on a row target for TODAY, never `selectedDate`, since the room is always
 * today. ↵ adds and stays for the next title, and the new row lands in Next;
 * esc or a click elsewhere puts it away (a typed title is added on the way
 * out, as everywhere else), and the room is empty again.
 *
 * While the composer is open the exit hint reads "put it away" and does that,
 * because esc in the field does that too: the label never promises a key
 * press the field would answer differently.
 */
export function ZenAdd({
  todayStr,
  previewing,
  onLeave,
}: {
  todayStr: string;
  /** The look-only preview: nothing may write on stale rows, so no composer. */
  previewing: boolean;
  onLeave: () => void;
}) {
  const target = useMemo(() => zenAddTarget(todayStr), [todayStr]);
  const storeOpen = useSlotComposer((s) => s.target?.scope === target.scope);
  const open = storeOpen && !previewing;
  const discardRef = useRef<(() => void) | null>(null);

  // `n` pressed during the preview opens the store's slot; let it go so it
  // does not spring open the moment the fresh data lands.
  useEffect(() => {
    if (storeOpen && previewing) useSlotComposer.getState().close();
  }, [storeOpen, previewing]);

  return (
    <div className="relative z-10 mt-6 flex items-center gap-1.5">
      {/* Raised over the foot of the room rather than pushed into its flow:
          <main> centres the hero, so a card in the flow would shove the
          hero up every time n is pressed. */}
      {open && <ZenComposer target={target} discardRef={discardRef} />}
      <button
        type="button"
        data-testid="zen-add-key"
        disabled={previewing}
        aria-keyshortcuts="n"
        aria-expanded={open}
        // Keeps focus in an open composer, so the click reads as "go on" rather than a blur.
        onPointerDown={(e) => open && e.preventDefault()}
        onClick={() => {
          if (open) document.querySelector<HTMLInputElement>('[data-testid="zen-add-input"]')?.focus();
          else useSlotComposer.getState().open(target);
        }}
        className={cn(
          'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors duration-150 disabled:opacity-50',
          open
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-secondary-foreground'
        )}
      >
        <span
          className={cn(
            'rounded-[5px] border px-1.5 py-1 font-num text-[10.5px] leading-none',
            open
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-surface-3 text-secondary-foreground'
          )}
        >
          n
        </span>
        add to today
      </button>
      <button
        type="button"
        onPointerDown={(e) => open && e.preventDefault()}
        onClick={() => (open ? discardRef.current?.() : onLeave())}
        className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-secondary-foreground"
      >
        <span className="rounded-[5px] border border-border bg-surface-3 px-1.5 py-1 font-num text-[10.5px] leading-none text-secondary-foreground">
          esc
        </span>
        {open ? 'put it away' : 'back to the planner'}
      </button>
    </div>
  );
}

function ZenComposer({
  target,
  discardRef,
}: {
  target: Extract<SlotTarget, { kind: 'row' }>;
  discardRef: React.MutableRefObject<(() => void) | null>;
}) {
  const close = useSlotComposer((s) => s.close);
  const { title, setTitle, type, setType, inputRef, onKeyDown, onBlur, onMenuOpenChange, discard } = useComposer(
    target,
    { keepOpen: true, closeOnBlur: true, onDone: close }
  );

  useEffect(() => {
    discardRef.current = discard;
    return () => {
      discardRef.current = null;
    };
  });

  useEffect(() => {
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lands = getItemTypeConfig(type).dateAnchored ? 'Today, Anytime' : 'Anytime';

  return (
    <div
      data-testid="zen-add"
      data-click-away-ignore=""
      className="absolute bottom-full left-1/2 mb-3 w-[min(560px,calc(100vw-40px))] -translate-x-1/2 overflow-hidden rounded-[14px] bg-modal shadow-[var(--shadow-elev-lg)] ring-1 ring-border"
    >
      <label className="block px-5 pt-[18px] pb-3.5">
        <span className="mb-2 block text-[10.5px] font-medium uppercase leading-[14px] tracking-[0.09em] text-muted-foreground">
          New for today
        </span>
        <input
          ref={inputRef}
          data-testid="zen-add-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          placeholder="What else?"
          className="w-full bg-transparent p-0 font-serif text-[22px] font-semibold leading-[1.25] text-foreground caret-[var(--success-text)] outline-none placeholder:text-muted-foreground"
        />
      </label>
      <div data-item-deck="" className="flex items-center gap-2.5 py-2.5 pr-3 pl-5">
        <span className="text-xs text-muted-foreground">{lands}</span>
        <TypeChip type={type} onChange={setType} onOpenChange={onMenuOpenChange} testId="zen-add-type" />
        <span className="flex-1" />
        <span aria-hidden className="text-2xs text-muted-foreground">
          ⇧↵ details
        </span>
        <Button
          size="sm"
          disabled={!title.trim()}
          // Keep focus in the field: a blur would add the title before this click does.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            addAt(target, type, title);
            setTitle('');
            inputRef.current?.focus();
          }}
        >
          Add
          <ButtonKey />
        </Button>
      </div>
    </div>
  );
}
