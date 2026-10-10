import type { Item } from './planner-types'

/**
 * @ items in the chat box (step 2c, memory/plans/ai-vision.md).
 *
 * A mention is plain text: picking an item writes "@<its title> " into the
 * message, and the send finds the items it names by those words again
 * (`mentionedItemIds`). Nothing else is kept: no id rides beside the text, so a
 * half-typed message held in rail-store, an edit, a retry and a saved
 * transcript all carry their mentions with them, and deleting the words
 * deletes the mention. The items found go to the model as context for that
 * turn only (lib/ai-context.ts `mentionedItemIds`); the stored message is the
 * words the user sent, nothing more.
 */

/** At most this many picks offered, and at most this many items sent along. */
export const MAX_MENTION_CHOICES = 6
export const MAX_MENTIONED = 5
/** A query longer than this is prose that happens to follow an @, not a search. */
const MAX_QUERY = 40

/** The @ being typed at the caret: where it starts, and what follows it. */
export interface ActiveMention {
  /** Index of the @. */
  start: number
  /** Index just past the query (the caret). */
  end: number
  query: string
}

/**
 * The mention the caret is in, if any: an @ at the start of the text or after
 * whitespace, followed by no line break, up to the caret. "me@home" is an
 * address, not a mention.
 */
export function activeMention(text: string, caret: number): ActiveMention | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (query.length > MAX_QUERY || /[\r\n]/.test(query)) return null
  return { start: at, end: caret, query }
}

const isStep = (item: Item) => 'parentItemId' in item && !!item.parentItemId
/** A habit's status is today's tick, never "finished", so a habit is always open here. */
const isFinished = (item: Item) => item.type !== 'habit' && (item.status === 'completed' || item.status === 'cancelled')

/**
 * Items a query could mean, best first: open before finished, a title that
 * starts with the query before one that only contains it, then a step after a
 * whole item, then alphabetical. An empty query (just "@") offers the open
 * items in that order.
 */
export function mentionChoices(items: readonly Item[], query: string): Item[] {
  const q = query.trim().toLowerCase()
  const scored: { item: Item; rank: number }[] = []
  for (const item of items) {
    const title = item.title.trim()
    if (!title) continue
    const lower = title.toLowerCase()
    const at = q ? lower.indexOf(q) : 0
    if (at < 0) continue
    if (!q && isFinished(item)) continue
    const rank = (isFinished(item) ? 4 : 0) + (at === 0 ? 0 : 2) + (isStep(item) ? 1 : 0)
    scored.push({ item, rank })
  }
  scored.sort((a, b) => a.rank - b.rank || a.item.title.localeCompare(b.item.title))
  return scored.slice(0, MAX_MENTION_CHOICES).map((s) => s.item)
}

/** The text with the mention replaced by the item's title, and where the caret goes. */
export function insertMention(text: string, mention: ActiveMention, title: string): { text: string; caret: number } {
  const after = text.slice(mention.end)
  const word = `@${title.trim()}`
  const space = after.startsWith(' ') ? '' : ' '
  const next = `${text.slice(0, mention.start)}${word}${space}${after}`
  return { text: next, caret: mention.start + word.length + 1 }
}

/**
 * The items a message names with "@<title>", in the order they appear, at most
 * MAX_MENTIONED. Longer titles are matched first, so "@Call mum back" is that
 * item even when "Call mum" is one too; an open item wins a title two share.
 * Case is folded, as the picker's search folds it.
 */
export function mentionedItemIds(text: string, items: readonly Item[]): string[] {
  if (!text.includes('@')) return []
  const lower = text.toLowerCase()
  const byTitle = new Map<string, Item>()
  for (const item of items) {
    const key = item.title.trim().toLowerCase()
    if (!key) continue
    const held = byTitle.get(key)
    if (!held || (isFinished(held) && !isFinished(item))) byTitle.set(key, item)
  }
  const titles = [...byTitle.keys()].sort((a, b) => b.length - a.length)
  const taken = new Array<boolean>(lower.length).fill(false)
  const found: { id: string; at: number }[] = []
  for (const title of titles) {
    const needle = `@${title}`
    let from = 0
    for (;;) {
      const at = lower.indexOf(needle, from)
      if (at < 0) break
      from = at + 1
      const end = at + needle.length
      const boundary = end === lower.length || !/[\p{L}\p{N}]/u.test(lower[end])
      const free = (at === 0 || /\s/.test(lower[at - 1])) && !taken[at]
      if (!boundary || !free) continue
      for (let i = at; i < end; i++) taken[i] = true
      found.push({ id: byTitle.get(title)!.id, at })
      break
    }
  }
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.id)
    .filter((id, i, all) => all.indexOf(id) === i)
    .slice(0, MAX_MENTIONED)
}
