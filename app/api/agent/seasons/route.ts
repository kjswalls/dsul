import { makeContainerCreateHandler } from '@/lib/agent-api'

/**
 * POST /api/agent/seasons
 *
 * Creates a season — a period of life (a summer, a term) holding items and/or
 * routines, whose members are hidden while it is off.
 *
 * Auth: Bearer <openclaw_api_key> only — no cookie auth.
 *
 * Body: validated against SeasonCreateSchema (@dsul/types). `name` is
 * required; `state` defaults to 'auto', which with no range means "always on".
 * `startsOn`/`endsOn` are INCLUSIVE and read only while the state is 'auto'.
 *
 * Reads live on GET /api/agent/context (seasons[], schemaVersion 4).
 *
 * Response: { season } with 201 status
 */
export const POST = makeContainerCreateHandler('season')
