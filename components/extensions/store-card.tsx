'use client';

import Link from 'next/link';

import { cn } from '@/lib/utils';
import { extensionPaneId } from '@/lib/settings/manifest';
import type { ExtensionManifest } from '@/lib/extension-registry';
import type { ExtensionState } from '@/lib/settings/extension-state';
import { ExtensionPreview } from './previews/extension-preview';
import { ExtensionChips, ExtensionStatePill } from './extension-chips';

/**
 * One extension in the store: the preview on top, then name, state, tagline.
 *
 * Its preview rests on a still frame until the card is hovered or focused — a
 * shelf of eleven loops all moving at once is noise, not a store.
 *
 * The whole card is a link to the extension's settings pane and holds NO
 * switch — the house rule from the settings index (a switch nested in a link is
 * a target that does two things depending on the pixel, and it would give the
 * ?focus= deep links two homes). The pane is where the switch, its fields and
 * the reason it might be unavailable all live.
 */
export function StoreCard({
  extension,
  state,
  adoption,
  linkQuery = 'from=browse',
}: {
  extension: ExtensionManifest;
  state: ExtensionState;
  adoption: string | null;
  /** What the pane is told about where you came from (Browse, and its chip). */
  linkQuery?: string;
}) {
  const Icon = extension.icon;
  return (
    <Link
      href={`/settings/${extensionPaneId(extension.slug)}?${linkQuery}`}
      data-store-card={extension.slug}
      data-extension-state={state.label}
      className={cn(
        'bg-card border-border group flex flex-col overflow-hidden rounded-[10px] border',
        // One eased lift, with the shadow and border fading in alongside it —
        // the bare 150ms default snapped. Reduced motion keeps the shadow only.
        'transition-[translate,box-shadow,border-color] duration-200 ease-out motion-reduce:transition-[box-shadow,border-color]',
        'hover:border-foreground/20 hover:-translate-y-0.5 hover:shadow-md motion-reduce:hover:translate-y-0',
        'focus-visible:border-foreground/20 focus-visible:-translate-y-0.5 focus-visible:shadow-md motion-reduce:focus-visible:translate-y-0',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
      )}
    >
      <ExtensionPreview slug={extension.slug} play="engaged" className="border-border border-b" />
      <span className="flex flex-1 flex-col gap-1.5 px-3.5 pt-3 pb-3.5">
        <span className="flex items-center gap-2">
          <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
          <span className="text-foreground min-w-0 flex-1 text-sm font-medium">{extension.name}</span>
          <ExtensionStatePill state={state} />
        </span>
        <span className="text-muted-foreground text-xs leading-relaxed">{extension.tagline}</span>
        <ExtensionChips extension={extension} state={state} className="mt-0.5" />
        {adoption && <span className="text-muted-foreground font-num mt-auto pt-1 text-[10px]">{adoption}</span>}
      </span>
    </Link>
  );
}
