'use client';

import { useCallback, useMemo, useState } from 'react';
import { Moon, Play } from 'lucide-react';
import { CategoryIcon } from '@/lib/category-icons';
import { accentColorForName } from '@/lib/accent-colors';
import { usePlannerStore } from '@/lib/planner-store';
import { useAwayStore } from '@/lib/away-store';
import { formatShort, matching } from '@/lib/collections';
import { suppressionLabel, suppressionReason } from '@/lib/active';
import { toDateStr } from '@/lib/recurrence';
import { setGateOn } from '@/lib/gate-toggle';
import { openStampedEdit } from '@/lib/ui-store';
import { pausedEntryName, pausedNote, pausedShelf, type PausedEntry } from '@/lib/paused-shelf';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';
import { BackRow, DetailColumn, ListColumn, SectionWelcome, StatusStrip } from '../detail-parts';
import { Eyebrow } from '../primitives';
import type { ConsoleSection } from '../console-rail';

/**
 * PAUSED — everything set aside, and the day each one comes back.
 *
 * The browsable home locked decision 10 requires (programs-routines.md): a
 * paused item is hidden from every other surface, so this list is what makes
 * "paused" different from "lost". It was a drawer at the foot of the braindump
 * until Kirby moved it here (2026-10-23, the addendum in the same plan); the
 * braindump keeps only a moon with the count, which opens this section.
 *
 * Grouped by RETURN DAY, soonest first, undated last (lib/paused-shelf.ts), and
 * a paused routine or season is ONE row whose Resume is the container's own
 * switch. That also retired the Display menu's "Paused scopes" list, which was
 * this list's containers a second time.
 *
 * Guilt-free law (overlap-blocks decision 1): no counts of days paused, no
 * warning colour. A date here is a return, never an age.
 *
 * Like Trash it rides no extension (console-rail.tsx), because pausing is not
 * gated and its way back may not be.
 */
/**
 * The Paused rail row's second line ("5 · Gym back Fri"), or null with nothing
 * paused. Asked by the console for its rail, so the count is seen from every
 * section — the braindump header's moon used to carry it (Kirby, 2026-10-23).
 */
export function usePausedRailNote(): string | null {
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const away = useAwayStore((s) => s.periods);
  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStr = toDateStr(new Date(), tz);
  return useMemo(
    () => pausedNote(pausedShelf(items, todayStr, { userTimezone: tz, routines, seasons, away }), todayStr),
    [items, todayStr, tz, routines, seasons, away]
  );
}

export function PausedSection({
  selectedId,
  onSelect,
  onNavigate,
  sections,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Open a routine or season in its own section, when that section is on the rail. */
  onNavigate: (section: ConsoleSection, id: string) => void;
  sections: readonly { id: ConsoleSection }[];
}) {
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const away = useAwayStore((s) => s.periods);
  const [query, setQuery] = useState('');

  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Resolved at today and used as a memo key: pausing is dateless, and a
  // console left open past midnight must list what is true now.
  const todayStr = toDateStr(new Date(), tz);
  const shelf = useMemo(
    () => pausedShelf(items, todayStr, { userTimezone: tz, routines, seasons, away }),
    [items, todayStr, tz, routines, seasons, away]
  );

  const allEntries = useMemo(() => shelf.days.flatMap((d) => d.entries), [shelf]);
  const days = useMemo(
    () =>
      shelf.days
        .map((day) => ({
          ...day,
          entries: matching(day.entries, query, (e) =>
            e.kind === 'item' ? e.item.title : [pausedEntryName(e), ...e.items.map((i) => i.title)].join(' ')
          ),
        }))
        .filter((day) => day.entries.length > 0),
    [shelf, query]
  );
  const shown = days.reduce((n, d) => n + d.entries.length, 0);
  // Against the WHOLE list, like every section: a selection the user then
  // filters out keeps its detail rather than the pane blanking.
  const selected = allEntries.find((e) => e.key === selectedId) ?? null;
  const disabled = !userId || isLoading;

  const resume = useCallback(
    (entry: PausedEntry) => {
      if (entry.kind === 'item') usePlannerStore.getState().setItemPaused(entry.item.id, false);
      else setGateOn(entry.kind, entry.kind === 'routine' ? entry.routine.id : entry.season.id, true);
      // The row leaves the list on resume; a selection still naming it would
      // leave the pane describing a ghost (and strand the phone's drill-in).
      if (entry.key === selectedId) onSelect(null);
    },
    [selectedId, onSelect]
  );

  return (
    <>
      <ListColumn
        eyebrow="PAUSED"
        count={query ? shown : shelf.count}
        hasSelection={!!selected}
        filter={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter paused…',
          testId: 'paused-filter',
        }}
      >
        {shelf.count === 0 ? (
          <p className="text-muted-foreground px-[7px] pt-2 text-xs" data-testid="paused-empty">
            Nothing is paused.
          </p>
        ) : (
          days.map((day) => (
            <div key={day.key || 'undated'} data-testid="paused-day" data-day={day.key}>
              <div className="flex h-[26px] items-end px-[7px] pb-1">
                <Eyebrow>{day.until ? returnDayLabel(day.until, todayStr) : 'No date'}</Eyebrow>
              </div>
              {day.entries.map((entry) => (
                <PausedRow
                  key={entry.key}
                  entry={entry}
                  selected={entry.key === selectedId}
                  onSelect={() => onSelect(entry.key)}
                  onResume={() => resume(entry)}
                  disabled={disabled}
                />
              ))}
            </div>
          ))
        )}
      </ListColumn>

      <DetailColumn hasSelection={!!selected}>
        {selected ? (
          <PausedDetail
            entry={selected}
            todayStr={todayStr}
            tz={tz}
            onBack={() => onSelect(null)}
            onResume={() => resume(selected)}
            onNavigate={onNavigate}
            sections={sections}
            disabled={disabled}
          />
        ) : (
          <SectionWelcome section="paused">
            Things you&apos;ve set aside. Nothing here is late: each one comes back on its own
            day, or whenever you resume it.
          </SectionWelcome>
        )}
      </DetailColumn>
    </>
  );
}

