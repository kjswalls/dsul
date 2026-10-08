import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, resolveUserIdFromApiKey } from '@/lib/supabase-service'
import { createProject, findLiveProjectByName } from '@/lib/db'
import type { Project } from '@/lib/planner-types'

/**
 * POST /api/agent/projects
 *
 * Creates a new project for the authenticated user.
 *
 * Auth: Bearer <openclaw_api_key> only — no cookie auth.
 *
 * Body:
 *   Required: name (non-empty string)
 *   Optional: emoji (an icon token like 'icon:Sparkles'; none when omitted), color, notes,
 *             id (UUID, generated if not provided), repeatFrequency, repeatDays,
 *             repeatMonthDay, timeBucket, startTime, duration
 *
 * Response: { project } with 201 status. A name that folds onto a live project
 * ("work" against "Work") is 409 with that `project`, so the caller files under
 * it instead of minting a second container the app would treat as the same one.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = await resolveUserIdFromApiKey(authHeader.slice(7))
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Body must be a JSON object.' }, { status: 400 })
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    return NextResponse.json({ error: 'name is required and must be a non-empty string' }, { status: 400 })
  }
  for (const key of ['emoji', 'color', 'notes'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'string') {
      return NextResponse.json({ error: `${key} must be a string` }, { status: 400 })
    }
  }

  const serviceClient = createServiceClient()

  try {
    const existing = await findLiveProjectByName(userId, name, serviceClient)
    if (existing) {
      return NextResponse.json(
        { error: `A project called "${existing.name}" already exists. File under that name.`, project: existing },
        { status: 409 }
      )
    }

    const project: Project = {
      id: (body.id as string | undefined) ?? crypto.randomUUID(),
      name,
      // '' is no icon, the same thing the app's own add-project paths store.
      emoji: (body.emoji as string | undefined) ?? '',
      color: body.color as string | undefined,
      notes: body.notes as string | undefined,
      repeatFrequency: body.repeatFrequency as Project['repeatFrequency'],
      repeatDays: body.repeatDays as Project['repeatDays'],
      repeatMonthDay: body.repeatMonthDay as Project['repeatMonthDay'],
      timeBucket: body.timeBucket as Project['timeBucket'],
      startTime: body.startTime as Project['startTime'],
      duration: body.duration as Project['duration'],
    }

    await createProject(userId, project, serviceClient)

    return NextResponse.json({ project }, { status: 201 })
  } catch (err) {
    // The unique index spans the trash, so the holder of an exact name can be
    // a deleted project no endpoint shows (same wording as the PATCH route).
    const code = (err as { code?: string } | null)?.code
    if (code === '23505' || (err instanceof Error && err.message.includes('duplicate key value'))) {
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
