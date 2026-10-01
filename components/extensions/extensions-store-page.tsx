'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import { ChevronLeft, Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { usePlannerStore } from '@/lib/planner-store';
import { useMorningStore } from '@/lib/morning-store';
import { useViewStore } from '@/lib/view-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useReminderStore } from '@/lib/reminder-store';
import { useExtensionAdoptionStore } from '@/lib/extension-adoption-store';
import { adoptionLine } from '@/lib/extension-adoption';
import { settingsBelongToUser } from '@/lib/settings/hydration';
import { extensionStateForSlug } from '@/lib/settings/extension-state';
import { extensionPaneId, type SettingCtx } from '@/lib/settings/manifest';
import { extensionManifest, type ExtensionShelf } from '@/lib/extension-registry';
import { FEATURED_SLUG, STORE_SHELVES, catalogByShelf, searchCatalog } from '@/lib/extension-catalog';
import { ExtensionPreview } from './previews/extension-preview';
import { ExtensionChips, ExtensionStatePill } from './extension-chips';
import { StoreCard } from './store-card';

type Filter = 'all' | 'on' | ExtensionShelf;

/**
 * /extensions — the store.
 *
 * A route of its own, not a settings pane: the settings column is 600px, and a
 * shelf of cards that each run a live preview needs the width. Settings keeps
 * its Extensions list (that is still where every switch lives), and its pane
 * opens with a door to here.
 *
 * Like /ledger and /settings this renders without AppShell, so it does by hand
 * the two things of AppShell's it needs: the <html data-type-mode> stamp, and a
 * hydration gate. The gate matters because the state words read the reminder
 * store's master switches, which are localStorage-persisted under a
 * browser-global key — before the settings request settles they are the
 * PREVIOUS account's, and a card would say "On" beside an extension that is
 * unavailable for this one. This page writes nothing, so nothing needs flushing.
 *
 * It is a lean route (lib/route-data.ts): it never loads items, and every
 * preview is inert sample data.
 */
