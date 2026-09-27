'use client';

import { useCallback, useState } from 'react';
import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ChevronLeft, Moon, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ItemDialogState } from '@/components/planner/item-dialog';
import {
  ItemDetailSections,
  ItemThread,
} from '@/components/planner/item-detail-sections';
import {
  BandChip,
  BandSquare,
  ContainerBandsReadout,
  ItemBand,
  ItemBandGroup,
} from '@/components/planner/item-bands';
import { usePlannerStore } from '@/lib/planner-store';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { suppressionReason, suppressionLabel } from '@/lib/active';
import { REPEAT_FREQUENCY_LABELS } from '@/lib/planner-types';
import { toDateStr } from '@/lib/recurrence';
import { cn } from '@/lib/utils';

/**
 * The item page — stage 3 of the surface (dialog → panel → page,
 * memory/plans/item-surface-growth.md). A deep-linkable route for when the
 * item IS the work: properties and subtasks on the left, the thread on the
 * right. Property editing stays in the panel (the Edit button opens the same
 * ItemDialog this page mounts locally — the shell's instance lives in
 * AppShell, which this route deliberately doesn't render).
 *
 * Auth follows the app's client-side model: the root layout's
 * SupabaseProvider hydrates the store when a session exists; without one this
 * page simply has no items and shows the not-found state with a sign-in link.
 */

/* ── The editor, deferred until Edit is pressed ────────────────────────────
   ItemDialog is the app's largest single component and it drags react-day-picker
   in behind it (the start-date field). Deferring it takes 90.3 kB gzip off this
   route's first load (396,875 → 306,564 bytes: clean production builds of both
   commits, the route's own script tags, shared chunks deduped, gzip -9) — for a
   panel that opens on a button press and is closed on arrival every time. What
   is left is 7.8 kB above /ledger, the lightest route in the app and so the
   nearest thing to the baseline every route pays. /ledger itself moved +210
   bytes across the same pair of builds, which is the noise floor these deltas
   sit on.

   `ssr: false` because the panel renders nothing while closed, and the page it
   sits on has no session server-side to render an item from anyway.

   MOUNTED ON FIRST OPEN AND KEPT, never unmounted on close: next/dynamic
   fetches the chunk when the component first RENDERS, so leaving it mounted at
   `state={null}` would download it on page load and split nothing. `everOpened`
   below is that latch, and the DOWNLOAD is its whole justification — there is
   no exit animation here to protect: `presentation="panel"` hard-returns null
   while closed (see SurfaceContent, whose own note says the e2e suite asserts
   the surface reaches count 0 after a close). Unmounting on close would defer
   the download just as well — `{editState && …}` needs no latch at all — and is
   not chosen only because the app's other two ItemDialogs live mounted for the
   whole session (see the trashed-names fetch inside it, gated on `state` for
   exactly that reason), so this one matches them rather than inventing a third
   lifecycle. */
const ItemDialog = dynamic(
  () => import('@/components/planner/item-dialog').then((m) => m.ItemDialog),
  { ssr: false }
);

/* The chip and the identity square are the BAND vocabulary now
   (components/planner/item-bands.tsx) — the same marks the edit panel uses, so
   the two surfaces read as one grammar rather than two that resemble each
   other. Aliased rather than renamed at every call site below. */
const Square = BandSquare;
const StaticChip = BandChip;

