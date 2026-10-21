import type { SupabaseClient } from '@supabase/supabase-js'
import { ORIGINAL_PACK_KINDS, RESEARCH_PACK_KINDS } from './prep-packs'

/**
 * Writing prep packs (migration 074's table), shared by the two writers:
 * /api/ai/prep, where the person's own model made them and the session client
 * writes under RLS, and /api/agent/items/:id/prep, where an agent (OpenClaw,
 * Claude) hands one back through MCP and the service client writes it after
 * the route has checked the item is the key holder's.
 */

export type PackRow = { item_id: string; user_id?: string; kind: string; body: Record<string, unknown>; made_for: string; model: string | null }
type Db = SupabaseClient

export const PACK_SELECT = 'item_id, kind, body, made_for, updated_at'

const WITH_QUESTION: ReadonlySet<string> = new Set([...ORIGINAL_PACK_KINDS, 'question'])

/**
 * Saves the rows, and before 080 / 079 / 078 are applied drops the kinds the
 * table's check refuses (23514), newest first, and keeps the rest, rather than
 * losing every pack in the batch to one of them. `rows` is trimmed in place to
 * what was tried last.
 */
export async function savePacks(
  db: Db,
  rows: Map<string, PackRow>
): Promise<{ saved: unknown[]; error: { code?: string; message?: string } | null }> {
  let result = await saveRows(db, rows)
  for (const allowed of [RESEARCH_PACK_KINDS, WITH_QUESTION, ORIGINAL_PACK_KINDS]) {
    if (result.error?.code !== '23514' || ![...rows.values()].some((r) => !allowed.has(r.kind))) continue
    for (const [itemId, r] of rows) if (!allowed.has(r.kind)) rows.delete(itemId)
    if (rows.size === 0) return { saved: [], error: null }
    result = await saveRows(db, rows)
  }
  return result
}

/** The 200-pack cap's trigger (074) refused the insert. */
export function packLimitHit(error: { message?: string } | null): boolean {
  return !!error?.message?.includes('prep_packs_limit')
}

/**
 * Keeps the packs. Not an upsert, and not delete-then-insert. PostgREST's ON
 * CONFLICT DO UPDATE assigns every payload column, `item_id` included, and 074
 * grants `authenticated` UPDATE on four named columns only; Postgres checks the
 * SET list up front, so the upsert was refused whole (42501) on the FIRST save
 * too, and no pack ever reached the table from the app (found 2026-10-17).
 * Deleting first would lose a pack at the 200 cap: 074's cap trigger spares
 * only an item whose pack still exists, and a multi-row insert that trips the
 * cap on a new item rolls the regenerated ones back after their delete
 * committed. So: INSERT ... ON CONFLICT DO NOTHING (supabase-js spells it
 * `upsert` + `ignoreDuplicates`; it has no SET list, so no UPDATE grant is
 * asked) takes the new items, which is exactly what the cap counts, and each
 * item it skipped gets an UPDATE of the four columns 074 lets us set, plus
 * `updated_at`, which it also grants.
 */
async function saveRows(
  db: Db,
  rows: Map<string, PackRow>
): Promise<{ saved: unknown[]; error: { code?: string; message?: string } | null }> {
  const { data: inserted, error: insertError } = await db
    .from('prep_packs')
    .upsert([...rows.values()], { onConflict: 'item_id', ignoreDuplicates: true })
    .select(PACK_SELECT)
  if (insertError) return { saved: [], error: insertError }
  const saved: unknown[] = [...(inserted ?? [])]
  const fresh = new Set(saved.map((r) => (r as { item_id: string }).item_id))
  const stamp = new Date().toISOString()
  for (const [itemId, row] of rows) {
    if (fresh.has(itemId)) continue
    const { kind, body, made_for, model } = row
    const { data: updated, error: updateError } = await db
      .from('prep_packs')
      .update({ kind, body, made_for, model, updated_at: stamp })
      .eq('item_id', itemId)
      .select(PACK_SELECT)
    if (updateError) return { saved, error: updateError }
    saved.push(...(updated ?? []))
  }
  return { saved, error: null }
}
