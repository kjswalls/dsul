'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { CategoryIcon } from '@/lib/category-icons';
import { accentColorForName } from '@/lib/accent-colors';
import { usePlannerStore } from '@/lib/planner-store';
import { listDeleted, type TrashEntry, type TrashKind } from '@/lib/db';
import { formatShort, matching } from '@/lib/collections';
import {
  PRIORITY_LABELS,
  REPEAT_FREQUENCY_LABELS,
  TIME_BUCKET_RANGES,
  type Item,
} from '@/lib/planner-types';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { cn } from '@/lib/utils';
import { BackRow, DetailColumn, ListColumn, TeachingLine } from '../detail-parts';
import { Eyebrow } from '../primitives';

/** How long a soft-deleted row survives before the nightly purge (migration 036). */
const TRASH_WINDOW_DAYS = 30;

/** The console's selection is one string; the bin is the one list mixing kinds. */
const trashKey = (e: Pick<TrashEntry, 'kind' | 'id'>) => `${e.kind}:${e.id}`;

/**
 * TRASH — the last thirty days, and the only way back out of them.
 *
 * The one section that is NOT a view over planner-store. Everything else in the
 * console reads arrays the app already holds; the bin holds rows the store
 * deliberately never loads (every fetch filters `deleted_at is null`), so it
 * gets its own hook and its own fetch.
 *
 * THE BIN MUST NOT ENTER THE STORE, and this is law rather than tidiness.
 * `saveToHistory` snapshots five slices, and `applyHistoryState` reads "present
 * in current, absent in restored" as a DELETE — so a soft-deleted row parked in
 * `projects` would be soft-deleted AGAIN by the next ⌘Z, restamping
 * `deleted_at` and silently resetting its 30-day purge clock. Redo is worse: it
 * would un-delete rows the user never restored. Keeping the bin in a local hook
 * makes all of that unreachable rather than merely unlikely.
 *
 * It is also the only HETEROGENEOUS list in the console — five tables in one
 * column — which is why its row is its own component rather than ObjectRow. A
 * trash row has no selection, no count and no pill; it has a kind, a date and
 * exactly one verb.
 */

/* ── the hook ─────────────────────────────────────────────────────────── */

/**
 * The bin, fetched once per arrival.
 *
 * No polling and no refetch-on-focus: this is a thirty-day window on a
 * single-user planner, and the only thing that changes it while it is open is
 * the user's own restore, which is applied locally. Radix unmounts an inactive
 * tabpanel's subtree and Radix Dialog renders nothing while closed, so "per
 * arrival" is what mounting this component already means — no gate needed.
 */
function useTrash(userId: string | null) {
  const [bin, setBin] = useState<{ entries: TrashEntry[] | null; failed: boolean }>({
    entries: null,
    failed: false,
  });

  // Reset on an account switch during render rather than in the effect — the
  // codebase's "adjusting state when a prop changes" pattern (BufferedInput,
  // useNameDraft). An effect would paint one frame of the PREVIOUS account's
  // bin, and this is the one list where a row from the wrong account is also a
  // restore button for it.
  const [lastUser, setLastUser] = useState(userId);
  if (lastUser !== userId) {
    setLastUser(userId);
    setBin({ entries: null, failed: false });
  }

  useEffect(() => {
    if (!userId) return;
    let live = true;
    listDeleted(userId)
      .then((rows) => {
        if (live) setBin({ entries: rows, failed: false });
      })
      .catch((error) => {
        console.error('trash fetch failed', error);
        // A failed fetch SAYS SO. The alternative — rendering an empty list —
        // tells someone hunting for a deleted routine that it is gone for good,
        // which is the one wrong answer this surface can give.
        if (live) setBin({ entries: null, failed: true });
      });
    return () => {
      live = false;
    };
  }, [userId]);

  /** Drop a row locally once it is back — the fetch is not repeated. */
  const forget = useCallback((id: string, kind: TrashKind) => {
    setBin((prev) =>
      prev.entries
        ? { ...prev, entries: prev.entries.filter((r) => !(r.id === id && r.kind === kind)) }
        : prev
    );
  }, []);

  return { entries: bin.entries, failed: bin.failed, forget };
}

/* ── the section ──────────────────────────────────────────────────────── */

