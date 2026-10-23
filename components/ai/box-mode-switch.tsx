'use client';

import { useRef } from 'react';
import { bindingKey, noteDraftKey, useRailStore, type BoxMode } from '@/lib/rail-store';
import { cn } from '@/lib/utils';

/**
 * "Ask / Note" in an item's box (the rail's ChatComposer and ItemConversation's
 * inline box): what the box does with its text. Ask sends it to whoever
 * answers; Note keeps it on the item (lib/item-notes-store.ts `saveNoteFrom`)
 * and never sends it anywhere. One mode per item, in rail-store `boxModes`, so
 * every box of the item shows the same one.
 *
 * TimelineFilterTabs' shape: a radiogroup of two pills.
 */
export function BoxModeSwitch({
  value,
  onChange,
  size = 'md',
}: {
  value: BoxMode;
  onChange: (m: BoxMode) => void;
  size?: 'sm' | 'md';
}) {
  const refs = useRef<Record<BoxMode, HTMLButtonElement | null>>({ ask: null, note: null });
  const modes: { id: BoxMode; label: string }[] = [
    { id: 'ask', label: 'Ask' },
    { id: 'note', label: 'Note' },
  ];
  return (
    <div role="radiogroup" aria-label="Send as" className="flex shrink-0 items-center gap-0.5" data-testid="box-mode">
      {modes.map((m) => (
        <button
          key={m.id}
          ref={(el) => {
            refs.current[m.id] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === m.id}
          tabIndex={value === m.id ? 0 : -1}
          data-testid={`box-mode-${m.id}`}
          onClick={() => onChange(m.id)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              const next: BoxMode = m.id === 'ask' ? 'note' : 'ask';
              refs.current[next]?.focus();
              return;
            }
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              onChange(m.id);
            }
          }}
          className={cn(
            'rounded-full py-0.5 transition-colors',
            size === 'sm' ? 'px-1.5 text-[10px]' : 'px-2 text-[11px]',
            value === m.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The item box's mode, as every box of the item reads it: 'ask' unless the
 * box can note and the item's key says 'note'.
 */
export function useItemBoxMode(itemId: string | null, canNote: boolean): BoxMode {
  return useRailStore((s) => (canNote && itemId ? (s.boxModes[bindingKey({ kind: 'item', itemId })] ?? 'ask') : 'ask'));
}

/**
 * The user switched an item's box. The text they had moves with them only
 * into an EMPTY draft of the other mode ("I meant this as a note"); otherwise
 * the other mode's own draft shows. Nothing else moves text between them.
 */
export function switchBoxMode(itemId: string, next: BoxMode): void {
  const rail = useRailStore.getState();
  const askKey = bindingKey({ kind: 'item', itemId });
  const noteKey = noteDraftKey(itemId);
  const current = (rail.boxModes[askKey] as BoxMode | undefined) ?? 'ask';
  if (current === next) return;
  const [fromKey, toKey] = next === 'note' ? [askKey, noteKey] : [noteKey, askKey];
  const from = rail.drafts[fromKey] ?? '';
  if (from && !(rail.drafts[toKey] ?? '')) {
    rail.setDraft(toKey, from);
    rail.setDraft(fromKey, '');
  }
  rail.setBoxMode(askKey, next);
}

/** The line under an item's box in Note mode. */
export function noteModeLine(openclaw: boolean): string {
  return openclaw ? 'Saved on this item. Not sent to the AI or OpenClaw.' : 'Saved on this item. Not sent to the AI.';
}
