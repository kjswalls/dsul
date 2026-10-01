/**
 * The extensions store's catalog — shelves, the featured slot, and search.
 *
 * Pure data over OFFICIAL_EXTENSIONS: the copy lives on each manifest entry
 * (tagline, shelf, needs, costs, whatChanges, makerNote), so adding an
 * extension to the store is still adding config in one place. This module only
 * decides how the store arranges it.
 *
 * Off is inert, not hidden (Kirby, 2026-08-26: "off means inert, but still
 * findable. Like an extension store."), so every catalog entry gets a card,
 * whatever its state.
 */

import {
  EXT_HABIT_HEATMAP,
  OFFICIAL_EXTENSIONS,
  type ExtensionManifest,
  type ExtensionShelf,
} from './extension-registry';
import { extensionPaneId, settingsForPane } from './settings/manifest';

export interface StoreShelf {
  id: ExtensionShelf;
  name: string;
  /** One line under the shelf name. */
  blurb: string;
}

/** Store order, top to bottom. */
export const STORE_SHELVES: StoreShelf[] = [
  { id: 'plan', name: 'Shape your plan', blurb: 'New ideas for how the day is organised' },
  { id: 'habits', name: 'Keep habits going', blurb: 'Small things that make a streak feel real' },
  { id: 'reach', name: 'Reach you outside the app', blurb: 'Reminders that leave the browser' },
  { id: 'stakes', name: 'Put something on the line', blurb: 'What a missed day is worth' },
];

/** The extension in the store's big slot. A slug, so a rename can't strand it. */
export const FEATURED_SLUG = EXT_HABIT_HEATMAP;

export function catalogByShelf(
  extensions: ExtensionManifest[] = OFFICIAL_EXTENSIONS
): { shelf: StoreShelf; extensions: ExtensionManifest[] }[] {
  return STORE_SHELVES.map((shelf) => ({
    shelf,
    extensions: extensions.filter((extension) => extension.shelf === shelf.id),
  })).filter((group) => group.extensions.length > 0);
}

/** The chip text for an extension's cost, or null when using it is free. */
export function costLabel(extension: ExtensionManifest): string | null {
  if (extension.costs === 'stake') return 'Can cost money';
  if (extension.costs === 'usage') return 'Twilio charges apply';
  return null;
}

/**
 * Everything a store search may match for one extension.
 *
 * Includes the KEYWORDS of the extension's own settings records, which are
 * hand-authored on purpose ("sonos", "anti-charity"): typing "sonos" finds
 * Speak reminders aloud in settings search, and the store must not be the
 * place where it stops working.
 */
function haystack(extension: ExtensionManifest): string {
  const records = settingsForPane(extensionPaneId(extension.slug));
  return [
    extension.name,
    extension.tagline,
    extension.description,
    ...(extension.needs ?? []),
    ...records.flatMap((record) => [record.label, ...record.keywords]),
  ]
    .join(' ')
    .toLowerCase();
}

/** Every extension whose text contains each word of the query, catalog order. */
export function searchCatalog(
  query: string,
  extensions: ExtensionManifest[] = OFFICIAL_EXTENSIONS
): ExtensionManifest[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return extensions;
  return extensions.filter((extension) => {
    const text = haystack(extension);
    return words.every((word) => text.includes(word));
  });
}