export function TrashSection({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const restoreFromTrash = usePlannerStore((s) => s.restoreFromTrash);
  const { entries, failed, forget } = useTrash(userId);
  const [query, setQuery] = useState('');

  const visible = matching(entries ?? [], query, (e) => `${e.name} ${KIND_LABEL[e.kind]}`);
  // Resolved against the WHOLE bin, not the filtered `visible`, exactly like
  // every other section resolves against its full array: a selection the user
  // then filters out still has its preview, rather than the pane blanking.
  const selected = entries?.find((e) => trashKey(e) === selectedId) ?? null;

  const restore = useCallback(
    (entry: TrashEntry) => {
      restoreFromTrash(entry);
      forget(entry.id, entry.kind);
      // The row leaves the list on restore; a selection still pointing at it
      // would leave the detail pane describing a ghost (and, below md, strand
      // the drill-in on a preview whose row is gone).
      if (trashKey(entry) === selectedId) onSelect(null);
    },
    [restoreFromTrash, forget, selectedId, onSelect]
  );

  return (
    <>
      <ListColumn
        eyebrow="TRASH"
        count={visible.length}
        // A selected row drives the mobile drill-in exactly like the other
        // sections now — below md the list hides and the preview replaces it.
        hasSelection={!!selected}
        filter={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter trash…',
          testId: 'trash-filter',
        }}
        // A failure and a still-loading bin both render zero rows, and neither
        // means "nothing matches your search". Only a LOADED bin may answer the
        // filter's question.
        suppressNoMatch={entries === null}
      >
        {failed ? (
          <p className="text-muted-foreground px-[7px] pt-2 text-xs" data-testid="trash-failed">
            Couldn&apos;t load the trash just now. Close and reopen to try again.
          </p>
        ) : entries === null ? (
          // Not a spinner: the layout law says the empty and populated states
          // are the same layout with rows missing, and a centred spinner is a
          // third shape that makes the pane jump twice.
          <p className="text-muted-foreground px-[7px] pt-2 text-xs">Looking…</p>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground px-[7px] pt-2 text-xs" data-testid="trash-empty">
            Nothing deleted in the last {TRASH_WINDOW_DAYS} days.
          </p>
        ) : (
          visible.map((entry) => (
            <TrashRow
              key={trashKey(entry)}
              entry={entry}
              selected={trashKey(entry) === selectedId}
              onSelect={() => onSelect(trashKey(entry))}
              onRestore={() => restore(entry)}
              disabled={!userId || isLoading}
            />
          ))
        )}
      </ListColumn>

      <DetailColumn hasSelection={!!selected}>
        {selected ? (
          <TrashPreview
            entry={selected}
            onRestore={() => restore(selected)}
            onBack={() => onSelect(null)}
            disabled={!userId || isLoading}
          />
        ) : (
          <>
            <TeachingLine>
              Anything you delete waits here for {TRASH_WINDOW_DAYS} days, then goes for good.
            </TeachingLine>
            {/* The one thing a bin has to say that its rows cannot: what ⌘Z will
                do after you press Restore. Decision 3 made restore a normal
                history entry precisely so the answer is the ordinary one. */}
            {/* "Members and all" was an overclaim and the review caught it: a
                restored project reconnects the items still pointing at it by ID,
                which is every item filed since migration 027 but NOT the older
                name-only references, and those come back on the next reload
                rather than in session. So the sentence promises what the row can
                show. */}
            <p className="text-muted-foreground mt-3 max-w-[46ch] text-xs">
              Restoring puts something back where it was, along with whatever the row says comes
              with it. ⌘Z after a restore sends it back here.
            </p>
          </>
        )}
      </DetailColumn>
    </>
  );
}

/* ── the row ──────────────────────────────────────────────────────────── */

const KIND_LABEL: Record<TrashKind, string> = {
  item: 'Item',
  project: 'Project',
  routine: 'Routine',
  season: 'Season',
  goal: 'Goal',
};

