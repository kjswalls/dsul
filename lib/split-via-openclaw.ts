import { appendInstructions } from './ai-limits';
import { useAIConnectionStore } from './ai-connection-store';
import { useAISettingsStore } from './ai-settings-store';
import type { BulkDraft } from './bulk-add';
import { MAX_SPLIT_CHARS, SPLIT_JSON_ONLY_LINE, SPLIT_SYSTEM_PROMPT, splitDrafts } from './braindump-split';
import { extractJsonObject } from './json-extract';
import { browserLink } from './openclaw-browser-store';

/**
 * Braindump to things through OpenClaw (memory/plans/power-mode.md, "Agents up
 * to the model"): when this browser is paired with the person's gateway and no
 * model answers here, the bulk-add dialog's "Sort it out with AI" asks
 * OpenClaw directly, over the same socket Ask's chat uses. Nothing passes
 * through dsul's server, as with Ask.
 *
 * The prompt and the checking are /api/ai/split's own (lib/braindump-split.ts),
 * so OpenClaw is asked exactly what the model is. Each split is its own
 * OpenClaw session, so one paragraph never leaks into the next one's list.
 */

export type OpenClawSplit = { ok: true; drafts: BulkDraft[] } | { ok: false; error: string };

const FAILED = "OpenClaw couldn't sort that out.";

export async function splitViaOpenClaw(text: string, signal: AbortSignal): Promise<OpenClawSplit> {
  const userId = useAIConnectionStore.getState().hydratedUserId;
  const link = userId ? browserLink() : null;
  if (!userId || !link) return { ok: false, error: 'Pair this browser with OpenClaw in Settings first.' };
  const system = [appendInstructions(SPLIT_SYSTEM_PROMPT, useAISettingsStore.getState().systemPrompt), SPLIT_JSON_ONLY_LINE].join('\n\n');
  const result = await link.chat({
    sessionKey: `dsul:u:${userId}:split:${crypto.randomUUID()}`,
    agentId: useAIConnectionStore.getState().openclaw.agentId,
    message: `${system}\n\n"""\n${text.trim().slice(0, MAX_SPLIT_CHARS)}\n"""`,
    signal,
    onDelta: () => {},
  });
  if (result.status !== 'complete') {
    if (result.status === 'error' && result.reason === 'offline') return { ok: false, error: "OpenClaw isn't reachable right now." };
    return { ok: false, error: FAILED };
  }
  const parsed = extractJsonObject(result.content) as { drafts?: unknown } | null;
  return { ok: true, drafts: splitDrafts(parsed?.drafts) };
}
