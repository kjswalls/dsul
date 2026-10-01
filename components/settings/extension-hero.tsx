'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Store } from 'lucide-react';

import { extensionManifest } from '@/lib/extension-registry';
import { adoptionLine } from '@/lib/extension-adoption';
import { useExtensionAdoptionStore } from '@/lib/extension-adoption-store';
import { ExtensionPreview } from '@/components/extensions/previews/extension-preview';
import { ExtensionChips } from '@/components/extensions/extension-chips';

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

  if (!extension) return null;
  const adoption = adoptionLine(stats[slug]);

  return (
    <section className="mb-4 flex flex-col gap-4" data-extension-hero={slug} aria-label={`About ${extension.name}`}>
      <ExtensionPreview slug={slug} className="border-border rounded-[10px] border" />

      <div className="flex flex-col gap-2">
        <p className="text-foreground text-sm font-medium">{extension.tagline}</p>
        <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-4 text-xs leading-relaxed">
          {extension.whatChanges.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <ExtensionChips extension={extension} />
      </div>

      <blockquote className="border-border border-l-2 pl-3.5">
        <p className="text-foreground font-serif text-[15px] leading-relaxed">{extension.makerNote}</p>
        <footer className="text-muted-foreground mt-1 text-[11px]">From the maker</footer>
      </blockquote>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {adoption && <span className="font-num text-[11px]">{adoption}</span>}
        <Link href="/extensions" className="hover:text-foreground inline-flex items-center gap-1 transition-colors">
          <Store className="size-3.5" aria-hidden />
          All extensions
        </Link>
      </div>
    </section>
  );
}

/**
 * The Extensions pane's door to the store, above the list of extensions.
 * The list stays: it is still the quickest way to a switch you already know.
 */
export function ExtensionStoreDoor() {
  return (
    <Link
      href="/extensions"
      data-testid="extension-store-door"
      className="border-border bg-card hover:bg-accent mb-3 flex items-center gap-3 rounded-[10px] border px-3.5 py-3 transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
    >
      <Store className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block text-sm">Browse the extensions store</span>
        <span className="text-muted-foreground block text-xs">See each one working before you turn it on.</span>
      </span>
      <ArrowUpRight className="text-muted-foreground size-3.5" aria-hidden />
    </Link>
  );
}
