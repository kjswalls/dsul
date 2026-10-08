import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[calc(var(--radius)*0.5)] text-[13px] font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        // Ink, not accent: the main button is filled with the theme's text
        // color, so it is the same quiet weight on every theme and on any
        // color a person picks. The accent lives only in its ButtonKey.
        default: 'bg-foreground text-background hover:bg-foreground/85',
        // Red words on a red hairline with a faint wash. A filled red block
        // was the loudest thing on screen, louder than the dialog's own title.
        destructive:
          'border border-destructive/45 bg-destructive/[0.07] text-destructive-text hover:bg-destructive/[0.13] focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
        // outline + secondary can carry a resting fill (secondary always, outline
        // when a caller passes one, e.g. login's frosted bg-card/55), so their
        // hover LAYERS the wash (hover-wash) rather than swapping
        // background-color — swapping would drop the fill and composite
        // --accent onto whatever is behind. ghost is transparent at rest, so
        // plain hover:bg-accent is correct. --accent is defined per theme (ink
        // 4% light, white 6% dark), so one class is right in both.
        outline:
          'border border-input bg-transparent hover-wash hover:text-accent-foreground',
        secondary:
          'bg-secondary text-secondary-foreground hover-wash',
        ghost:
          'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        // One compact height for dialog and form actions. A ButtonKey pulls
        // itself toward the edge (globals.css) so it sits like a keycap.
        default: 'h-[30px] px-3 has-[>svg]:px-2.5',
        sm: 'h-7 gap-1.5 px-2.5 has-[>svg]:px-2',
        lg: 'h-9 px-4 has-[>svg]:px-3',
        icon: 'size-9',
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

/**
 * The key a main button answers to, drawn as a small accent keycap at the end
 * of its label (↵ by default). Put one ONLY where that key really presses the
 * button, and never on a destructive one: it is the button's single spot of
 * accent, and it says "this is what Enter does". It is decorative to assistive
 * tech; say the shortcut in aria-keyshortcuts on the button if it matters.
 * Styles, the hover glint and the disabled rule are in globals.css.
 */
function ButtonKey({ children = '↵', ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd data-slot="button-key" aria-hidden {...props}>
      {children}
    </kbd>
  )
}

export { Button, ButtonKey, buttonVariants }
