'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  subPanesOf,
  extensionSlugFromPane,
  settingsForPane,
  type SettingCtx,
} from '@/lib/settings/manifest';
import { extensionStateOf, toggleOf } from '@/lib/settings/extension-state';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useReminderStore } from '@/lib/reminder-store';

/**
 * /settings/extensions — the index, not the switches.
 *
 * Extensions grew config faster than the pane could hold it: a channel is a
 * toggle plus up to four fields plus a credential, and seven of those in one
 * column is a wall you scroll rather than a thing you set up. So each extension
 * became a pane of its own (see EXTENSION_PANES) and this is what the rail entry
 * now opens onto — one row per extension, leading in.
 *
 * DELIBERATELY NOT A LIST OF TOGGLES. The obvious version puts each extension's
 * switch on this page as well as inside it, and that breaks two things at once:
 * `data-setting-row` stops naming one place, so the ?focus= deep link and the
 * e2e handles get two candidates for the same id; and a switch nested inside a
 * link is a target that does two different things depending on the pixel. The
 * row shows the STATE instead and the switch stays where its config is, which
 * is also where the reason it can't be turned on is written.
 *
 * Each row reads its own state behind a try/catch, for the same reason the rest
 * of the extension surface does: one extension must never be able to cost the
 * others their row.
 */

export function ExtensionIndex({ ctx }: { ctx: SettingCtx }) {
  /* ── Subscriptions, stated rather than inherited ─────────────────────────
     The records read through getState(), so nothing below re-renders on its
     own. This component used to re-render only because the page rebuilds `ctx`
     off its own store ticks and nothing here is memoised — incidental coupling
     that a React.memo anywhere up the tree would quietly sever. These are the
     two stores a row's state actually depends on now, named here so the
     dependency survives that. */
  useExtensionsStore((s) => `${s.available}|${s.configsLoaded}|${JSON.stringify(s.enabled)}`);
  useReminderStore((s) => `${s.remindersEnabled}|${s.stakesEnabled}`);

  const panes = subPanesOf('extensions');

  return (
    <div className="divide-border divide-y" data-testid="extension-index">
      {panes.map((pane) => {
        const slug = extensionSlugFromPane(pane.id)!;
        const records = settingsForPane(pane.id);
        const toggle = toggleOf(records);
        const state = extensionStateOf(toggle, ctx);
        const Icon = pane.icon;
        // The toggle is a record too, so "how much is in here" is just the row
        // count — no second declaration to keep in step with the pane. It is a
        // SIZE, not a to-do count: it cannot decrease as fields are filled, and
        // it used to read "3 to set", which promised a progress it never made.
        const fields = records.length - (toggle ? 1 : 0);

        return (
          <Link
            key={pane.id}
            href={`/settings/${pane.id}`}
            data-extension-row={slug}
            // The state as one word, so a test can assert the index and the
            // pane agree without reading it back out of the styling.
            data-extension-state={state.label}
            className={cn(
              'hover:bg-accent -mx-3 flex w-[calc(100%+1.5rem)] items-center gap-3 rounded-[5px] px-3 py-3',
              'transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
            )}
          >
            <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="text-foreground block text-sm">{pane.name}</span>
              <span className="text-muted-foreground block text-xs">{pane.blurb}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {fields > 0 && (
                <span className="text-muted-foreground font-num hidden text-[10px] sm:inline">
                  {fields} {fields === 1 ? 'field' : 'fields'}
                </span>
              )}
              {/* A dot marks a VALUE — the house rule the destination rows'
                  square identity marker is the other half of. The lime accent
                  never rides a parent's opacity, so it gets its own element. */}
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium',
                  state.on ? 'bg-secondary text-foreground' : 'text-muted-foreground'
                )}
              >
                <span
                  className={cn(
                    'size-[6px] rounded-full',
                    state.on ? 'bg-primary' : 'bg-muted-foreground/40'
                  )}
                  aria-hidden
                />
                {state.label}
              </span>
              <ChevronRight className="text-muted-foreground size-3.5" aria-hidden />
            </span>
          </Link>
        );
      })}
    </div>
  );
}
