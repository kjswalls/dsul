'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

/**
 * The page-level error boundary (#74). Before this file, one bad render
 * anywhere unmounted the whole tree and left a blank screen with no way back
 * short of a reload. It renders inside the root layout, so the theme and the
 * providers are still up.
 *
 * The shell's regions catch their own throws first
 * (components/primitives/section-boundary.tsx), so reaching this one means the
 * shell itself, or a page outside it (/settings, /ledger, a container page),
 * failed. app/global-error.tsx is the last line, for a throw in the layout.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[app] render failed:', error)
  }, [error])

  return (
    <main
      role="alert"
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6 text-center"
    >
      <h1 className="text-lg font-medium text-foreground">Something went wrong on this page.</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Try it again. If it keeps happening, going back to your planner usually clears it.
      </p>
      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" asChild>
          <Link href="/">Back to planner</Link>
        </Button>
      </div>
      {error.digest && <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>}
    </main>
  )
}