/**
 * A trash row: glyph, name, what it was, when it went, and Restore.
 *
 * NOT ObjectRow, and the reasons are structural rather than stylistic.
 * ObjectRow's root IS the `<button>` — nesting the Restore control inside it
 * would be invalid HTML — and its contract (pill, count) is meaningless here.
 * So the row body carries its OWN select button beside the Restore verb: two
 * sibling buttons in a div, never one nested in the other.
 *
 * THE KIND IS SPELLED OUT, not encoded in the glyph. Every other section in the
 * console is homogeneous, so its column header names the kind for every row at
 * once; this one is not. A name-hashed CategoryIcon carries no kind information
 * whatsoever, so a trashed task and a trashed project called "Reading" would be
 * pixel-identical — and ⌘Z after restoring the wrong one is not a recovery.
 *
 * The Restore button is always visible, never hover-revealed. This is the one
 * named exception to the console's no-per-row-actions rule, and the exception
 * exists because it is the row's second-most-likely intent after a look: hiding
 * the only path to the verb behind a hover is the anti-pattern, and it would put
 * a recovery feature out of reach of touch and keyboard entirely.
 */
function TrashRow({
  entry,
  selected,
  onSelect,
  onRestore,
  disabled,
}: {
  entry: TrashEntry;
  selected: boolean;
  onSelect: () => void;
  onRestore: () => void;
  disabled?: boolean;
}) {
  const children = entry.children?.length ?? 0;
  const members = entry.memberIds?.length ?? 0;

  return (
    <div
      data-testid="trash-row"
      data-trash-kind={entry.kind}
      data-trash-id={entry.id}
      data-selected={selected ? '' : undefined}
      className={cn(
        'group flex min-h-[34px] w-full items-center gap-[9px] rounded-[5px] px-[7px] py-1 hover:bg-accent',
        // Same recipe as ObjectRow: selection wins over hover so a selected row
        // never gets LIGHTER under the pointer.
        'data-[selected]:bg-[var(--row-selected)] data-[selected]:hover:bg-[var(--row-selected)]'
      )}
    >
      {/* The row body selects — its own button so the accessible name is the
          item ("Reading, Item · just now"), distinct from the Restore verb's
          "Restore item Reading". Deliberately NOT carrying `data-organize-row`:
          that stays on Restore so the filter's ↓↵ keeps doing the one thing a
          trash row is for. */}
      <button
        type="button"
        onClick={onSelect}
        data-testid="trash-select"
        aria-pressed={selected}
        className="focus-visible:outline-ring flex min-w-0 flex-1 items-center gap-[9px] rounded-[5px] text-left focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-solid"
      >
        <span
          className="flex w-[18px] shrink-0 justify-center"
          style={{ color: entry.color ?? accentColorForName(entry.name) }}
        >
          <CategoryIcon glyph={entry.icon} name={entry.name} className="h-3.5 w-3.5 shrink-0 text-current" />
        </span>

        <span className="min-w-0 flex-1">
          <span title={entry.name} className="text-foreground block truncate text-sm font-medium">
            {entry.name}
          </span>
          <span className="text-muted-foreground block truncate text-2xs">
            {KIND_LABEL[entry.kind]}
            {/* What comes back WITH it, said before the click rather than
                discovered after. Both are things the user cannot see from the
                row's name and would be surprised by either way round. */}
            {children > 0 && ` · ${children} ${children === 1 ? 'subtask' : 'subtasks'}`}
            {members > 0 && ` · ${members} ${members === 1 ? 'item' : 'items'} refile`}
            {' · '}
            <span className="font-num">{whenGone(entry.deletedAt)}</span>
          </span>
        </span>
      </button>

      <button
        type="button"
        onClick={onRestore}
        disabled={disabled}
        // The filter's ArrowDown target. `data-organize-row` is looked up with
        // querySelector at any depth inside the list, so putting it on the verb
        // rather than a row root keeps `/ type ↓ ↵` working AND makes Enter do
        // the only thing a trash row can do.
        data-organize-row=""
        data-testid="trash-restore"
        // The KIND is in the accessible name too, for the same reason it is on
        // the row: this is the one list that mixes kinds, so a trashed task and
        // a trashed project both called "Reading" would otherwise present two
        // buttons reading "Restore Reading" — and a screen-reader user would be
        // choosing between them blind, on the one surface where picking the
        // wrong one cannot be taken back by looking.
        aria-label={`Restore ${KIND_LABEL[entry.kind].toLowerCase()} ${entry.name}`}
        className="border-border text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:outline-ring flex h-[22px] shrink-0 items-center gap-1 rounded-[5px] border px-2 text-xs disabled:opacity-40 focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-solid"
      >
        <RotateCcw className="h-3 w-3" />
        Restore
      </button>
    </div>
  );
}

