'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ChevronLeft, Store } from 'lucide-react';

import { extensionManifest } from '@/lib/extension-registry';
import { adoptionLine } from '@/lib/extension-adoption';
import { useExtensionAdoptionStore } from '@/lib/extension-adoption-store';
import { ExtensionPreview } from '@/components/extensions/previews/extension-preview';
import { ExtensionChips } from '@/components/extensions/extension-chips';
import { browseHref } from '@/components/extensions/extension-browse';

/**
 * The top of an extension's settings pane: what it looks like, what it
 * changes, what it needs, and why it exists — the store's detail page.
 *
 * It sits ABOVE the pane's rows and owns nothing inside them. The switch is
 * still the pane's own record (one free switch per pane, asserted in
 * tests/unit/settings-manifest.test.ts), and so is the "Unavailable — needs …"
 * reason, which is why this header shows needs and cost but not state.
 *
 * Nothing here is a setting record, so none of it is searchable or
 * deep-linkable; it is copy, read from the extension's manifest entry.
 */
export function ExtensionHero({ slug }: { slug: string }) {
  const extension = extensionManifest(slug);
  const stats = useExtensionAdoptionStore((s) => s.stats);
  const load = useExtensionAdoptionStore((s) => s.load);
  useEffect(() => load(), [load]);
  // Cards in Browse link here with ?from=browse. The crumb already goes back to
  // the Extensions pane (on whichever tab you used last), but from the store
  // "back" means the store, so that gets a link of its own at the top.
  const params = useSearchParams();
  const fromBrowse = params?.get('from') === 'browse';
  const backHref = browseHref(params?.get('shelf'));

  if (!extension) return null;
  const adoption = adoptionLine(stats[slug]);

  return (
    <section className="mb-4 flex flex-col gap-4" data-extension-hero={slug} aria-label={`About ${extension.name}`}>
      {fromBrowse && (
        <Link
          href={backHref}
          data-testid="extension-back-to-browse"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start text-xs transition-colors"
        >
          <ChevronLeft className="size-3.5" aria-hidden />
          Back to Browse
        </Link>
      )}

      {/* A thumbnail beside the summary, not a banner over it: the pane is a
          column of rows like every other settings pane, and a full-width
          16:10 box opened it on a large, mostly empty stage. */}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)] sm:items-start">
        <ExtensionPreview slug={slug} className="border-border rounded-[8px] border" />
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-foreground text-sm font-medium">{extension.tagline}</p>
          <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-4 text-xs leading-relaxed">
            {extension.whatChanges.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <ExtensionChips extension={extension} />
        </div>
      </div>

      <blockquote className="border-border border-l-2 pl-3">
        <p className="text-foreground font-serif text-[13.5px] leading-relaxed">{extension.makerNote}</p>
        <footer className="text-muted-foreground mt-0.5 text-[11px]">From the maker</footer>
      </blockquote>

      {(adoption || !fromBrowse) && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {adoption && <span className="font-num text-[11px]">{adoption}</span>}
          {!fromBrowse && (
            <Link
              href="/settings/extensions?view=browse"
              className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
            >
              <Store className="size-3.5" aria-hidden />
              Browse all extensions
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
