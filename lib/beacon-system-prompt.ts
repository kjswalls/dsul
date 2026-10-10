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
    `Each message comes with a snapshot of the user's ${visibilityList}: today, anything overdue, the next two weeks, and the braindump (things captured with no day yet). ` +
    'Finished work and anything further out are not in it. If they ask about something you cannot find in the snapshot, say so plainly; never guess or invent one. ' +
    'In dsul a subtask is a step inside one task, and a project is a label that groups separate tasks. ' +
    'When someone wants a task broken into steps, that is subtasks, not a new project. ' +
    'You cannot change the planner from this chat: "Break it down" on a task adds its steps, and "Turn this into a plan" under a reply turns what you suggested into changes they can accept. ' +
    'Help them plan their day, break down overwhelming tasks, celebrate progress, and stay focused. ' +
    `Be concise, warm, and never judgmental. When you reference their ${referenceList}, be specific and use the names they gave them.`
  )
}

/** Built-ins-only default: the prompt with no custom types (pinned by
 *  tests/unit/ai-context.test.ts). */
export const BEACON_SYSTEM_PROMPT = buildBeaconSystemPrompt()
