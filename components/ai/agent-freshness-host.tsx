'use client';

import { useDelegatedFreshness } from '@/hooks/use-agent-freshness';

/**
 * Keeps delegated items' agent state current wherever the planner shows
 * (hooks/use-agent-freshness.ts `useDelegatedFreshness`). Its own component so
 * AppShell keeps no planner-store subscription of its own.
 */
export function AgentFreshnessHost(): null {
  useDelegatedFreshness();
  return null;
}