export function ExtensionsStorePage() {
  const { theme, setTheme } = useTheme();
  const userId = usePlannerStore((s) => s.userId);
  const hydratedUserId = useMorningStore((s) => s.settingsHydratedUserId);

  const typeMode = useViewStore((s) => s.typeMode);
  useEffect(() => {
    document.documentElement.dataset.typeMode = typeMode;
  }, [typeMode]);

  // The state words read through getState(); these are what re-render the page
  // when they change — the same two stores the settings index names.
  const extensionsTick = useExtensionsStore((s) => `${s.available}|${s.configsLoaded}|${JSON.stringify(s.enabled)}`);
  const reminderTick = useReminderStore((s) => `${s.remindersEnabled}|${s.stakesEnabled}`);

  const adoptionStats = useExtensionAdoptionStore((s) => s.stats);
  const loadAdoption = useExtensionAdoptionStore((s) => s.load);
  useEffect(() => loadAdoption(), [loadAdoption]);

  const ctx = useMemo<SettingCtx>(
    () => ({ theme, setTheme, userId }),
    // The ticks are what make every state word recompute on a store change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme, setTheme, userId, extensionsTick, reminderTick]
  );

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const states = useMemo(() => {
    const out: Record<string, ReturnType<typeof extensionStateForSlug>> = {};
    for (const { extensions } of catalogByShelf()) {
      for (const extension of extensions) out[extension.slug] = extensionStateForSlug(extension.slug, ctx);
    }
    return out;
  }, [ctx]);

  const matches = useMemo(() => {
    const found = searchCatalog(query);
    if (filter === 'all') return found;
    if (filter === 'on') return found.filter((extension) => states[extension.slug]?.on);
    return found.filter((extension) => extension.shelf === filter);
  }, [query, filter, states]);

  const onCount = Object.values(states).filter((state) => state.on).length;
  const browsing = query.trim() === '' && filter === 'all';
  const featured = extensionManifest(FEATURED_SLUG);

  if (!settingsBelongToUser(userId, hydratedUserId)) {
    return (
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8" data-testid="extensions-store" data-store-state="loading">
        <StoreHeader />
        <div className="grid animate-pulse gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="bg-muted aspect-[16/14] rounded-[10px]" />
          ))}
        </div>
      </main>
    );
  }

  const chips: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    ...STORE_SHELVES.map((shelf) => ({ id: shelf.id as Filter, label: shelf.name })),
    { id: 'on', label: `On · ${onCount}` },
  ];

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-8" data-testid="extensions-store" data-store-state="ready">
      <StoreHeader />

      <div className="flex flex-col gap-3">
        <label className="bg-secondary text-muted-foreground focus-within:ring-ring flex max-w-md items-center gap-2 rounded-lg px-3 py-2 text-sm focus-within:ring-2">
          <Search className="size-4 shrink-0" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search extensions"
            aria-label="Search extensions"
            // The X below is the clear control; the browser's own would make two.
            className="text-foreground placeholder:text-muted-foreground -mx-1 min-w-0 flex-1 bg-transparent px-1 outline-none [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter extensions">
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              aria-pressed={filter === chip.id}
              onClick={() => setFilter(chip.id)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                filter === chip.id
                  ? 'bg-foreground text-background border-foreground'
                  : 'border-border text-secondary-foreground bg-card hover:bg-accent'
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      {browsing && featured && (
        <Link
          href={`/settings/${extensionPaneId(featured.slug)}`}
          data-store-featured={featured.slug}
          className={cn(
            'bg-card border-border grid overflow-hidden rounded-xl border md:grid-cols-[1.45fr_1fr]',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
          )}
        >
          <ExtensionPreview slug={featured.slug} className="border-border border-b md:border-r md:border-b-0" />
          <span className="flex flex-col justify-center gap-3 p-6">
            <span className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">Featured</span>
            <span className="flex items-center gap-2">
              <span className="text-foreground text-2xl font-semibold tracking-tight">{featured.name}</span>
              {states[featured.slug] && <ExtensionStatePill state={states[featured.slug]} />}
            </span>
            <span className="text-muted-foreground text-sm leading-relaxed">{featured.description}</span>
            <ExtensionChips extension={featured} state={states[featured.slug]} />
            <span className="bg-primary text-primary-foreground self-start rounded-md px-3 py-1.5 text-sm font-medium">
              See how it works
            </span>
          </span>
        </Link>
      )}

      {matches.length === 0 ? (
        <p className="text-muted-foreground py-12 text-center text-sm">{emptyLine(query, filter)}</p>
      ) : (
        catalogByShelf(matches).map(({ shelf, extensions }) => (
          <section key={shelf.id} className="flex flex-col gap-3" data-store-shelf={shelf.id} aria-labelledby={`shelf-${shelf.id}`}>
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
                />
              ))}
            </div>
          </section>
        ))
      )}
    </main>
  );
}

/** What an empty result says, worded for the search and the chip that emptied it. */
function emptyLine(query: string, filter: Filter): string {
  const q = query.trim();
  if (filter === 'on') return q ? `Nothing you have on matches “${q}”.` : 'Nothing is switched on yet.';
  const shelf = STORE_SHELVES.find((s) => s.id === filter);
  if (shelf) return q ? `Nothing in ${shelf.name} matches “${q}”.` : `Nothing in ${shelf.name} yet.`;
  return `No extension matches “${q}”.`;
}

function StoreHeader() {
  return (
    <>
      <nav className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Link href="/" className="hover:text-foreground inline-flex items-center gap-1 transition-colors">
          <ChevronLeft className="size-3.5" aria-hidden />
          dsul
        </Link>
        <span aria-hidden>/</span>
        <Link href="/settings/extensions" className="hover:text-foreground transition-colors">
          Settings
        </Link>
        <span aria-hidden>/</span>
        <span className="text-foreground font-medium">Extensions</span>
      </nav>
      <header className="flex flex-col gap-2">
        <h1 className="text-foreground text-2xl font-semibold tracking-tight">Extensions</h1>
        <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
          Extra things dsul can do. Open one to see what it changes and to switch it on or off.
        </p>
      </header>
    </>
  );
}
