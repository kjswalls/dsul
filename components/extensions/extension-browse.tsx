'use client';

import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { cn } from '@/lib/utils';
import { useExtensionAdoptionStore } from '@/lib/extension-adoption-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useReminderStore } from '@/lib/reminder-store';
import { adoptionLine } from '@/lib/extension-adoption';
import { extensionStateForSlug, type ExtensionState } from '@/lib/settings/extension-state';
import { extensionPaneId, type SettingCtx } from '@/lib/settings/manifest';
import { extensionManifest, type ExtensionShelf } from '@/lib/extension-registry';
import { FEATURED_SLUG, STORE_SHELVES, catalogByShelf } from '@/lib/extension-catalog';
import { ExtensionPreview } from './previews/extension-preview';
import { ExtensionChips, ExtensionStatePill } from './extension-chips';
import { StoreCard } from './store-card';

type Filter = 'all' | 'on' | ExtensionShelf;

function isFilter(value: string | null | undefined): value is Filter {
  return value === 'all' || value === 'on' || STORE_SHELVES.some((shelf) => shelf.id === value);
}

/** Browse, on a given chip. 'all' is the bare pane. */
export function browseHref(filter: string | null | undefined): string {
  return isFilter(filter) && filter !== 'all' ? `/settings/extensions?shelf=${filter}` : '/settings/extensions';
}

/**
 * The store: the body of Settings → Extensions.
 *
 * It lives in the Extensions pane rather than on a page of its own, and your
 * own extensions sit beside it in the rail (extension-rail-list.tsx), so the
 * list and the store are one place. The settings shell owns everything around
 * it — the hydration gate, the type-mode stamp, the search box (which already
 * finds extensions by name and by their settings) — and widens the whole page
 * for it, because a shelf of cards needs more than the 600px a column of rows
 * does.
 *
 * Every card links to the extension's own pane with `?from=browse`, which is
 * what puts a "Back to Browse" link at the top of that pane. No card holds a
 * switch; the pane is where the switch lives.
 */
export function ExtensionBrowse({ ctx }: { ctx: SettingCtx }) {
  const adoptionStats = useExtensionAdoptionStore((s) => s.stats);
  const loadAdoption = useExtensionAdoptionStore((s) => s.load);
  useEffect(() => loadAdoption(), [loadAdoption]);

  // The chip lives in the URL (?shelf=), and every card carries it on to the
  // extension's pane, so "Back to Browse" returns to the same shelf.
  const router = useRouter();
  const shelfParam = useSearchParams()?.get('shelf');
  const filter: Filter = isFilter(shelfParam) ? shelfParam : 'all';
  const setFilter = (next: Filter) =>
    router.replace(browseHref(next), { scroll: false });
  const back = filter === 'all' ? '' : `&shelf=${filter}`;

  // The state words read these stores through getState(); the ticks are what
  // re-render the tab when they change — the same two the List tab names.
  const extensionsTick = useExtensionsStore((s) => `${s.available}|${s.configsLoaded}|${JSON.stringify(s.enabled)}`);
  const reminderTick = useReminderStore((s) => `${s.remindersEnabled}|${s.stakesEnabled}`);

  const states = useMemo(() => {
    const out: Record<string, ExtensionState> = {};
    for (const { extensions } of catalogByShelf()) {
      for (const extension of extensions) out[extension.slug] = extensionStateForSlug(extension.slug, ctx);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, extensionsTick, reminderTick]);

  const shown = useMemo(() => {
    const all = catalogByShelf().flatMap(({ extensions }) => extensions);
    if (filter === 'all') return all;
    if (filter === 'on') return all.filter((extension) => states[extension.slug]?.on);
    return all.filter((extension) => extension.shelf === filter);
  }, [filter, states]);

  const onCount = Object.values(states).filter((state) => state.on).length;
  const featured = filter === 'all' ? extensionManifest(FEATURED_SLUG) : undefined;

  const chips: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    ...STORE_SHELVES.map((shelf) => ({ id: shelf.id as Filter, label: shelf.name })),
    { id: 'on', label: `On · ${onCount}` },
  ];

  return (
    <div className="flex flex-col gap-7" data-testid="extension-browse">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter extensions">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            aria-pressed={filter === chip.id}
            onClick={() => setFilter(chip.id)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
              filter === chip.id
                ? 'bg-foreground text-background border-foreground'
                : 'border-border text-secondary-foreground bg-card hover:bg-accent'
            )}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {featured && (
        <Link
          href={`/settings/${extensionPaneId(featured.slug)}?from=browse${back}`}
          data-store-featured={featured.slug}
          className={cn(
            'bg-card border-border grid overflow-hidden rounded-xl border md:grid-cols-[1.45fr_1fr]',
            'transition-[border-color,box-shadow] duration-200 ease-out hover:border-foreground/20 hover:shadow-md',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
          )}
        >
          <ExtensionPreview
            slug={featured.slug}
            play="engaged"
            className="border-border border-b md:border-r md:border-b-0"
          />
          <span className="flex flex-col justify-center gap-3 p-6">
            <span className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">Featured</span>
            <span className="flex items-center gap-2">
              <span className="text-foreground text-xl font-semibold tracking-tight">{featured.name}</span>
              {states[featured.slug] && <ExtensionStatePill state={states[featured.slug]} />}
            </span>
            <span className="text-muted-foreground text-sm leading-relaxed">{featured.description}</span>
            <ExtensionChips extension={featured} state={states[featured.slug]} />
          </span>
        </Link>
      )}

      {shown.length === 0 ? (
        <p className="text-muted-foreground py-12 text-center text-sm">
          {filter === 'on' ? 'Nothing is switched on yet.' : 'Nothing here yet.'}
        </p>
      ) : (
        catalogByShelf(shown).map(({ shelf, extensions }) => (
          <section
            key={shelf.id}
            className="flex flex-col gap-3"
            data-store-shelf={shelf.id}
            aria-labelledby={`shelf-${shelf.id}`}
          >
            <header className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <h2 id={`shelf-${shelf.id}`} className="text-foreground text-[15px] font-semibold">
                {shelf.name}
              </h2>
              <span className="text-muted-foreground text-xs">{shelf.blurb}</span>
            </header>
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              {extensions.map((extension) => (
                <StoreCard
                  key={extension.slug}
                  extension={extension}
                  state={states[extension.slug]}
                  adoption={adoptionLine(adoptionStats[extension.slug])}
                  linkQuery={`from=browse${back}`}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
