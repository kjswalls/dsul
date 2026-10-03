import { describe, it, expect } from 'vitest';
import { buildPlanPrompt, clipExcerpt, type PlanPromptMessage } from '@/lib/plan-prompt';

/**
 * "Turn this into a plan" hands the proposer the EXCHANGE: the question and
 * the answer, both. Moved out of chat-conversation.tsx unchanged, so these pin
 * the prompt every conversation surface now builds.
 */

const m = (id: string, role: 'user' | 'assistant', content: string, replyTo?: string): PlanPromptMessage => ({
  id,
  role,
  content,
  replyTo: replyTo ?? null,
});

describe('buildPlanPrompt', () => {
  it("gives today's three-part prompt: the instruction, the question, the answer", () => {
    const prompt = buildPlanPrompt(
      [m('u1', 'user', 'What should I do about this week?'), m('a1', 'assistant', 'Push the two writing ones to Thursday.', 'u1')],
      'a1'
    );
    expect(prompt).toBe(
      [
        'Turn this conversation into concrete planner changes.',
        '',
        'I asked: What should I do about this week?',
        '',
        'You answered: Push the two writing ones to Thursday.',
      ].join('\n')
    );
  });

  it('uses the user message the reply names', () => {
    const prompt = buildPlanPrompt(
      [m('u1', 'user', 'first'), m('u2', 'user', 'second'), m('a1', 'assistant', 'answer', 'u1')],
      'a1'
    );
    expect(prompt).toContain('I asked: first');
  });

  it('walks back to the nearest user turn when the reply names none', () => {
    const prompt = buildPlanPrompt(
      [m('u1', 'user', 'older'), m('a0', 'assistant', 'old answer'), m('u2', 'user', 'newer'), m('a1', 'assistant', 'answer')],
      'a1'
    );
    expect(prompt).toContain('I asked: newer');
    expect(prompt).not.toContain('older');
  });

  it("strips the reply's reasoning tags", () => {
    const prompt = buildPlanPrompt(
      [m('u1', 'user', 'hi'), m('a1', 'assistant', '<think>secret plan</think><final>Move it to Friday.</final>', 'u1')],
      'a1'
    );
    expect(prompt).toContain('You answered: Move it to Friday.');
    expect(prompt).not.toContain('secret plan');
  });

  it('clips both halves to their tails', () => {
    const long = 'a'.repeat(1_000) + 'b'.repeat(2_000);
    const prompt = buildPlanPrompt([m('u1', 'user', long), m('a1', 'assistant', long, 'u1')], 'a1');
    expect(prompt).toContain(`I asked: …${'b'.repeat(2_000)}`);
    expect(prompt).toContain(`You answered: …${'b'.repeat(2_000)}`);
    expect(prompt).not.toContain('aaaa');
  });

  it('gives two empty sides for a reply it cannot find', () => {
    expect(buildPlanPrompt([m('u1', 'user', 'hi')], 'nope')).toBe(
      'Turn this conversation into concrete planner changes.\n\nI asked: \n\nYou answered: '
    );
  });
});

describe('clipExcerpt', () => {
  it('trims, and keeps the end of anything too long', () => {
    expect(clipExcerpt('  short  ')).toBe('short');
    expect(clipExcerpt('abcdef', 3)).toBe('…def');
  });
});
