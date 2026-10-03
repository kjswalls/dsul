import { describe, it, expect } from 'vitest';
import {
  AGENT_QUIET_AFTER_MS,
  agentStatusView,
  formatElapsed,
  hasAgentState,
  isAgentState,
} from '@/lib/agent-status';

/**
 * What a delegated item says on a row.
 *
 * The elapsed reading is the reason this exists: "Working" is not information,
 * "Working 3h" is — an agent four minutes into a task is fine, and the same
 * agent three hours in has died somewhere that nobody would otherwise notice
 * until they opened the item.
 *
 * Which makes the WRONG number the thing to guard against hardest. That is why
 * the stamp is a dedicated `aiStatusAt` (migration 041) rather than the item's
 * trigger-maintained `updated_at`: the latter moves on any edit, so renaming a
 * task mid-run would silently reset the clock. No number beats a wrong one, and
 * these tests pin the cases where the honest answer is "say nothing".
 */

const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const view = (over: Record<string, unknown> = {}) =>
  agentStatusView({ assignee: 'beacon', aiStatus: 'working', aiStatusAt: ago(4 * MINUTE), ...over }, NOW);

describe('formatElapsed', () => {
  it('reads coarsely — minutes, then hours, then days', () => {
    expect(formatElapsed(ago(30 * 1000), NOW)).toBe('just now');
    expect(formatElapsed(ago(4 * MINUTE), NOW)).toBe('4m');
    expect(formatElapsed(ago(59 * MINUTE), NOW)).toBe('59m');
    expect(formatElapsed(ago(3 * HOUR), NOW)).toBe('3h');
    expect(formatElapsed(ago(23 * HOUR), NOW)).toBe('23h');
    expect(formatElapsed(ago(2 * DAY), NOW)).toBe('2d');
  });

  it('never shows something impossible for a stamp from the future', () => {
    // Clock skew between the server that stamps and the browser that reads is
    // ordinary; a row reading "-3m" is not.
    expect(formatElapsed(new Date(NOW + 5 * MINUTE).toISOString(), NOW)).toBe('just now');
  });

  it('says nothing for an unparseable stamp', () => {
    expect(formatElapsed('not a date', NOW)).toBeUndefined();
    expect(formatElapsed('', NOW)).toBeUndefined();
  });
});

describe('what the row says', () => {
  it('reports the state and how long it has been in it', () => {
    expect(view()).toMatchObject({ label: 'Working', elapsed: '4m', active: true });
  });

  it('treats blocked as the one state that wants something from the user', () => {
    const blocked = view({ aiStatus: 'blocked' })!;
    expect(blocked.needsUser).toBe(true);
    expect(blocked.label).toBe('Needs you');
    // Not "Blocked": the copy contract is that nothing names a failure, and the
    // state is a request, not a reprimand for not having noticed.
    expect(blocked.label).not.toMatch(/blocked/i);
  });

  it('leaves every other state muted', () => {
    for (const aiStatus of ['queued', 'working', 'failed']) {
      expect(view({ aiStatus })!.needsUser).toBe(false);
    }
  });

  it('counts only queued and working as live', () => {
    // The spinner is honest only while something is actually running.
    expect(view({ aiStatus: 'queued' })!.active).toBe(true);
    expect(view({ aiStatus: 'working' })!.active).toBe(true);
    expect(view({ aiStatus: 'blocked' })!.active).toBe(false);
    expect(view({ aiStatus: 'failed' })!.active).toBe(false);
  });

  it('says nothing at all for finished work', () => {
    // A row that keeps announcing "Done" for work already seen is the badge
    // equivalent of a notification that will not clear.
    expect(view({ aiStatus: 'done' })).toBeNull();
  });

  it('says nothing for an item nobody is working', () => {
    expect(view({ assignee: undefined })).toBeNull();
  });

  it('says nothing for a status outside the frozen vocabulary', () => {
    // The read schema is a loose string on purpose, so a future vocabulary
    // addition cannot brick an old plugin — which means junk can arrive here.
    expect(view({ aiStatus: 'wat' })).toBeNull();
    expect(view({ aiStatus: undefined })).toBeNull();
    // Object prototype keys are the junk that is easy to miss.
    expect(view({ aiStatus: 'toString' })).toBeNull();
    expect(view({ aiStatus: 'constructor' })).toBeNull();
  });

  it('still names the state when the stamp is missing', () => {
    // Rows written before migration 041 carry no timestamp. Losing the label
    // too would hide the delegation entirely.
    const noStamp = view({ aiStatusAt: undefined })!;
    expect(noStamp.label).toBe('Working');
    expect(noStamp.elapsed).toBeUndefined();
    expect(noStamp.detail).toBe('Working');
  });

  it('phrases the detail as a sentence a reader can hear', () => {
    // Inside the quiet threshold — past it the wording changes on purpose, see
    // the gone-quiet block at the foot of this file.
    expect(view({ aiStatus: 'working', aiStatusAt: ago(45 * MINUTE) })!.detail).toBe(
      'Working for 45m'
    );
    expect(view({ aiStatus: 'blocked', aiStatusAt: ago(2 * HOUR) })!.detail).toBe(
      'Waiting on your answer (asked 2h ago)'
    );
    expect(view({ aiStatus: 'blocked', aiStatusAt: ago(10 * 1000) })!.detail).toBe(
      'Waiting on your answer (asked just now)'
    );
  });

  it('keeps the copy contract — nothing names a failure of the user', () => {
    const forbidden = /overdue|late|behind|you failed|should have|neglect|ignored/i;
    for (const aiStatus of ['queued', 'working', 'blocked', 'failed']) {
      const v = view({ aiStatus })!;
      expect(v.label).not.toMatch(forbidden);
      expect(v.detail).not.toMatch(forbidden);
    }
  });

  it("names the agent's own failure without blaming anyone", () => {
    expect(view({ aiStatus: 'failed' })!.label).toBe("Couldn't finish");
  });
});

