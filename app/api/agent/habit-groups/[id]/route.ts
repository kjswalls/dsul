import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, resolveUserIdFromApiKey } from '@/lib/supabase-service'
import { updateProject, deleteProject, renameContainerMembers } from '@/lib/db'
import type { HabitGroupType } from '@/lib/planner-types'

/**
 * PATCH /api/agent/habit-groups/:id
 *
 * A LEGACY ALIAS SINCE MIGRATION 039 — see the POST route's header. One
 * CLASSIFY kind means this operates on `projects`, including the ownership
 * check: an id that used to name a `habit_groups` row names a `projects` row
 * now, because the migration moved each row KEEPING ITS ID. So an agent holding
 * a group id from before the collapse still addresses the same container.
 *
 * The error copy still says "habit group", deliberately: it answers a caller
 * that asked about one, and telling it about a "project" it never mentioned
 * would be the API arguing with its own URL.
 *
 * Auth: Bearer <openclaw_api_key> only — no cookie auth.
 *
 * Body: Partial<HabitGroupType> — any subset of container fields to update
 *
 * Response: { success: true }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = await resolveUserIdFromApiKey(authHeader.slice(7))
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const serviceClient = createServiceClient()

  const { data: existing } = await serviceClient
    .from('projects')
    .select('user_id')
    .eq('id', id)
    .is('deleted_at', null)
    .single()
  if (!existing || existing.user_id !== userId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    const updates: Partial<HabitGroupType> = await req.json()
    await updateProject(userId, id, updates, serviceClient)
    // Chained, for the reason spelled out in the projects route: the container
    // write and the member fan-out do not fail together, and the half-applied
    // outcome is undetectable downstream.
    if (typeof updates.name === 'string' && updates.name) {
      await renameContainerMembers(userId, id, updates.name, serviceClient)
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    // See the projects route: 23505 here means the name is held by another
    // container, possibly one in the trash that no endpoint can show the caller.
    const code = (err as { code?: string } | null)?.code
    if (code === '23505' || (err instanceof Error && err.message.includes('duplicate key value'))) {
      return NextResponse.json(
        {
          error:
            'That name is already taken by another habit group. It may be one in the trash, which keeps its name for 30 days.',
        },
        { status: 409 }
      )
    }
    const msg = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/**
 * DELETE /api/agent/habit-groups/:id
 *
 * Soft-deletes a container (recoverable from trash within 30 days). The same
 * legacy alias as PATCH above.
 *
 * Auth: Bearer <openclaw_api_key> only — no cookie auth.
 *
 * Response: { success: true }
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = await resolveUserIdFromApiKey(authHeader.slice(7))
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const serviceClient = createServiceClient()

  const { data: existing } = await serviceClient
    .from('projects')
    .select('user_id')
    .eq('id', id)
    .is('deleted_at', null)
    .single()
  if (!existing || existing.user_id !== userId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    await deleteProject(userId, id, serviceClient)
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
