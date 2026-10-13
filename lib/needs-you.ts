import { assigneeLabel } from './chat-utils';
import type { AgentItem } from './ask-home';

/**
 * Needs you, grouped by who is asking (memory/plans/power-mode.md, build
 * order 4): the header badge's inbox draws one card per asker, and an asker
 * with several open questions pages through them ("1 of 2") inside its card.
 *
 * `items` is lib/ask-home.ts `needsYou`, longest-waiting first, so each group
 * keeps that order and the groups come in the order of their longest wait.
 *
 * Pure and client-safe.
 */
export interface Asker {
  /** The stored assignee (`openclaw`, `claude`, …); the card's key. */
  assignee: string;
  /** As the user reads it ("OpenClaw", "AI", "Claude"). */
  label: string;
  items: AgentItem[];
}

export function askers(items: readonly AgentItem[]): Asker[] {
  const groups = new Map<string, Asker>();
  for (const item of items) {
    const assignee = item.assignee ?? '';
    const group = groups.get(assignee);
    if (group) group.items.push(item);
    else groups.set(assignee, { assignee, label: assigneeLabel(assignee) || 'Agent', items: [item] });
  }
  return [...groups.values()];
}

/** The avatar's letter. */
export function askerInitial(asker: Pick<Asker, 'label'>): string {
  return (asker.label.trim().charAt(0) || '?').toUpperCase();
}

/** The badge's words: "1 to answer", "3 to answer", or "answered" once every one is waiting out its undo. */
export function badgeLine(open: number): string {
  return open > 0 ? `${open} to answer` : 'answered';
}

/** A choice's letter: A, B, C… */
export function choiceLetter(index: number): string {
  return String.fromCharCode(65 + index);
}
