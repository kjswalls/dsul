/**
 * What one extension's state reads as, everywhere it is shown.
 *
 * The list of your extensions (components/settings/extension-rail-list.tsx)
 * and the store's cards (components/extensions/store-card.tsx) both print a
 * one-word state beside every extension, and they must never disagree — Beeminder is the extension where
 * "On" beside an "Unavailable" pane costs real money. So the rule has exactly
 * one home, here, and both surfaces call it.
 */

import { useExtensionsStore } from '@/lib/extensions-store';
import { extensionPaneId, settingsForPane, type SettingCtx, type SettingRecord } from './manifest';

export interface ExtensionState {
  /** On · Off · Unavailable · Loading — also the `data-extension-state` value. */
  label: string;
  on: boolean;
  /** Why it is unavailable, in the pane's own words ("needs Settle the day, in Rituals"). */
  reason?: string;
}

/**
 * The extension's own toggle record, found by SHAPE rather than by id.
 *
 * Two of the eight toggles predate the slug convention
 * (`extensions.habitHeatmap`, not `extensions.habit-heatmap`) and an id is a
 * permanent deep link, so an `extensions.${slug}` lookup would silently miss
 * them. Every extension pane holds exactly one switch that depends on nothing —
 * its own — which is asserted in tests/unit/settings-manifest.test.ts.
 */
export function toggleOf(records: SettingRecord[]): SettingRecord | undefined {
  return records.find((record) => record.control === 'switch' && !record.dependsOn);
}

/**
 * What the row says, ASKED OF THE TOGGLE rather than re-derived here.
 *
 * An extension can be switched on and still be doing nothing, because a channel
 * rides `remindersEnabled` and a stake adapter rides `stakesEnabled` — the
 * master switches over in Rituals that `unavailable()` reports and that
 * `isEnabled()` knows nothing about. Reading the store alone made this index say
 * "On" for a Beeminder whose own pane was saying "Unavailable", and Beeminder is
 * the extension where being wrong about that costs real money.
 *
 * So the rule keeps ONE home: the record's own `unavailable()`. A second copy
 * here is how the index and the pane drift apart again.
 */
export function extensionStateOf(
  toggle: SettingRecord | undefined,
  ctx: SettingCtx
): ExtensionState {
  try {
    // Two store-level facts come FIRST, because neither is something the
    // record can answer. `available: false` means the extensions table itself
    // is missing — nothing under here is real, whatever a toggle would say.
    // And before the fetch resolves, every read answers with the MANIFEST
    // default, which for an account that has toggled anything is a guess and
    // can be the opposite of the truth. This page cannot write, so nothing is
    // at risk — but printing "Off" beside an extension the server has on is
    // the one lie a user opens this index to avoid. Say what is known.
    const store = useExtensionsStore.getState();
    if (!store.available) return { label: 'Unavailable', on: false };
    if (!store.configsLoaded) return { label: 'Loading', on: false };
    if (!toggle) return { label: 'Off', on: false };
    const reason = toggle.unavailable?.(ctx);
    if (reason) return { label: 'Unavailable', on: false, reason };
    return toggle.read(ctx) ? { label: 'On', on: true } : { label: 'Off', on: false };
  } catch {
    return { label: 'Off', on: false };
  }
}

/** The same answer, starting from a slug — what the store has in hand. */
export function extensionStateForSlug(slug: string, ctx: SettingCtx): ExtensionState {
  return extensionStateOf(toggleOf(settingsForPane(extensionPaneId(slug))), ctx);
}
