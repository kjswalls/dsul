import { stripReasoningTags } from './chat-utils';

/**
 * "Turn this into a plan": the prompt that hands a conversation's exchange to
 * the proposal path, so a conversation can end in a card you tap rather than
 * in changes you then go and make by hand.
 *
 * Moved unchanged out of the old chat panel (chat-conversation.tsx's
 * `askForPlan`, since deleted) so every conversation surface builds the same
 * prompt, and a test can pin it without rendering one. Pure and client-safe.
 *
 * It sends the EXCHANGE, not the reply alone: what makes a plan worth proposing
 * is usually in the reply ("push the two writing ones to Thursday"), and a
 * proposer given only "what should I do about this week" has to re-derive the
 * whole answer and will land somewhere else. Nor the question alone, for the
 * mirror reason.
 */

/** The fields this needs from a transcript message; conversations-store's ChatMessage has them all. */
export interface PlanPromptMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** The user message a reply answers, when the transcript knows it. */
  replyTo?: string | null;
}

/** One side of the excerpt, at most this many characters. */
const EXCERPT_CHARS = 2000;

/**
 * Caps one side of the excerpt handed to the proposer.
 *
 * The whole planner already travels with a proposal request; a long reply on
 * top of it is the part that pushes the prompt somewhere it starts losing the
 * item list off the front. The tail is what gets cut because the conclusion,
 * the part worth acting on, is at the end of an answer, not the start.
 */
export function clipExcerpt(text: string, max = EXCERPT_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

/**
 * The proposal prompt for the reply `replyId`: the user message it answers
 * (its `replyTo`, else the nearest earlier user turn), the reply with its
 * reasoning tags stripped, both clipped. A reply that is not in `messages`
 * gives an exchange of two empty sides, as the old builder did for an index
 * past the end.
 */
export function buildPlanPrompt(messages: readonly PlanPromptMessage[], replyId: string): string {
  const index = messages.findIndex((m) => m.id === replyId);
  const reply = index >= 0 ? stripReasoningTags(messages[index].content) : '';

  let ask = '';
  if (index >= 0) {
    const replyTo = messages[index].replyTo;
    const named = replyTo ? messages.find((m) => m.id === replyTo && m.role === 'user') : undefined;
    if (named) {
      ask = named.content;
    } else {
      for (let i = index - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          ask = messages[i].content;
          break;
        }
      }
    }
  }

  return [
    'Turn this conversation into concrete planner changes.',
    '',
    `I asked: ${clipExcerpt(ask)}`,
    '',
    `You answered: ${clipExcerpt(reply)}`,
  ].join('\n');
}
