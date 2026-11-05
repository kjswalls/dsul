'use client';

import { useCallback } from 'react';
import { RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { SettingRow } from './setting-row';
import { SettingsCard, SettingsSectionLabel } from './settings-card';
import { encodeKeys } from '@/lib/commands/keys';
import { useKeyboardShortcutsStore, useShortcutBindings } from '@/lib/keyboard-shortcuts-store';
import {
  SHORTCUT_SECTIONS,
  type SettingCtx,
  type ShortcutSettingRecord,
} from '@/lib/settings/manifest';

/**
 * The shortcuts table: every binding, grouped, rebindable in place.
 *
 * ONE COMPONENT, TWO SHELLS (`variant`) — the arrangement
 * components/sidebar/omnibar.tsx already uses. The records come from
 * SHORTCUT_RECORDS in lib/settings/manifest.ts, which is the single derivation
 * of the binding list, and this renders them in two chromes:
 *
 *   'pane'    — the Keyboard pane of /settings. No height cap: that surface
 *               scrolls the DOCUMENT (settings-shell.tsx says why), so a box
 *               with its own scrollbar here would be a second one inside it.
 *   'overlay' — the ⌘/ dialog over your work. Its shell supplies a plain
 *               `overflow-y-auto` box with a real height cap; <ScrollArea>
 *               silently drops `max-h` (CLAUDE.md), so it is not used.
 *
 * Everything else is shared: the sections and their order, the rows, the
 * recorder, the conflict check, the reset button. Only the chrome, the height
 * ownership, the copy, and the bare-key claim read off `variant`.
 *
 * Exposed as `data-shortcuts-variant` so a test can target one shell
 * unambiguously when both are reachable — the same reason the omnibar exposes
 * `data-omnibar-variant`.
 */

export type ShortcutsPanelVariant = 'pane' | 'overlay';

/**
 * A section heading as an id.
 *
 * Slugged, and that is not tidiness: `aria-labelledby` takes a SPACE-SEPARATED
 * LIST of ids, so "Rituals & Beacon" would be read as three ids, none of which
 * exists, and the section would end up with no accessible name at all.
 */
const headingId = (heading: string) =>
  `shortcuts-${heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

/**
 * One button, two placements. The pane puts it at the end of the list; the
 * overlay pins it in the dialog's footer, where the list scrolls past it.
 * Sharing the component is what keeps "reset" meaning the same thing in both.
 */
export function ResetAllShortcutsButton({ className }: { className?: string }) {
  const resetShortcuts = useKeyboardShortcutsStore((s) => s.resetShortcuts);
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        'text-muted-foreground hover:text-foreground h-7 gap-1.5 px-2 text-xs',
        className
      )}
      onClick={resetShortcuts}
      data-testid="shortcuts-reset-all"
    >
      <RotateCcw className="size-3" aria-hidden />
      Reset to defaults
    </Button>
  );
}

export function ShortcutsPanel({
  variant,
  ctx,
  highlightId,
  onReset,
}: {
  variant: ShortcutsPanelVariant;
  ctx: SettingCtx;
  /** The row a ?focus= deep link has arrived at, ringed for a moment. */
  highlightId?: string | null;
  /** The pane's reset, which also announces what it did. Defaults to a plain write. */
  onReset?: (record: ShortcutSettingRecord) => void;
}) {
  const isOverlay = variant === 'overlay';
  const isMobile = useIsMobile();

  // The reactive read. Records read through the store singleton so the manifest
  // stays a plain module, and this subscription is what re-renders the table
  // when a binding changes — including from the OTHER shell, if both are open.
  const bindings = useShortcutBindings();
  const keysById = new Map(bindings.map((binding) => [binding.id, binding.keys]));

  const resetOne = useCallback(
    (record: ShortcutSettingRecord) => {
      if (onReset) onReset(record);
      else record.write(record.defaultValue, ctx);
    },
    [onReset, ctx]
  );

  return (
    <div
      data-shortcuts-variant={variant}
      data-testid="shortcuts-panel"
      // A surface built out of <button>s is not "typing" by the dispatcher's
      // isFocusedOnInput test, so every single-letter global still fires from a
      // focused row — `n` would replace this dialog in the single ActiveDialog
      // slot and `⌫` would delete whatever the canvas still thinks is hovered.
      // The overlay claims the bare-key space; the pane does not need to,
      // because /settings mounts no global dispatcher and its own '/' handler
      // is something you still want.
      data-keys-local={isOverlay ? 'true' : undefined}
      className="flex flex-col"
    >
      {/* One hint, said once, in both shells — the overlay's version of it used
          to live in the dialog, which is how the pane ended up never mentioning
          that a row is something you press. */}
      <p className="text-muted-foreground pb-1 text-xs">
        Press a shortcut to record a new one. Escape cancels.
        {isMobile && ' These apply on a device with a keyboard.'}
      </p>

      {SHORTCUT_SECTIONS.map((section) => {
        const rows = section.records.map((record) => (
          <SettingRow
            key={record.id}
            record={record}
            ctx={ctx}
            // From the subscription, not from record.read(ctx): the manifest
            // reads through getState(), which is not reactive, so a row fed
            // that way would keep showing the old chord until something else
            // re-rendered it.
            value={encodeKeys(keysById.get(record.shortcutId) ?? [])}
            highlighted={highlightId === record.id}
            onWrite={(next) => record.write(next, ctx)}
            onReset={() => resetOne(record)}
          />
        ));
        return (
          <section key={section.heading} aria-labelledby={headingId(section.heading)}>
            {isOverlay ? (
              <>
                <p
                  id={headingId(section.heading)}
                  className="text-muted-foreground mt-4 mb-1 flex items-center gap-2 text-[10px] font-medium tracking-wider uppercase"
                >
                  {section.heading}
                </p>
                <div className="divide-border divide-y">{rows}</div>
              </>
            ) : (
              // The pane draws each group as a card like every other pane
              // (settings-card.tsx); the overlay keeps its compact list.
              <div className="mt-6">
                <SettingsSectionLabel id={headingId(section.heading)} as="p">
                  {section.heading}
                </SettingsSectionLabel>
                <SettingsCard>{rows}</SettingsCard>
              </div>
            )}
          </section>
        );
      })}

      {!isOverlay && (
        <div className="mt-4 flex justify-end">
          <ResetAllShortcutsButton />
        </div>
      )}
    </div>
  );
}
