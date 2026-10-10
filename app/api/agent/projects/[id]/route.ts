import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, resolveUserIdFromApiKey } from '@/lib/supabase-service'
import { updateProject, deleteProject, renameContainerMembers, findLiveProjectByName } from '@/lib/db'
import type { Project } from '@/lib/planner-types'

/**
 * PATCH /api/agent/projects/:id
 *
 * Updates an existing project. Ownership is verified before applying changes.
 *
 * Auth: Bearer <openclaw_api_key> only — no cookie auth.
 *
 * Body: Partial<Project> — any subset of project fields to update
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
  const userId = await resolveUserIdFromApiKey(authHeader.slice(7), undefined, 'write')
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
    let updates: Partial<Project>
    try {
      const parsed = await req.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      updates = parsed as Partial<Project>
    } catch {
      return NextResponse.json({ error: 'Body must be a JSON object.' }, { status: 400 })
    }
    // emoji is NOT NULL; colour and notes clear with null.
    if ('emoji' in updates && typeof updates.emoji !== 'string') {
      return NextResponse.json({ error: 'emoji must be a string' }, { status: 400 })
    }
    for (const key of ['color', 'notes'] as const) {
      if (key in updates && updates[key] !== null && typeof updates[key] !== 'string') {
        return NextResponse.json({ error: `${key} must be a string or null` }, { status: 400 })
      }
    }
    if ('name' in updates) {
      if (typeof updates.name !== 'string' || !updates.name.trim()) {
        return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 })
      }
      updates.name = updates.name.trim()
      // The index is exact-case; the app folds case. Renaming onto another
      // live project's name in a different case would leave two rows the app
      // reads as one container. Renaming a project to its own name in a new
      // case is fine, hence the exception.
      const clash = await findLiveProjectByName(userId, updates.name, serviceClient, id)
      if (clash) {
        return NextResponse.json(
          { error: `A project called "${clash.name}" already exists.` },
          { status: 409 }
        )
      }
    }
    await updateProject(userId, id, updates, serviceClient)
    // A rename has to reach the members' name column too (migration 027).
    // Without this the endpoint renames the container and leaves every item
    // holding the old string — the exact orphaning Phase 0 removed from the UI
    // path, still live here because the fan-out was written into the store
    // action rather than into the write.
    //
    // AWAITED AFTER the container update, never in parallel: both tables are
    // UNIQUE (user_id, name) and the two writes do not fail together. A
    // rejected rename that had already rewritten its members reads as the items
    // having moved into a different project, and nothing downstream can detect
    // it. Chaining is what makes the failure atomic in the direction that
    // matters. (The store's own copy of this carries an extra re-check because
    // it races undo; there is no undo here.)
    if (typeof updates.name === 'string' && updates.name) {
      await renameContainerMembers(userId, id, updates.name, serviceClient)
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    // A name collision is the caller's problem to solve, not a server fault —
    // and the raw constraint string ("duplicate key value violates unique
    // constraint projects_user_id_name_key") tells an agent nothing it can act
    // on. Worse, the holder may be a SOFT-DELETED project: the unique index
    // spans the bin, so the name can be taken by a row the agent cannot see
    // through any endpoint. Say so, with the status that means "your request,
    // fix it and retry".
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        {
          error:
            'That name is already taken by another project. It may be one in the trash, which keeps its name for 30 days.',
        },
        { status: 409 }
      )
    }
    const msg = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/** PostgreSQL 23505, however the client happens to wrap it. */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  if (code === '23505') return true
  return err instanceof Error && err.message.includes('duplicate key value')
}

/**
 * DELETE /api/agent/projects/:id
 *
 * Soft-deletes a project (recoverable from trash within 30 days).
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
  const userId = await resolveUserIdFromApiKey(authHeader.slice(7), undefined, 'write')
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