/** "Tomorrow", "Thu, Oct 30" — a return, said the way a calendar would. */
function returnDayLabel(day: string, todayStr: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const diff = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
  if (diff === 1) return 'Tomorrow';
  const weekday = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: 'short',
    timeZone: 'UTC',
  });
  return `${weekday}, ${formatShort(day)}`;
}

/** "Habit", "Routine · 4 habits", "Season · 3 items". */
function entryKindLine(entry: PausedEntry): string {
  if (entry.kind === 'item') return getItemTypeConfig(itemTypeName(entry.item)).label;
  const n = entry.items.length;
  const allHabits = entry.items.every((i) => i.type === 'habit');
  const noun = allHabits ? (n === 1 ? 'habit' : 'habits') : n === 1 ? 'item' : 'items';
  return `${entry.kind === 'routine' ? 'Routine' : 'Season'} · ${n} ${noun}`;
}

/** An item's mark: the box its row wears on the grid, outlined and quiet. */
function ItemMark({ item }: { item: Item }) {
  return (
    <span
      aria-hidden
      className={cn(
        'border-muted-foreground/50 h-3.5 w-3.5 shrink-0 border border-dashed',
        item.type === 'habit' ? 'rounded-full' : 'rounded-[4px]'
      )}
    />
  );
}

function EntryMark({ entry }: { entry: PausedEntry }) {
  if (entry.kind === 'item') return <ItemMark item={entry.item} />;
  const c = entry.kind === 'routine' ? entry.routine : entry.season;
  return (
    <span className="flex w-3.5 shrink-0 justify-center" style={{ color: c.color ?? accentColorForName(c.name) }}>
      <CategoryIcon glyph={c.icon} name={c.name} className="h-3.5 w-3.5 shrink-0 text-current" />
    </span>
  );
}

/**
 * One paused thing: its mark, its name, what it is, and Resume.
 *
 * Trash's row shape (sections/trash.tsx), for Trash's reasons: two sibling
 * buttons, never one nested in the other, and the verb always visible rather
 * than hover-revealed, so touch and keyboard reach it.
 */
