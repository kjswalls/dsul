'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { renameItem, useRenameStore } from '@/lib/item-rename';
import { cn } from '@/lib/utils';

/**
 * A row's title while it is being renamed (lib/item-rename.ts). It takes the
 * title's slot and type, so the row does not move: Enter or leaving saves,
 * Escape puts the old title back. Opened with the whole title selected, the way
 * F2 behaves in a file list.
 *
 * Every event stops here. The row under it is a drag source and a click target
 * (it opens the panel), and a keystroke that bubbled would reach dnd-kit's
 * keyboard sensor — Space would pick the row up mid-word.
 */
export function RowRenameInput({ itemId, title, className }: { itemId: string; title: string; className?: string }) {
  const [value, setValue] = useState(title);
  const ref = useRef<HTMLInputElement>(null);
  // Enter and Escape both end the rename, and the unmount that follows blurs the
  // field; without the latch that blur would save a second time (or, after
  // Escape, save the text Escape meant to throw away).
  const done = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) renameItem(itemId, value);
    useRenameStore.getState().end();
  };

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <input
      ref={ref}
      data-testid="item-rename-input"
      aria-label="Rename"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      onClick={stop}
      onDoubleClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onContextMenu={stop}
      className={cn(
        // The title's own type and box, with a hairline so it reads as a field.
        // An outline, not a border, so the text does not shift by a pixel.
        'min-w-0 flex-1 rounded-[3px] bg-background px-1 -mx-1 font-content text-content text-foreground outline outline-1 outline-ring/60',
        className
      )}
    />
  );
}
