import { useMemo } from 'react';
import { create } from 'zustand';
import { useAICapabilities } from './ai-connection-store';
import { assigneeLabel } from './chat-utils';
import type { AgentAssignee } from './agent-assignees';

/**
 * The agents besides OpenClaw the user can hand work to: connected apps and
 * named agent keys that may change the planner (/api/ai/agents,
 * lib/agent-assignees.ts). Memory only, asked when Do stuff starts.
 */
interface AgentsState {
  agents: AgentAssignee[];
  loaded: boolean;
  load: () => Promise<void>;
}

export const useAgentsStore = create<AgentsState>((set) => ({
  agents: [],
  loaded: false,
  load: async () => {
    try {
      const res = await fetch('/api/ai/agents', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { agents?: AgentAssignee[] };
      set({ agents: Array.isArray(body.agents) ? body.agents : [], loaded: true });
    } catch {
      // Offline: whoever was known stays, and the next start asks again.
    }
  },
}));

/**
 * Everyone work can be handed to right now: OpenClaw first while it is paired
 * (`canDelegate`, the gate, never re-derived), then the apps and keys.
 */
export function useHandOffTargets(): AgentAssignee[] {
  const { canDelegate } = useAICapabilities();
  const agents = useAgentsStore((s) => s.agents);
  return useMemo(
    () => [
      ...(canDelegate ? [{ assignee: 'openclaw', name: assigneeLabel('openclaw'), kind: 'openclaw' as const }] : []),
      ...agents,
    ],
    [canDelegate, agents]
  );
}
