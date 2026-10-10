import type { PillTone } from '@/lib/ai-pane-state';
import { cn } from '@/lib/utils';

const DOT: Readonly<Record<PillTone, string>> = Object.freeze({
  lime: 'bg-primary',
  honey: 'bg-warning',
  grey: 'bg-muted-foreground',
});

/**
 * A section's state in a word, beside its heading on Settings → AI
 * ("Working", "Needs attention", "Not paired"): a fully rounded grey pill with
 * a 6px dot. The dot carries the tone, as its own element, so the lime is
 * never faded through a parent. Lime only where something answers here
 * (lib/ai-pane-state.ts `connectionPillTone`), honey for what needs the
 * person, grey for the rest.
 */
export function StatusPill({
  tone,
  children,
  testId,
}: {
  tone: PillTone;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className="bg-secondary text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
    >
      <span data-dot="" aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT[tone])} />
      {children}
    </span>
  );
}
