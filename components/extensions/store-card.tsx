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
}: {
  extension: ExtensionManifest;
  state: ExtensionState;
  adoption: string | null;
}) {
  const Icon = extension.icon;
  return (
    <Link
      href={`/settings/${extensionPaneId(extension.slug)}`}
      data-store-card={extension.slug}
      data-extension-state={state.label}
      className={cn(
        'bg-card border-border group flex flex-col overflow-hidden rounded-[10px] border transition-[box-shadow,transform]',
        'hover:-translate-y-0.5 hover:shadow-md motion-reduce:hover:translate-y-0',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
      )}
    >
      <ExtensionPreview slug={extension.slug} className="border-border border-b" />
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
