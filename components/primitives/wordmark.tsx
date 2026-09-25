import { Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The app's name, drawn. One component so the login card and the sidebar can't
 * drift into two logos.
 *
 * A drawn mark rather than the ⚡ emoji: emoji are painted by the OS, so the
 * logo was a different glyph on every machine, it never sat on the type's
 * baseline, and a colour font can't take the accent. --success-text is the
 * lime's -text role — it flips bright on navy and deep on paper, so one class
 * reads in both themes (see the -text note in globals.css). It is the accent,
 * so nothing that mounts this may dim it through a parent's opacity.
 */
export function Wordmark({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div className={cn('flex items-center gap-2', className)} {...props}>
      <Zap className="size-[18px] shrink-0 text-success-text" strokeWidth={1.75} aria-hidden />
      <span className="text-[13px] font-medium tracking-[0.02em]">DSUL</span>
    </div>
  );
}
