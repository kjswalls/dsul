'use client'

import { useTheme } from 'next-themes'
import { Toaster as Sonner, ToasterProps } from 'sonner'

/**
 * Toaster restyled to the redesign: a soft-shadowed surface-2 card with a lime
 * action button and chrome (Inter) type — cohesive with the sidebar dock /
 * history popover it floats above. Position + placement (above the history
 * controls) is set where it's mounted + a globals.css override.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          // Sonner's own LTR/RTL corner switch (styles.css) drives the close
          // button's position off these three vars — flipping them to their
          // RTL values is the supported way to move it, vs. fighting the
          // library's `left`/`transform` with !important overrides.
          '--toast-close-button-start': 'unset',
          '--toast-close-button-end': '0',
          '--toast-close-button-transform': 'translate(35%, -35%)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          // Extra top padding (vs. the 14px `py-3.5` the bottom keeps) clears
          // the now-top-right close button from the action button — see
          // use-undo-toast.ts — which sits flush against that same corner.
          toast:
            'group !gap-3 !rounded-[12px] !border !border-border !bg-popover !px-4 !pt-5 !pb-3.5 !shadow-[var(--shadow-soft-lg)]',
          title: '!text-sm !font-medium !text-foreground',
          description: '!text-xs !text-muted-foreground',
          actionButton:
            '!h-7 !rounded-[calc(var(--radius)*0.5)] !bg-foreground !px-3 !text-xs !font-medium !text-background hover:!bg-foreground/85',
          closeButton:
            '!border-border !bg-surface-3 !text-muted-foreground hover:!text-foreground',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
