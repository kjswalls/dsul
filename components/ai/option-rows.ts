import { cn } from '@/lib/utils';

/**
 * The options card's lighter rows (Kirby's pick, 2026-10-24): no outline on
 * each choice, so the lettered keys carry the list and the card is the only
 * frame. One look for every options card: chat's (chat-options-card.tsx), an
 * agent's in Needs you (needs-you/asker-card.tsx), and your AI's prep
 * questions (sidebar/prep-pack.tsx QuestionBody).
 */

/**
 * A choice: a wash on hover, the accent when picked. `live` false greys it out.
 *
 * No colour transition: the wash follows the pointer at once, as a menu's
 * rows do. A 150ms fade left two rows half-lit while the pointer crossed
 * them, which read as lag and flicker (Kirby, 2026-10-25).
 */
export function optionRowClass(on: boolean, live = true): string {
  return cn(
    'flex w-full items-start gap-2 rounded-[8px] px-1.5 py-1.5 text-left text-sm',
    on ? 'bg-primary text-primary-foreground' : live ? 'text-foreground hover:bg-secondary' : 'text-muted-foreground'
  );
}

/** The choice's letter key (A to H). */
export function optionKeyClass(on: boolean): string {
  return cn(
    'mt-px grid size-4.5 shrink-0 place-items-center rounded border text-2xs font-medium',
    on ? 'border-primary-foreground/30' : 'border-border text-muted-foreground'
  );
}

/** The own-words row: a filled well, no outline, around a pencil and a bare input. */
export const OWN_WORDS_ROW =
  'flex items-center gap-1 rounded-[10px] bg-secondary pr-1.5 pl-2.5 focus-within:ring-1 focus-within:ring-ring';
