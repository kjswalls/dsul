import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { saveTimezone } from '@/lib/user-timezone'

/**
 * PATCH /api/user/timezone
 *
 * Updates the authenticated user's stored timezone.
 * Called by the client after a load whose browser zone differs from the
 * stored one (hooks/use-timezone-sync.ts) — keeps it accurate when users
 * travel. The write, and its skip when nothing changed, is lib/user-timezone.ts,
 * shared with the iPhone's POST /api/app/timezone.
 *
 * Body: { timezone: string }  e.g. { timezone: "America/Los_Angeles" }
 */
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let timezone: unknown
  try {
    ;({ timezone } = await req.json())
  } catch {
    return NextResponse.json({ error: 'timezone is required' }, { status: 400 })
  }

  try {
    const result = await saveTimezone(supabase, user.id, timezone)
    if ('invalid' in result) return NextResponse.json({ error: result.invalid }, { status: 400 })
    return NextResponse.json(result.unchanged ? { ok: true, unchanged: true } : { ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : (err as { message?: string })?.message ?? 'Update failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
