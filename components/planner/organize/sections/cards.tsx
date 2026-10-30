'use client';

import { useMemo, useState } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { matching } from '@/lib/collections';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { toDateStr } from '@/lib/recurrence';
import { openStampedEdit } from '@/lib/ui-store';
import { cardLine, habitCards, xCount, type XCard, type XEffectHabit } from '@/lib/x-effect';
import { useXEffectSince } from '@/lib/x-effect-since';
import { XCardGrid, XCardThumb } from '@/components/planner/x-effect-card';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';
import { BackRow, DetailColumn, ListColumn, SectionWelcome } from '../detail-parts';
import { Eyebrow } from '../primitives';

/**
 * CARDS — every habit's X effect card (lib/x-effect.ts), current and filed.
 *
 * With nothing selected the detail pane is the shelf: each habit's current
 * card side by side, so the whole record reads at a glance. Selecting a habit
 * shows its current card at full size and every filed card under it.
 *
 * The no-guilt rules hold here as on the panel (x-effect-card.tsx): X's are
 * the only count, a gap is paper, and nothing is ordered by how well it went.
 * Rides EXT_X_EFFECT (console-rail.tsx), so it is only on the rail while
 * there are cards to keep.
 */

const WAITING = 'Starts at its next tick';
const WELCOME =
  'Each habit gets a 49-day card with an X for every day you do it. A card never resets; after 49 days it’s filed here and the next one starts.';

interface Entry {
  item: Item;
  cards: XCard[];
}

function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function CardsSection({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const items = usePlannerStore((s) => s.items);
  const userId = usePlannerStore((s) => s.userId);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const since = useXEffectSince(userId);
  const [query, setQuery] = useState('');
  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = toDateStr(new Date(), tz);

  const entries = useMemo<Entry[]>(() => {
    if (!since) return [];
    return items
      .filter((item) => getItemTypeConfig(itemTypeName(item)).counters.streak)
      .map((item) => ({ item, cards: habitCards(item as unknown as XEffectHabit, since, today, tz) }))
      // Cards first, then the habits still waiting for theirs; alphabetical
      // within each, never by how many X's.
      .sort(
        (a, b) =>
          Number(b.cards.length > 0) - Number(a.cards.length > 0) ||
          a.item.title.localeCompare(b.item.title)
      );
  }, [items, since, today, tz]);

  const shown = useMemo(() => matching(entries, query, (e) => e.item.title), [entries, query]);
  const selected = entries.find((e) => e.item.id === selectedId) ?? null;
  const withCards = entries.filter((e) => e.cards.length > 0);

  return (
    <>
      <ListColumn
        eyebrow="CARDS"
        count={query ? shown.length : entries.length}
        hasSelection={!!selected}
        filter={{ value: query, onChange: setQuery, placeholder: 'Filter habits…', testId: 'cards-filter' }}
      >
        {entries.length === 0 ? (
          <p className="text-muted-foreground px-[7px] pt-2 text-xs" data-testid="cards-empty">
            No habits yet. A habit gets its card the first time you tick it.
          </p>
        ) : (
          shown.map((entry) => (
            <CardRow
              key={entry.item.id}
              entry={entry}
              selected={entry.item.id === selectedId}
              onSelect={() => onSelect(entry.item.id)}
            />
          ))
        )}
      </ListColumn>

      <DetailColumn hasSelection={!!selected}>
        {selected ? (
          <CardDetail entry={selected} onBack={() => onSelect(null)} />
        ) : withCards.length > 0 ? (
          <Shelf entries={withCards} onSelect={onSelect} />
        ) : (
          <SectionWelcome section="cards">{WELCOME}</SectionWelcome>
        )}
      </DetailColumn>
    </>
  );
}

function CardRow({ entry, selected, onSelect }: { entry: Entry; selected: boolean; onSelect: () => void }) {
  const current = entry.cards[entry.cards.length - 1];
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="cards-row"
      data-item-id={entry.item.id}
      data-organize-row=""
      data-selected={selected ? '' : undefined}
      aria-pressed={selected}
      className={cn(
        'hover:bg-accent focus-visible:outline-ring flex min-h-[38px] w-full items-center gap-[9px] rounded-[5px] px-[7px] py-1 text-left',
        'focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-solid',
        'data-[selected]:bg-[var(--row-selected)] data-[selected]:hover:bg-[var(--row-selected)]'
      )}
    >
      {current ? (
        <span className="w-5 shrink-0 [&>span]:w-5 [&>span]:rounded-[3px] [&>span]:p-[2px]">
          <XCardThumb card={current} />
        </span>
      ) : (
        <span aria-hidden className="border-muted-foreground/40 size-5 shrink-0 rounded-[3px] border border-dashed" />
      )}
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{entry.item.title}</span>
        <span className="text-muted-foreground block truncate text-2xs">
          {current ? cardLine(current) : WAITING}
        </span>
      </span>
    </button>
  );
}