describe('isAgentState', () => {
  it('accepts the frozen write vocabulary and nothing else', () => {
    for (const s of ['queued', 'working', 'blocked', 'done', 'failed']) {
      expect(isAgentState(s)).toBe(true);
    }
    // Inherited keys included: `aiStatus` is a loose string by design, so
    // 'toString' can genuinely arrive — and `'toString' in LABELS` is true,
    // which would have put a function through the label lookup.
    for (const s of [undefined, '', 'pending', 'completed', 'toString', 'constructor', 'valueOf']) {
      expect(isAgentState(s as string | undefined)).toBe(false);
    }
  });
});

describe('hasAgentState — the clockless half', () => {
  /**
   * A component cannot read `Date.now()` during render (impure), and nothing
   * about WHETHER to show the pill depends on the time — only the elapsed
   * reading does. So the decision is split out, and the risk is that the two
   * halves drift: a predicate saying "show it" where the view returns null
   * would mount a ticking component that renders nothing.
   */
  const cases = [
    { assignee: 'beacon', aiStatus: 'working' },
    { assignee: 'beacon', aiStatus: 'blocked' },
    { assignee: 'beacon', aiStatus: 'queued' },
    { assignee: 'beacon', aiStatus: 'failed' },
    { assignee: 'beacon', aiStatus: 'done' },
    { assignee: 'beacon', aiStatus: 'toString' },
    { assignee: 'beacon', aiStatus: undefined },
    { assignee: undefined, aiStatus: 'working' },
    {},
  ];

  it('agrees with the view on every input', () => {
    for (const item of cases) {
      expect(hasAgentState(item), JSON.stringify(item)).toBe(
        agentStatusView({ ...item, aiStatusAt: ago(MINUTE) }, NOW) !== null
      );
    }
  });

  it('does not depend on the clock', () => {
    const item = { assignee: 'beacon', aiStatus: 'working' };
    expect(hasAgentState(item)).toBe(true);
    // No stamp at all, and none needed — the decision is about state.
    expect(hasAgentState({ ...item, aiStatusAt: undefined } as never)).toBe(true);
  });
});