/* ── the preview ──────────────────────────────────────────────────────── */

/**
 * A read-only look at a trashed thing, in the third pane.
 *
 * Everything here is drawn from the bin's ONE existing fetch — the entity is a
 * fully live-shaped object, its co-deleted subtasks travel in `children`, and a
 * project's re-filing members in `memberIds`. So the preview costs no store
 * read and no new query, and — the load-bearing part — it makes NO writes.
 *
 * It is deliberately NOT the item editor. `ItemDialog`'s panel form closes
 * itself the instant its id is absent from the store (a trashed id always is),
 * every one of its controls writes, and `updateItemAction` silently drops writes
 * for a missing id — so an "editable" trashed item is a UI that lies. This pane
 * reads, and offers the one verb the bin has.
 */
function TrashPreview({
  entry,
  onRestore,
  onBack,
  disabled,
}: {
  entry: TrashEntry;
  onRestore: () => void;
  onBack: () => void;
  disabled?: boolean;
}) {
  // Invariant from listDeleted: kind 'item' ⟺ entity is an Item. Widened here
  // rather than on TrashEntry so the bin stays a plain data bag.
  const item = entry.kind === 'item' ? (entry.entity as Item) : null;
  const typeLabel = item ? getItemTypeConfig(itemTypeName(item)).label : KIND_LABEL[entry.kind];
  const left = daysUntilPurge(entry.deletedAt);

  return (
    <div className="flex flex-col" data-testid="trash-preview" data-trash-kind={entry.kind} data-trash-id={entry.id}>
      <BackRow label="Trash" testId="trash-preview-back" onBack={onBack} />

      {/* Static identity — read-only. NOT IdentityRow, whose name is an editable
          buffered input. The header glyph is NEUTRAL and larger, exactly like
          IdentityRow's IconPicker (size-5, muted): the console keeps the accent
          on the ≤14px list-row glyph only, so a lime container never draws a big
          chromatic mark here. Identity colour still reads off the row one pane
          left. */}
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center">
          <CategoryIcon glyph={entry.icon} name={entry.name} className="size-5 shrink-0" />
        </span>
        <span className="min-w-0 flex-1">
          <span title={entry.name} className="text-foreground block truncate text-base font-semibold">
            {entry.name}
          </span>
          <span className="text-muted-foreground block text-2xs">
            {typeLabel} · deleted <span className="font-num">{whenGone(entry.deletedAt)}</span>
            {' · '}gone for good in <span className="font-num">{left}d</span>
          </span>
        </span>
      </div>

      <div className="bg-border my-4 h-px" />

      {item ? <ItemFacts item={item} subtasks={entry.children ?? []} /> : <ContainerFacts entry={entry} />}

      {/* The verb, repeated in the pane so a selected row need not be re-found in
          the list to act on it. Bordered, never lime — the console keeps colour
          to identity glyphs. Its accessible name is the visible "Restore"; the
          pane heading one line up already names the subject. */}
      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={onRestore}
          disabled={disabled}
          data-testid="trash-preview-restore"
          className="border-border text-foreground hover:bg-accent focus-visible:outline-ring flex h-8 shrink-0 items-center gap-1.5 rounded-[5px] border px-3 text-sm disabled:opacity-40 focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-solid"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Restore
        </button>
        <span className="text-muted-foreground text-xs">puts it back where it was.</span>
      </div>
    </div>
  );
}

