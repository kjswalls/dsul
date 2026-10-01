/**
 * The extensions store's catalog — shelves and the featured slot. Searching
 * is the settings search box's job: it already finds extensions by name and by
 * their settings' keywords.
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
