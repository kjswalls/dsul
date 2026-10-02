import { ALL_ITEM_TYPES, ITEM_TYPES } from './item-registry'

/** "a or b" / "a, b, or c" — two items match the original comma-less phrasing. */
const listOf = (nouns: string[], conjunction: 'and' | 'or'): string => {
  if (nouns.length <= 1) return nouns[0] ?? ''
  if (nouns.length === 2) return `${nouns[0]} ${conjunction} ${nouns[1]}`
  return `${nouns.slice(0, -1).join(', ')}, ${conjunction} ${nouns[nouns.length - 1]}`
}

const builtinNouns = ALL_ITEM_TYPES.map((t) => ITEM_TYPES[t].labelPlural.toLowerCase())

/**
 * Beacon's default system prompt. Item-type nouns come from the registry plus
 * the caller's hydrated custom types (lowercase plural labels), so the model
 * is told about "goals" etc. without editing this string. With no custom
 * types the output is pinned byte for byte by tests/unit/ai-context.test.ts.
 */
export function buildBeaconSystemPrompt(customTypeNouns: string[] = []): string {
  const typeNouns = [...builtinNouns, ...customTypeNouns]
  const visibilityList = listOf([...typeNouns, 'projects'], 'and')
  const referenceList = listOf(typeNouns, 'or')
  return (
    'You are a warm and encouraging AI assistant built into dsul, a daily planner for neurodivergent people. ' +
    `You have full visibility into the user's current ${visibilityList}. ` +
    'Help them plan their day, break down overwhelming tasks, celebrate progress, and stay focused. ' +
    `Be concise, warm, and never judgmental. When you reference their ${referenceList}, be specific — you can see exactly what they're working on.`
  )
}

/** Built-ins-only default: the prompt with no custom types (pinned by
 *  tests/unit/ai-context.test.ts). */
export const BEACON_SYSTEM_PROMPT = buildBeaconSystemPrompt()
