/**
 * Atlas's two dnd-kit id shapes (lib/dnd/CONTRACT.md):
 *
 * - `atlas:{kind}:{id}` is a card, the droppable a braindump row or another
 *   card's row is filed into.
 * - `atlasrow:{kind}:{containerId}:{itemId}` is a row on a card, the draggable.
 *
 * A row id carries its card because one item can show on four cards and in the
 * braindump at once, and dnd-kit keys its registry by id: with the raw item id
 * the last row mounted would be the only one that could be picked up. Every id
 * part is a UUID (or a fixed kind word), so the ids split on `:` and never
 * carry a name.
 *
 * The shell normalises an `atlasrow:` id to its item id at all three entry
 * points (beginDrag, trackReorder, handleDragEnd) through {@link dragItemIdOf},
 * so the drag store, the ghost and every drop rule see the item id as always.
 */

export type AtlasDropKind = 'project' | 'routine' | 'season' | 'goal';

export interface AtlasContainerRef {
  kind: AtlasDropKind;
  id: string;
}

export const ATLAS_CARD_PREFIX = 'atlas:';
export const ATLAS_ROW_PREFIX = 'atlasrow:';

const KINDS: ReadonlySet<string> = new Set<AtlasDropKind>(['project', 'routine', 'season', 'goal']);

const isKind = (k: string | undefined): k is AtlasDropKind => !!k && KINDS.has(k);

/** The droppable id of a card. */
export function atlasCardDropId(kind: AtlasDropKind, id: string): string {
  return `${ATLAS_CARD_PREFIX}${kind}:${id}`;
}

/** The card a droppable id names, or null for any other id. */
export function parseAtlasCardDropId(targetId: string): AtlasContainerRef | null {
  if (!targetId.startsWith(ATLAS_CARD_PREFIX)) return null;
  const [, kind, id, ...rest] = targetId.split(':');
  if (!isKind(kind) || !id || rest.length > 0) return null;
  return { kind, id };
}

/** The draggable id of a row on a card. */
export function atlasRowDragId(kind: AtlasDropKind, containerId: string, itemId: string): string {
  return `${ATLAS_ROW_PREFIX}${kind}:${containerId}:${itemId}`;
}

function parseRow(activeId: string): { source: AtlasContainerRef; itemId: string } | null {
  if (!activeId.startsWith(ATLAS_ROW_PREFIX)) return null;
  const [, kind, containerId, itemId, ...rest] = activeId.split(':');
  if (!isKind(kind) || !containerId || !itemId || rest.length > 0) return null;
  return { source: { kind, id: containerId }, itemId };
}

/** The item a draggable id carries: an `atlasrow:` id's item, any other id as it is. */
export function dragItemIdOf(activeId: string): string {
  return parseRow(activeId)?.itemId ?? activeId;
}

/** The card a row was picked up from, or null when the drag did not start on a card. */
export function atlasSourceOf(activeId: string): AtlasContainerRef | null {
  return parseRow(activeId)?.source ?? null;
}
