import { cn } from '@/lib/utils';

/**
 * The app's name, drawn. One component so the login card and the sidebar can't
 * drift into two logos.
 *
 * Lowercase "dsul" and one lime dot after it, as the Braindump header options
 * drew it. The dot is the Display trigger's own mark, 6px of --primary (lime in
 * both themes), raised a pixel off the baseline so it reads as part of the word
 * rather than a status light. It is the accent, so nothing that mounts this
 * may dim it through a parent's opacity.
 */
export function Wordmark({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div className={cn('flex items-center', className)} {...props}>
      <span className="text-[13px] font-semibold tracking-[-0.01em]">
        dsul
        <span
          className="ml-[3px] inline-block size-1.5 rounded-full bg-primary align-[1px]"
          aria-hidden
        />
      </span>
    </div>
  );
}