export default function ItemPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  /* Field selectors, not the whole store. `usePlannerStore()` bare subscribes
     to the store OBJECT, which zustand replaces on EVERY set(), so this page
     re-rendered its whole thread on any planner mutation anywhere in the app.
     Said honestly: no such tick was found reaching this route while it sits
     idle. The obvious candidate is not one — hover writes go to a module ref
     (lib/hovered-item.ts), planner-store's `setHoveredItem` has no caller left
     in the repo, and SubtasksSection renders its own rows rather than TaskRow.
     So this is not a fix for an observed stall; it is a narrowing that is
     correct and free, on a page whose only live input is one item. Selecting
     the item itself rather than `items` narrows it further: `find` returns the
     same object identity until that one row actually changes. */
  const item = usePlannerStore((s) => s.items.find((i) => i.id === id));
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const [editState, setEditState] = useState<ItemDialogState | null>(null);
  // Latched on the first Edit press — see the note on the dynamic import.
  const [everOpened, setEverOpened] = useState(false);
  const openEditor = useCallback((next: ItemDialogState) => {
    setEverOpened(true);
    setEditState(next);
  }, []);

  if (!item) {
    // initializeStore stamps userId BEFORE the items fetch resolves, so
    // "signed in" alone doesn't mean "loaded" — without the isLoading check a
    // valid deep link flashes the not-found copy for the whole fetch.
    const settled = !!userId && !isLoading;
    return (
      <main className="mx-auto flex max-w-lg flex-col items-start gap-4 px-6 py-16">
        <h1 className="text-foreground text-lg font-semibold">
          {settled ? 'Item not found' : 'Loading…'}
        </h1>
        <p className="text-muted-foreground text-sm">
          {settled
            ? 'It may have been deleted, or the link is from another account.'
            : 'If nothing loads, you may need to sign in.'}
        </p>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/">Open dsul</Link>
          </Button>
          {!userId && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/login?redirect=${encodeURIComponent(`/item/${id ?? ''}`)}`}>
                Sign in
              </Link>
            </Button>
          )}
        </div>
      </main>
    );
  }

  const config = getItemTypeConfig(itemTypeName(item));
  // Resolved at TODAY, never at a navigated date — pausing is dateless
  // (plan decision 3), and this page has no date to navigate anyway. Without
  // it the header below asserts a startDate and a bucket for an item that is
  // on no grid column, and nothing on the page says why.
  const activationTz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The full reason, not just the item's own pause: a member of a paused
  // routine or a switched-off season is equally absent from every grid
  // column, and this page's header otherwise asserts a startDate and a bucket
  // with nothing explaining why.
  const activationReason = suppressionReason(item, toDateStr(new Date(), activationTz), {
    userTimezone: activationTz,
    routines,
    seasons,
  });
  // The When band's own content, resolved before the JSX so the band can ask
  // whether it has anything to say. A habit has no startDate to answer with —
  // its 'when' is the recurrence and the bucket.
  const whenDate = item.type !== 'habit' ? item.startDate : undefined;
  const repeats =
    item.repeatFrequency && item.repeatFrequency !== 'none'
      ? REPEAT_FREQUENCY_LABELS[item.repeatFrequency]
      : null;

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
      <nav className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Link
          href="/"
          className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
        >
          <ChevronLeft className="size-3.5" />
          dsul
        </Link>
        <span>/</span>
        <span className="text-foreground inline-flex items-center gap-1.5 font-medium">
          <Square color={config.accent} />
          {config.label}
        </span>
      </nav>

      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <h1
            className={cn(
              'text-foreground text-2xl font-semibold tracking-tight text-balance',
              item.status === 'completed' && 'text-muted-foreground line-through'
            )}
          >
            {item.title}
          </h1>
          <Button
            variant="outline"
            size="sm"
            data-testid="item-page-edit"
            onClick={() => openEditor({ mode: 'edit', item })}
          >
            <Pencil className="size-3.5" />
            Edit
          </Button>
        </div>

        {/* The identity row: what this is, and how much it matters. Everything
            else has a band of its own below — and this row is GONE when it has
            nothing, because an empty flex row still spends the header's gap. A
            band is what renders empty; a fact is not. */}
        {(activationReason || (item.type !== 'habit' && item.priority)) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {/* First in the row, ahead of the When band it qualifies. Muted,
                never a warning color — paused is not an error state. */}
            {activationReason && (
              <StaticChip testId="item-page-paused-note">
                <Moon className="size-3.5 shrink-0" aria-hidden />
                {suppressionLabel(activationReason)}
              </StaticChip>
            )}
            {item.type !== 'habit' && item.priority && (
              <StaticChip>
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: `var(--priority-${item.priority})` }}
                  aria-hidden
                />
                <span className="capitalize">{item.priority}</span>
              </StaticChip>
            )}
          </div>
        )}

        {/* The bands — the same rows, in the same order, under the same nouns
            as the edit panel (components/planner/item-bands.tsx). The page had
            been showing a project and nothing else: an item could sit in three
            routines, a season and two goals and its own page never said so.

            The container bands come from the registry, which is also what makes
            the empty ones render: a band you have never used is still a band
            you can find, and pressing its "+ Add" opens the editor rather than
            growing a second write path onto this surface. */}
        {/* Its own testid: the edit panel renders the same band ids, and on
            THIS route both are on screen at once. */}
        <ItemBandGroup className="max-w-prose" testId="item-page-bands">
          {(whenDate || item.timeBucket || repeats) && (
            <ItemBand label="When" testId="item-band-when">
              {whenDate && <StaticChip>{whenDate}</StaticChip>}
              {item.timeBucket && (
                <StaticChip>
                  <span className="capitalize">{item.timeBucket}</span>
                  {item.startTime ? ` · ${item.startTime}` : ''}
                  {item.duration ? ` · ${item.duration}m` : ''}
                </StaticChip>
              )}
              {repeats && <StaticChip testId="item-page-repeat">{repeats}</StaticChip>}
            </ItemBand>
          )}
          <ContainerBandsReadout item={item} onAdd={() => openEditor({ mode: 'edit', item })} />
        </ItemBandGroup>

        {item.notes && (
          <p className="text-muted-foreground max-w-prose text-sm leading-relaxed whitespace-pre-wrap">
            {item.notes}
          </p>
        )}
      </header>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        <ItemDetailSections item={item} />
        <ItemThread item={item} className="lg:border-border lg:border-l lg:pl-6" />
      </div>

      {/* The same docked panel the shell uses, not a modal: a modal here would
          make the page's own subtasks and thread inert behind an invisible
          overlay (edit mode drops the scrim, so nothing would explain why).
          withDetailSections={false} because those sections are already on the
          page — the panel beside them must not mount a second live copy. */}
      {everOpened && (
        <div className="fixed inset-y-3 right-3 z-30">
          <ItemDialog
            presentation="panel"
            state={editState}
            withDetailSections={false}
            onOpenChange={(open) => !open && setEditState(null)}
          />
        </div>
      )}
    </main>
  );
}
