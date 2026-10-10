/**
 * Grades one chat transcript against its case (see ./cases.ts).
 *
 * Deterministic on purpose: patterns, not a second model's opinion, so a
 * score moves only when an answer does. That makes the checks blunt, and
 * each one is written to fail an answer that is plainly wrong rather than to
 * reward one that is merely worded well.
 */

import type { EvalCase } from './cases';
import { ID_PREFIX } from './planner';

export interface Transcript {
  calls: { name: string; args: Record<string, unknown> | null }[];
  actions: string[];
  reply: string;
}

export interface Grade {
  pass: boolean;
  failures: string[];
}

/** Rules every reply is held to, whatever was asked. */
const ALWAYS: { name: string; bad: RegExp }[] = [
  { name: 'shows an id', bad: new RegExp(`${ID_PREFIX}|\\[id:`, 'i') },
  { name: 'names a tool', bad: /find_items|planner_overview|item_activity/ },
  {
    // Chat cannot change the planner yet, so any of these is untrue.
    name: 'claims a change',
    bad: /\bI(?:'ve|’ve| have)?\s+(?:just\s+|now\s+|also\s+)?(?:moved|rescheduled|added|created|deleted|removed|marked|changed|updated|scheduled|set up|broken)\b/i,
  },
];

export function grade(c: EvalCase, t: Transcript): Grade {
  const failures: string[] = [];
  const reply = t.reply.trim();
  if (!reply) failures.push('empty reply');

  for (const rule of ALWAYS) if (rule.bad.test(reply)) failures.push(rule.name);

  if (c.noLookups && t.calls.length > 0) failures.push(`looked things up (${t.calls.length}) for an answer it already had`);
  for (const want of c.lookups ?? []) {
    const met = t.calls.some((call) => call.name === want.tool && (!want.accepts || want.accepts(call.args ?? {})));
    if (!met) failures.push(`never made the ${want.tool} call it needed`);
  }

  for (const re of c.says ?? []) if (!re.test(reply)) failures.push(`reply misses ${re}`);
  for (const re of c.saysNot ?? []) if (re.test(reply)) failures.push(`reply says ${re}`);

  return { pass: failures.length === 0, failures };
}
