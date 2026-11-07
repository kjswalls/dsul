import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[calc(var(--radius)*0.5)] text-[13px] font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        // Keycaps (Kirby, 2026-11-05: "F" in the keycap round). Every button
        // that carries a face is the same paper key as the sidebar's Ctrl K
        // launcher: a bevelled face, a hairline rim, a 2px skirt it sinks into
        // when pressed. The shape, the skirt and the press live in globals.css
        // under `.key`; the face colour is a background-color in the
        // components layer, so a caller's bg-* still wins it.
        //
        // The main button stands on a lime skirt: the raw accent as a flat
        // edge, never a glow (a lit rim is AI's alone) and never faded. That
        // skirt is its only lime; its ButtonKey goes neutral.
        default: 'key key-main font-semibold text-foreground',
        // Red words on a red-rimmed key with a faint wash.
        destructive: 'key key-danger text-destructive-text',
        outline: 'key text-foreground',
        secondary: 'key text-secondary-foreground',
        ghost:
          'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        // One compact height for dialog and form actions. A ButtonKey pulls
        // itself toward the edge (globals.css) so it sits like a keycap.
        // 26/24/32 since 2026-11-07 (Kirby: the keys read tall with their
        // skirt under them); the skirt is 2px.
        default: 'h-[26px] px-3 has-[>svg]:px-2.5',
        sm: 'h-6 gap-1.5 px-2.5 has-[>svg]:px-2',
        lg: 'h-8 px-4 has-[>svg]:px-3',
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
 * The key a main button answers to, printed on the keycap as a small neutral
 * inset at the end of its label (↵ by default). Put one ONLY where that key
 * really presses the button, and never on a destructive one: it says "this is
 * what Enter does". The main key's lime is its skirt, so this stays neutral.
 * It is decorative to assistive tech; say the shortcut in aria-keyshortcuts on
 * the button if it matters. Styles and the disabled rule are in globals.css.
 */
function ButtonKey({ children = '↵', ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd data-slot="button-key" aria-hidden {...props}>
      {children}
    </kbd>
  )
}

export { Button, ButtonKey, buttonVariants }