describe('a run that has gone quiet', () => {
  /**
   * A worker can die mid-task — a crash, a reclaimed container, a gateway
   * switched off — and nothing cleans that up. The item sits at `working`
   * indefinitely, looking exactly like a healthy run apart from the digits.
   *
   * This is a DISPLAY heuristic and nothing automatic reads it. An automatic
   * requeue would be a double-run generator: nothing claims work atomically, so
   * re-queueing a run that was merely slow puts two workers on one task and the
   * second overwrites the first's report.
   */
  const quiet = (over: Record<string, unknown> = {}) =>
    view({ aiStatusAt: ago(AGENT_QUIET_AFTER_MS + MINUTE), ...over })!;

  it('marks a working run that has said nothing for over an hour', () => {
    expect(quiet().stalled).toBe(true);
    expect(quiet().label).toBe('Gone quiet');
  });

  it('leaves a run inside the threshold alone', () => {
    expect(view({ aiStatusAt: ago(AGENT_QUIET_AFTER_MS - MINUTE) })!.stalled).toBe(false);
    expect(view()!.stalled).toBe(false);
  });

  it('marks a queued item nothing ever picked up', () => {
    // Same failure, earlier: the schedule is off, or no worker is running.
    expect(quiet({ aiStatus: 'queued' }).stalled).toBe(true);
  });

  it('never calls a blocked item stalled, however long it waits', () => {
    // It is waiting on the USER, exactly as designed. Calling that a
    // malfunction would blame them for not having answered yet — the precise
    // thing the copy contract forbids.
    const waiting = view({ aiStatus: 'blocked', aiStatusAt: ago(3 * DAY) })!;
    expect(waiting.stalled).toBe(false);
    expect(waiting.label).toBe('Needs you');
  });

  it('never calls a failed run stalled — it already reported', () => {
    expect(view({ aiStatus: 'failed', aiStatusAt: ago(3 * DAY) })!.stalled).toBe(false);
  });

  it('says nothing without a stamp, having no evidence either way', () => {
    // Rows predating migration 041. Guessing would be the confident wrong
    // number this whole column exists to avoid.
    expect(view({ aiStatusAt: undefined })!.stalled).toBe(false);
    expect(view({ aiStatusAt: 'not a date' })!.stalled).toBe(false);
  });

  it('drops the live claim, so no spinner promises work that stopped', () => {
    // `active` stays true — it IS still in a live state — and `stalled` is what
    // the pill reads to withhold the spinner.
    expect(quiet().active).toBe(true);
    expect(quiet().stalled).toBe(true);
  });

  it('explains itself rather than just relabelling', () => {
    expect(quiet().detail).toMatch(/no update for/i);
    expect(quiet().detail).toContain('1h');
  });

  it('blames the run, never the user', () => {
    const forbidden = /you |your |should have|forgot|ignored/i;
    expect(quiet().label).not.toMatch(forbidden);
    expect(quiet().detail).not.toMatch(forbidden);
  });
});

describe('recoverable — what the user can usefully do', () => {
  /**
   * ONE definition, because the panel had grown its own
   * `stalled || aiStatus === 'failed'` — so the row's marker and the panel's
   * recovery button disagreed about a failed item, and the next consumer would
   * have disagreed again.
   */
  const quiet = (aiStatus: string) =>
    view({ aiStatus, aiStatusAt: ago(AGENT_QUIET_AFTER_MS + MINUTE) })!;

  it('offers recovery on a working run that has gone quiet', () => {
    expect(quiet('working').recoverable).toBe(true);
  });

  it('offers it on a failed run, however long ago', () => {
    expect(view({ aiStatus: 'failed', aiStatusAt: ago(3 * DAY) })!.recoverable).toBe(true);
  });

  it('does NOT offer it on a queued item, where the button would be a placebo', () => {
    /**
     * Re-queueing something already queued changes nothing except refreshing
     * the stamp — which hides the very warning the user was responding to. A
     * queued item going quiet means nothing is picking work up AT ALL, and no
     * button on this item fixes that.
     */
    expect(quiet('queued').stalled).toBe(true);
    expect(quiet('queued').recoverable).toBe(false);
  });

  it('does not offer it while a run is healthy', () => {
    expect(view()!.recoverable).toBe(false);
  });

  it('does not offer it on a blocked item — that is waiting on the user', () => {
    expect(view({ aiStatus: 'blocked', aiStatusAt: ago(3 * DAY) })!.recoverable).toBe(false);
  });
});