/** One label-left / value-right fact per set field on a trashed item. */
function ItemFacts({ item, subtasks }: { item: Item; subtasks: Item[] }) {
  const facts: { label: string; value: string }[] = [];

  const startDate = 'startDate' in item ? item.startDate : undefined;
  const bucket = item.timeBucket;
  const bucketLabel = bucket && bucket !== 'anytime' ? TIME_BUCKET_RANGES[bucket].label : null;
  if (startDate) {
    facts.push({ label: 'Was scheduled', value: bucketLabel ? `${formatShort(startDate)} · ${bucketLabel}` : formatShort(startDate) });
  } else if (bucketLabel) {
    facts.push({ label: 'Time of day', value: bucketLabel });
  }
  if (item.startTime) facts.push({ label: 'Time', value: item.startTime });
  if (item.duration) facts.push({ label: 'Length', value: `${item.duration} min` });
  const repeat = item.repeatFrequency;
  if (repeat && repeat !== 'none') facts.push({ label: 'Repeats', value: REPEAT_FREQUENCY_LABELS[repeat] });
  const priority = 'priority' in item ? item.priority : undefined;
  if (priority) facts.push({ label: 'Priority', value: PRIORITY_LABELS[priority] });
  if (item.project) facts.push({ label: 'Project', value: item.project });

  const notes = item.notes?.trim();

  return (
    <div className="flex flex-col gap-1">
      {facts.map((f) => (
        <div key={f.label} className="flex items-baseline justify-between gap-4 py-1 text-sm">
          <span className="text-muted-foreground shrink-0">{f.label}</span>
          <span className="text-foreground min-w-0 truncate text-right">{f.value}</span>
        </div>
      ))}

      {facts.length === 0 && !notes && subtasks.length === 0 && (
        <p className="text-muted-foreground text-sm">Nothing else was set.</p>
      )}

      {notes && (
        <div className="mt-3">
          <Eyebrow>Notes</Eyebrow>
          <p className="text-foreground mt-1.5 text-sm whitespace-pre-wrap">{notes}</p>
        </div>
      )}

      {subtasks.length > 0 && (
        <div className="mt-4">
          <Eyebrow>
            {subtasks.length} {subtasks.length === 1 ? 'subtask comes' : 'subtasks come'} back with it
          </Eyebrow>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {subtasks.map((child) => {
              const done = child.status === getItemTypeConfig(itemTypeName(child)).doneStatus;
              return (
                <div key={child.id} className="flex items-center gap-2 text-sm">
                  {done ? (
                    <Check className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <span className="border-muted-foreground/45 h-3.5 w-3.5 shrink-0 rounded-[4px] border" />
                  )}
                  <span className={cn('min-w-0 truncate', done ? 'text-muted-foreground line-through' : 'text-foreground')}>
                    {child.title}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** What restoring a trashed container reconnects — one honest sentence per kind. */
function ContainerFacts({ entry }: { entry: TrashEntry }) {
  const members = entry.memberIds?.length ?? 0;
  const sentence: Record<Exclude<TrashKind, 'item'>, string> = {
    project:
      members > 0
        ? `Restoring brings the project back and re-files the ${members} ${members === 1 ? 'item' : 'items'} still pointing at it.`
        : 'Restoring brings the project back. Nothing is filed under it right now.',
    routine: 'Restoring brings the routine back, along with the items it grouped.',
    season: 'Restoring brings the season back, along with the routines and items it held.',
    goal: 'Restoring brings the goal back, along with its milestones, check-ins and members.',
  };
  return (
    <p className="text-muted-foreground max-w-[52ch] text-sm">
      {sentence[entry.kind as Exclude<TrashKind, 'item'>]}
    </p>
  );
}

/**
 * How long ago, in the words a bin needs.
 *
 * Days rather than a date, because the only question a trash row has to answer
 * is "how much of my thirty days is left" — and "Aug 3" makes the reader do
 * that subtraction themselves. Rounded DOWN from the elapsed milliseconds, so
 * something deleted twenty-five hours ago reads "1d" rather than "2d" and the
 * count never runs ahead of the purge.
 */
export function whenGone(deletedAt: string, now = Date.now()): string {
  const elapsed = now - new Date(deletedAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Days of the 30-day window still left, for the preview's "gone for good in Nd".
 *
 * Counts DOWN from `whenGone`'s elapsed days so the two never disagree: freshly
 * deleted reads the full window, and anything past the purge boundary clamps to
 * 0 rather than a negative. A malformed or future stamp reads as the full window
 * — the same benefit-of-the-doubt `whenGone`'s "just now" gives.
 */
export function daysUntilPurge(deletedAt: string, now = Date.now()): number {
  const elapsed = now - new Date(deletedAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return TRASH_WINDOW_DAYS;
  return Math.max(0, TRASH_WINDOW_DAYS - Math.floor(elapsed / 86_400_000));
}
