/**
 * Runs one eval case exactly as the chat route would: the same system prompt
 * (base, lookups, the planner snapshot), the same loop and the same lookups,
 * with the fixture planner standing in for the user's database.
 */

import { buildDsulContext } from '@/lib/ai-context';
import { MAX_OUTPUT_TOKENS, composeChatSystem } from '@/lib/ai-limits';
import { lookupLoop, withToolsPrompt } from '@/lib/ai-server/chat-loop';
import { makeLookups } from '@/lib/ai-server/chat-lookups';
import type { ProviderAdapter, ProviderCredentials } from '@/lib/ai-server/providers';
import type { EvalCase } from './cases';
import type { Transcript } from './grade';
import { GOALS, ITEMS, PROJECTS, ROUTINES, TIMEZONE, fixtureSource } from './planner';

/** Call with Date frozen at planner.NOW, or "today" is the wrong day. */
export function evalSystem(): string[] {
  const context = buildDsulContext({
    items: ITEMS,
    projects: PROJECTS,
    routines: ROUTINES,
    seasons: [],
    goals: GOALS,
    userTimezone: TIMEZONE,
  });
  return withToolsPrompt(composeChatSystem({ typeNouns: [], customInstructions: '', context }));
}

export interface RunOptions {
  adapter: ProviderAdapter;
  creds: ProviderCredentials;
  model: string;
  /** evalSystem(), built once with Date frozen. */
  system: string[];
  signal: AbortSignal;
}

export async function runCase(c: EvalCase, o: RunOptions): Promise<Transcript> {
  const { adapter, creds, model, system, signal } = o;
  const lookups = makeLookups(fixtureSource());
  const calls: Transcript['calls'] = [];
  const recorded = {
    tools: lookups.tools,
    run: (call: Parameters<typeof lookups.run>[0]) => {
      calls.push({ name: call.name, args: call.args });
      return lookups.run(call);
    },
  };

  const actions: string[] = [];
  const proposals: Transcript['proposals'] = [];
  let reply = '';
  for await (const ev of lookupLoop({
    adapter,
    creds,
    request: { model, modelMeta: {}, system, maxOutputTokens: MAX_OUTPUT_TOKENS, signal },
    messages: [...(c.before ?? []), { role: 'user', content: c.ask }],
    lookups: recorded,
  })) {
    if ('action' in ev) actions.push(ev.action);
    else if ('proposal' in ev) proposals.push(ev.proposal);
    else reply += ev.content;
  }
  return { calls, actions, proposals, reply };
}
