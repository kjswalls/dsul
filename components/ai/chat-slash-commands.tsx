'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo } from 'react';
import { useCommandContext } from '@/hooks/use-command-context';
import { chordLabel, isApplePlatform, isAvailable, matchCommands, type CommandRow } from '@/lib/commands';
import { useCommandUsageStore } from '@/lib/command-usage-store';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { useUIStore } from '@/lib/ui-store';
import { cn } from '@/lib/utils';

/** Rows offered at once; the launcher (⌘K) has room for the rest. */
const MAX_ROWS = 6;

export interface SlashCommandsHandle {
  /** Arrow keys, Enter, Tab: true when the list took the key. */
  key: (key: string) => boolean;
}

/**
 * The / list over the chat box. Mounted only while a "/" is being typed, so
 * the command context (router, theme) is built only when a command can run.
 *
 * A command that runs in one step runs here, as ⌘K would run it, and the box
 * is cleared (`onRan`). One that still needs something chosen (an item, a
 * value, words) opens in ⌘K already picked, where that choice lives, so
 * every command is reachable from here without a second picker in the box.
 */
export const SlashCommands = forwardRef<
  SlashCommandsHandle,
  {
    id: string;
    query: string;
    /** The row in hand, held by the box so it can name it to a screen reader. */
    highlight: number;
    onHighlight: (index: number) => void;
    /** The id of the row in hand, or undefined when nothing matches (the box's aria-activedescendant). */
    onActive: (optionId: string | undefined) => void;
    onRan: () => void;
  }
>(function SlashCommands({ id, query, highlight, onHighlight: setHighlight, onActive, onRan }, ref) {
    const ctx = useCommandContext();
    const usage = useCommandUsageStore((s) => s.usage);
    const rows = useMemo(
      () => matchCommands(query, ctx, { usage, limit: MAX_ROWS }).filter((r) => !r.disabled),
      [query, ctx, usage]
    );
    // The launcher's own binding as the user has it ('system_search', ⌘K by default).
    const launcherKeys = chordLabel(useShortcutKeys('system_search'), isApplePlatform());
    const active = Math.min(highlight, rows.length - 1);
    const activeId = rows.length > 0 ? `${id}-${active}` : undefined;
    useEffect(() => {
      onActive(activeId);
      return () => onActive(undefined);
    }, [activeId, onActive]);

    const run = (row: CommandRow) => {
      const { command, arg } = row;
      if (!isAvailable(command, ctx)) return;
      onRan();
      if (command.argument && arg === undefined) {
        useUIStore.getState().openDialog({ type: 'launcher', commandId: command.id });
        return;
      }
      command.run(ctx, arg?.value);
      useCommandUsageStore.getState().record(command.id);
    };

    useImperativeHandle(ref, () => ({
      key: (key) => {
        if (rows.length === 0) return false;
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          const step = key === 'ArrowDown' ? 1 : -1;
          setHighlight((active + step + rows.length) % rows.length);
          return true;
        }
        if (key === 'Enter' || key === 'Tab') {
          run(rows[active]);
          return true;
        }
        return false;
      },
    }));

    if (rows.length === 0) return null;
    return (
      <ul
        id={id}
        role="listbox"
        aria-label="Commands"
        data-testid="chat-slash-list"
        className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-60 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-soft-md"
      >
        {rows.map((row, i) => {
          const Icon = row.arg?.icon ?? row.command.icon;
          return (
            <li
              key={row.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              data-testid="chat-slash-option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(row)}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-foreground',
                i === active && 'bg-accent'
              )}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.command.argument && !row.arg && (
                <span className="shrink-0 text-2xs text-muted-foreground">in {launcherKeys}</span>
              )}
            </li>
          );
        })}
      </ul>
    );
});
