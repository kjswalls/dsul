'use client'

import * as React from 'react'
import * as ProgressPrimitive from '@radix-ui/react-progress'

import { cn } from '@/lib/utils'

// shadcn's shape, but the track is `bg-muted`, never the stock `bg-primary/20`:
// the lime never goes through an alpha. The fill's colour is the caller's.
function Progress({
  className,
  indicatorClassName,
  value,
  max = 100,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, ((value ?? 0) / max) * 100)) : 0
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn('bg-muted relative h-2 w-full overflow-hidden rounded-full', className)}
      value={value}
      max={max}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn('bg-primary h-full w-full flex-1 transition-transform', indicatorClassName)}
        style={{ transform: `translateX(-${100 - pct}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