function PausedRow({
  entry,
  selected,
  onSelect,
  onResume,
  disabled,
}: {
  entry: PausedEntry;
  selected: boolean;
  onSelect: () => void;
  onResume: () => void;
  disabled: boolean;
}) {
  const name = pausedEntryName(entry);
  return (
    <div
      data-testid="paused-row"
      data-paused-kind={entry.kind}
      data-paused-key={entry.key}
      data-item-id={entry.kind === 'item' ? entry.item.id : undefined}
      data-selected={selected ? '' : undefined}
      className={cn(
        'group flex min-h-[34px] w-full items-center gap-[9px] rounded-[5px] px-[7px] py-1 hover:bg-accent',
        'data-[selected]:bg-[var(--row-selected)] data-[selected]:hover:bg-[var(--row-selected)]'
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        data-testid="paused-select"
        data-organize-row=""
        aria-pressed={selected}
        className="focus-visible:outline-ring flex min-w-0 flex-1 items-center gap-[9px] rounded-[5px] text-left focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-solid"
      >
        <EntryMark entry={entry} />
        <span className="min-w-0 flex-1">
          <span title={name} className="text-foreground block truncate text-sm font-medium">
            {name}
          </span>
          <span className="text-muted-foreground block truncate text-2xs">{entryKindLine(entry)}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={onResume}
        disabled={disabled}
        data-testid="paused-resume"
        aria-label={`Resume ${name}`}
        className="border-border text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:outline-ring flex h-[22px] shrink-0 items-center gap-1 rounded-[5px] border px-2 text-xs disabled:opacity-40 focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-solid"
      >
        <Play className="h-3 w-3" />
        {/* The word only beside the detail pane. Below md the list is the
            whole width of a phone sheet, minus the rail, and a worded button
            there left a title three letters. The label stays in aria-label. */}
        <span className="hidden md:inline">Resume</span>
      </button>
    </div>
  );
}

function PausedDetail({
  entry,
  todayStr,
  tz,
  onBack,
  onResume,
  onNavigate,
  sections,
  disabled,
}: {
  entry: PausedEntry;
  todayStr: string;
  tz: string;
  onBack: () => void;
  onResume: () => void;
  onNavigate: (section: ConsoleSection, id: string) => void;
  sections: readonly { id: ConsoleSection }[];
  disabled: boolean;
}) {
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const name = pausedEntryName(entry);

  // The state line in its long form: "Paused until Oct 30", "Hidden with your
  // Morning routine until Nov 1". Asked of the row itself, so it can never
  // disagree with what the grid would say.
  const first = entry.kind === 'item' ? entry.item : entry.items[0];
  const reason = first
    ? suppressionReason(first, todayStr, { userTimezone: tz, routines, seasons })
    : null;
  const stateLine = reason ? suppressionLabel(reason, { long: true }) : 'Paused';

  const container =
    entry.kind === 'routine'
      ? { section: 'routines' as const, id: entry.routine.id, noun: 'Routines' }
      : entry.kind === 'season'
        ? { section: 'seasons' as const, id: entry.season.id, noun: 'Seasons' }
        : null;
  const canOpenContainer = !!container && sections.some((s) => s.id === container.section);

  return (
    <div className="flex flex-col" data-testid="paused-detail" data-paused-key={entry.key}>
      <BackRow label="Paused" testId="paused-detail-back" onBack={onBack} />

      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center">
          <EntryMark entry={entry} />
        </span>
        <span className="min-w-0 flex-1">
          <span title={name} className="text-foreground block truncate text-base font-semibold">
            {name}
          </span>
          <span className="text-muted-foreground block text-2xs">{entryKindLine(entry)}</span>
        </span>
      </div>

      <div className="mt-4">
        <StatusStrip icon={<Moon className="h-3.5 w-3.5" />} testId="paused-detail-state">
          {stateLine}
          {entry.until ? '.' : '. It stays set aside until you resume it.'}
        </StatusStrip>
      </div>

      {entry.kind !== 'item' && (
        <div className="mt-5">
          <Eyebrow>Comes back with it</Eyebrow>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {entry.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => openStampedEdit({ ...item })}
                data-testid="paused-member"
                className="hover:bg-accent -mx-1.5 flex items-center gap-2 rounded-[5px] px-1.5 py-1 text-left text-sm"
              >
                <ItemMark item={item} />
                <span className="text-foreground min-w-0 truncate">{item.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onResume}
          disabled={disabled}
          data-testid="paused-detail-resume"
          className="border-border text-foreground hover:bg-accent focus-visible:outline-ring flex h-8 shrink-0 items-center gap-1.5 rounded-[5px] border px-3 text-sm disabled:opacity-40 focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-solid"
        >
          <Play className="h-3.5 w-3.5" />
          {entry.kind === 'season' ? 'Turn on now' : 'Resume now'}
        </button>
        {entry.kind === 'item' ? (
          <button
            type="button"
            // The item editor takes the one dialog slot, so this closes the
            // console behind it, exactly as opening an item from anywhere does.
            onClick={() => openStampedEdit({ ...entry.item })}
            data-testid="paused-detail-open"
            className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-8 items-center rounded-[5px] px-3 text-sm"
          >
            Open item
          </button>
        ) : (
          canOpenContainer && (
            <button
              type="button"
              onClick={() => onNavigate(container!.section, container!.id)}
              data-testid="paused-detail-container"
              className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-8 items-center rounded-[5px] px-3 text-sm"
            >
              Open in {container!.noun}
            </button>
          )
        )}
      </div>
    </div>
  );
}