/** Nothing selected: every habit's current card, side by side. */
function Shelf({ entries, onSelect }: { entries: Entry[]; onSelect: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-3" data-testid="cards-shelf">
      <Eyebrow>On the go</Eyebrow>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3.5">
        {entries.map(({ item, cards }) => {
          const current = cards[cards.length - 1];
          const filed = cards.length - 1;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              data-testid="cards-shelf-card"
              className="focus-visible:outline-ring flex flex-col gap-1.5 rounded-[12px] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid"
            >
              <span className="bg-card border-border hover:border-input block rounded-[12px] border p-2 shadow-[var(--shadow-elev-bar)]">
                <span className="mb-1.5 flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-semibold">{item.title}</span>
                  <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
                    {current.day}/49
                  </span>
                </span>
                <XCardGrid card={current} />
              </span>
              <span className="text-muted-foreground font-mono text-[10px]">
                {filed > 0 ? `${filed} filed` : 'First card'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CardDetail({ entry, onBack }: { entry: Entry; onBack: () => void }) {
  const { item, cards } = entry;
  const current = cards[cards.length - 1];
  const filed = cards.slice(0, -1).reverse();
  return (
    <div className="flex max-w-[420px] flex-col" data-testid="cards-detail">
      <BackRow label="Cards" testId="cards-back" onBack={onBack} />
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h3 className="text-foreground truncate text-base font-semibold">{item.title}</h3>
        <button
          type="button"
          onClick={() => openStampedEdit({ ...item })}
          data-testid="cards-open-habit"
          className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline-offset-2 hover:underline"
        >
          Open habit
        </button>
      </div>

      {current ? (
        <CardBlock card={current} labels />
      ) : (
        <p className="text-muted-foreground text-sm">
          Its first card starts the next time you tick it.
        </p>
      )}

      {filed.length > 0 && (
        <div className="mt-6 flex flex-col gap-3">
          <Eyebrow>Filed</Eyebrow>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3">
            {filed.map((card) => (
              <CardBlock key={card.number} card={card} compact />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CardBlock({ card, labels, compact }: { card: XCard; labels?: boolean; compact?: boolean }) {
  return (
    <div
      className={cn(
        'bg-card border-border rounded-[12px] border shadow-[var(--shadow-elev-bar)]',
        compact ? 'p-2' : 'px-3 pt-2.5 pb-2'
      )}
      data-testid="cards-card"
      data-filed={card.filed ? '' : undefined}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className={cn('font-semibold', compact ? 'text-[11px]' : 'text-xs')}>
          {compact ? `Card ${card.number}` : cardLine(card)}
        </span>
        <span className="text-muted-foreground font-mono text-[10px] tabular-nums">{xCount(card.xs)}</span>
      </div>
      <XCardGrid card={card} labels={labels} />
      <div className="text-muted-foreground mt-1.5 font-mono text-[10px]">
        {dateLabel(card.start)} – {dateLabel(card.end)}
      </div>
    </div>
  );
}
