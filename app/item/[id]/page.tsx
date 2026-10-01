'use client';

import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ItemDialogState } from '@/components/planner/item-dialog';
import {
  ItemDetailSections,
  ItemThread,
} from '@/components/planner/item-detail-sections';
import { BandSquare } from '@/components/planner/item-bands';
import { usePlannerStore } from '@/lib/planner-store';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { useAICapabilities } from '@/lib/ai-connection-store';

/**
 * The item page — stage 3 of the surface (dialog → panel → page,
 * memory/plans/item-surface-growth.md). A deep-linkable route for when the
 * item IS the work: its fields, subtasks on the left, the thread on the right
 * (when something can answer in it; otherwise one column).
 *
 * THE FIELDS EDIT IN PLACE (Kirby, 2026-09-27). The page used to read the
 * properties out as static bands with an Edit button that opened the panel
 * beside them; now it lays the panel's own body into the page
 * (`presentation="inline"`), so the title, notes and every property chip are
 * the controls — the same autosave, the same clears — with nothing to open or
 * close. Subtasks and the thread stay the page's own (withDetailSections off,
 * so the editor does not mount a second live copy).
 *
 * Auth follows the app's client-side model: the root layout's
 * SupabaseProvider hydrates the store when a session exists; without one this
 * page simply has no items and shows the not-found state with a sign-in link.
 */

/* ItemDialog is the app's largest component and drags react-day-picker in
   behind it, so it stays its own chunk: the page's frame paints first and the
   editor arrives with it. `ssr: false` because the page has no session
   server-side to render an item from anyway. */
const ItemDialog = dynamic(
  () => import('@/components/planner/item-dialog').then((m) => m.ItemDialog),
  { ssr: false }
);

export default function ItemPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();
  /* Field selectors, not the whole store — `usePlannerStore()` bare
     re-renders on every set() anywhere. Selecting the item itself narrows it
     further: `find` returns the same object until that one row changes. */
  const item = usePlannerStore((s) => s.items.find((i) => i.id === id));
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  // The thread column exists only while something can answer in it.
  const { canChat } = useAICapabilities();

  /* Keyed on the id alone. The editor re-reads the live item from the store on
     every render; a fresh payload per write would read as a RETARGET and
     re-seed the draft under the cursor mid-edit. */
  const itemKey = item?.id;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const editState = useMemo<ItemDialogState | null>(() => (item ? { mode: 'edit', item } : null), [itemKey]);

  if (!item || !editState) {
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
          <BandSquare color={config.accent} />
          {config.label}
        </span>
      </nav>

      {/* The heading is the editor's title field; this keeps one for the outline. */}
      <h1 className="sr-only">{item.title}</h1>

      <div className="max-w-prose" data-testid="item-page-editor">
        {/* The panel's body, in the page's flow. onOpenChange(false) only
            fires here when the item is gone — deleted from its own ⋯ or from
            anywhere else — and a page about nothing goes home. */}
        <ItemDialog
          presentation="inline"
          state={editState}
          withDetailSections={false}
          onOpenChange={(open) => {
            if (!open) router.push('/');
          }}
        />
      </div>

      {/* Two columns only with a thread to fill the second: an empty 340px
          rail beside the subtasks would be a column for a feature that is off. */}
      <div
        className={
          canChat
            ? 'grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]'
            : 'grid items-start gap-8'
        }
      >
        <ItemDetailSections item={item} />
        {canChat && <ItemThread item={item} className="lg:border-border lg:border-l lg:pl-6" />}
      </div>
    </main>
  );
}
