'use client'

import { useEffect } from 'react'
import './globals.css'

/**
 * The last line (#74): a throw in the root layout itself, where app/error.tsx
 * cannot render because the layout it renders inside is what failed. Next
 * replaces the whole document with this, so it brings its own <html> and
 * <body> and depends on nothing the layout sets up — no providers, no theme
 * script, no shadcn components. Plain elements over the stylesheet's tokens.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[app] layout failed:', error)
  }, [error])

  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <main
          role="alert"
          className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6 text-center"
        >
          <h1 className="text-lg font-medium text-foreground">dsul couldn’t start.</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Something went wrong while loading the app. Reloading usually fixes it.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={reset}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground"
            >
              Reload
            </button>
          </div>
          {error.digest && <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>}
        </main>
      </body>
    </html>
  )
}
