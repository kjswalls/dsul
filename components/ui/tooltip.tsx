'use client'

import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import { cn } from '@/lib/utils'

/**
 * Hover/focus tooltip. Deliberately wears the POPOVER shell (surface-2 panel,
 * hairline border, elevation shadow) rather than shadcn's default inverted
 * chip, so a rich tooltip and the History popover in the sidebar dock read as
 * the same object — one floating panel language across the app.
 *
 * `Tooltip` mounts its own Provider, so a caller can drop one anywhere without
 * a root-level provider. The trade is that the cross-tooltip "skip delay"
 * window doesn't apply between separate instances; each opens on its own
 * delay, which is the behaviour you want for tooltips scattered down a list.
 */
function TooltipProvider({
  delayDuration = 200,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  )
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          // text-xs is NOT decoration — it is the missing default. This content
          // is portalled to <body>, and app/globals.css sets no font-size on
          // html/body (only bg + colour), so a tooltip passed bare text
          // inherited the browser's 16px while the row that triggered it renders
          // at --text-content (12px). It only ever looked right on the one caller
          // that sizes its own children (the DayDots keycap panel in
          // components/primitives/pills.tsx, whose contents are text-2xs); every
          // plain-string tooltip came out a third larger than the UI around it.
          // 11px is the app's label register — what the sunrise bar's copy and
          // the chip labels already use.
          //
          // shadow-[var(--shadow-elev-md)], not shadow-md: named @theme shadow
          // utilities inline the light value and never see the .dark re-tune.
          // See the elevation block in app/globals.css.
          'glass-surface text-popover-foreground text-xs data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md border p-2 shadow-[var(--shadow-elev-md)] outline-hidden',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
