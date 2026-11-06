'use client';

import { useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeftToLine,
  Check,
  CircleSlash,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Send,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useItemEvents } from '@/components/planner/item-timeline';
import { getItemEventsAvailable } from '@/lib/db';
import { buildHistory, editCount, happenedOnly, type HistoryIcon, type HistoryRow } from '@/lib/item-history';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

const ICONS: Record<HistoryIcon, LucideIcon> = {
  added: Plus,
  deleted: Trash2,
  done: Check,
  reopened: RotateCcw,
  'let-go': CircleSlash,
  paused: Pause,
  resumed: Play,
  moved: Redo2,
  braindump: ArrowLeftToLine,
  handed: Send,
  agent: Activity,
  said: MessageSquare,
  edit: Pencil,
};

/** "6:34 pm", the way the rest of the panel says a time. */
function timeWords(at: number): string {
  return new Date(at)
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .replace(/\s?([AP])M$/i, (_, p: string) => ` ${p.toLowerCase()}m`);
}

function Row({ row }: { row: HistoryRow }) {
  const Icon = ICONS[row.icon];
  const notYou = row.actor !== 'you';
  return (
    <li className="flex items-start gap-2.5 py-1" data-testid="item-history-row" data-by={row.actor}>
      {/* Anything the AI, an agent or a recipe did wears the aurora on its
          tile's rim (globals.css [data-ai-tile]); your own rows sit plain. */}
      <span
        className={cn(
          'mt-px grid size-5 shrink-0 place-items-center rounded-[6px] text-muted-foreground',
          !notYou && 'bg-surface-3'
        )}
        data-ai-tile={notYou ? '' : undefined}
        aria-hidden
      >
        <Icon className="size-3" strokeWidth={2.2} />
      </span>
      <span className="line-clamp-2 min-w-0 flex-1 pt-px text-[13px] leading-[18px] text-foreground">
        {row.text}
        {row.by && <span className="text-muted-foreground"> · {row.by}</span>}
      </span>
      <time className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">{timeWords(row.at)}</time>
    </li>
  );
}

/**
 * The History popover's body (lib/item-history.ts): what happened, newest
 * first, by day, and your own small edits behind "Show all edits".
 */
export function ItemHistory({ item, onClose }: { item: Item; onClose: () => void }) {
  const events = useItemEvents(item);
  const [all, setAll] = useState(false);
  const days = useMemo(() => buildHistory(events ?? [], new Date()), [events]);
  const edits = editCount(days);
  const shown = all ? days : happenedOnly(days);

  return (
    <div
      className="flex max-h-[min(28rem,70vh)] flex-col outline-none"
      data-testid="item-history"
      data-item-history=""
      tabIndex={-1}
    >
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
        <h2 className="text-[13px] font-semibold text-foreground">History</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close history"
          className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3.5">
        {events === null ? (
          <p className="py-2 text-xs text-muted-foreground">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground" data-testid="item-history-empty">
            {getItemEventsAvailable() ? 'Nothing has happened to this yet.' : 'History isn’t available yet.'}
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {shown.map((day) => (
              <li key={day.key} className="flex flex-col gap-0.5">
                <span className="pb-1 text-[11.5px] font-medium text-muted-foreground">{day.label}</span>
                <ol className="flex flex-col">
                  {day.rows.map((row) => (
                    <Row key={row.key} row={row} />
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
      </div>
      {edits > 0 && (
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            data-testid="item-history-all"
            aria-pressed={all}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {all ? 'Hide your edits' : 'Show all edits'}
            <span className="tabular-nums">{edits}</span>
          </button>
        </div>
      )}
    </div>
  );
}
