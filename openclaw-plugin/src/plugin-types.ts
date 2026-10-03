import type { Task, Habit, Project, HabitGroupType, Item, Routine, Season, Goal } from '@dsul/types'

/** Plugin-internal cache shape */
export interface DsulCache {
  userId: string
  userTimezone: string
  tasks: Task[]
  habits: Habit[]
  projects: Project[]
  habitGroups: HabitGroupType[]
  /**
   * Unified items (schemaVersion 3+), UNFILTERED — where tasks[]/habits[] have
   * had suppressed open loops removed by the server. The difference between
   * them is exactly the set of work that is deliberately set aside, which is
   * how context.ts accounts for it without reimplementing the resolver.
   */
  items: Item[]
  /** schemaVersion 4+. Absent (not empty) when the server did not say. */
  routines: Routine[]
  seasons: Season[]
  /**
   * schemaVersion 5+. Goals suppress nothing, so unlike routines and seasons
   * an empty array here never means work is missing from the lists above — it
   * means this user has no goals, or the server predates them.
   */
  goals: Goal[]
  fetchedAt: number
}

/** Plugin config (from openclaw.json) */
export interface PluginConfig {
  dsulUrl: string
  apiKey: string
  publicUrl?: string   // Gateway's public URL (e.g. https://midgar-1b4eaa3.turkey-rockhopper.ts.net)
  webhookSecret?: string
  cacheTtlMs?: number
  /** OpenClaw agent that answers in dsul's Ask (default: main). */
  agentId?: string
  /** Fallback agent id if agentId unset (legacy / alternate key in openclaw.json). */
  id?: string
}
