/**
 * Where each container sits on Atlas (migration 087): the browser's I/O. Rows
 * in `atlas_positions`, read and written through the SESSION client and RLS
 * (`createClient()` from lib/supabase), never the service role, and no server
 * route: no agent route, MCP tool or chat context reads this table.
 *
 * Pure I/O, no store and no React (the store is lib/atlas-store.ts). Each call
 * answers `'unavailable'` while 087 is not applied (42P01 / PGRST205), which
 * the store turns into the per-device fallback below. Any other read error
 * THROWS: a blip must never be mistaken for "no table", which would fork the
 * layout onto this device.
 *
 * The per-device fallback is one raw localStorage blob, `{userId, places}`. It
 * is keyed by the account's container ids, so it is DISCLOSIVE and cleared with
 * the account (`clearAtlasLocalState` in lib/local-state.ts's RAW_CLEARERS).
 * Another owner's blob reads as empty. Every storage access is in try/catch:
 * private mode and blocked site data throw.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase';
import type { AtlasKind } from '@/lib/atlas-model';

export type AtlasBand = 'now' | 'soon' | 'resting';

/** One card's memory: its place on Your map and its Momentum pin. */
export interface AtlasPlace {
  kind: AtlasKind;
  /** The container's uuid. */
  id: string;
  /** World px on Your map; both or neither. */
  x: number | null;
  y: number | null;
  /** Momentum's pin (PR2); null = the app sorts it. */
  band: AtlasBand | null;
  updatedAt?: string;
}

/** Which columns an upsert writes; the others keep what the row holds. */
export type AtlasFields = 'all' | 'xy' | 'band';

export type AtlasWrite = 'ok' | 'unavailable' | 'full' | 'failed';

type Db = SupabaseClient;

export const ATLAS_TABLE = 'atlas_positions';
export const ATLAS_COLUMNS = 'container_kind, container_id, x, y, pinned_band, updated_at';
export const ATLAS_CONFLICT = 'user_id,container_kind,container_id';
export const ATLAS_LOCAL_KEY = 'dsul-atlas-places';
/** 087's CHECK: world px within ±1,000,000. */
export const ATLAS_COORD_LIMIT = 1_000_000;

const KINDS: readonly AtlasKind[] = ['project', 'routine', 'season', 'goal'];
const BANDS: readonly AtlasBand[] = ['now', 'soon', 'resting'];

export const atlasPlaceKey = (kind: AtlasKind, id: string): string => `${kind}:${id}`;

const isMissingTable = (error: { code?: string } | null | undefined): boolean =>
  error?.code === '42P01' || error?.code === 'PGRST205';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A coordinate the table will take: finite, and clamped to 087's range. */
const clampCoord = (v: number) => Math.max(-ATLAS_COORD_LIMIT, Math.min(ATLAS_COORD_LIMIT, v));

/**
 * One place, coerced the way view-store's `merge` coerces persisted enums: an
 * unknown kind or a blank id drops the row, a band not in the three is null,
 * and an x/y pair that is not both finite is a null pair.
 */
export function coercePlace(raw: unknown): AtlasPlace | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = (r.kind ?? r.container_kind) as AtlasKind;
  const id = r.id ?? r.container_id;
  if (!KINDS.includes(kind) || typeof id !== 'string' || id === '') return null;
  const band = (r.band ?? r.pinned_band) as AtlasBand;
  const both = finite(r.x) && finite(r.y);
  const place: AtlasPlace = {
    kind,
    id,
    x: both ? clampCoord(r.x as number) : null,
    y: both ? clampCoord(r.y as number) : null,
    band: BANDS.includes(band) ? band : null,
  };
  const updatedAt = r.updatedAt ?? r.updated_at;
  if (typeof updatedAt === 'string') place.updatedAt = updatedAt;
  return place;
}

const coerceAll = (rows: unknown): AtlasPlace[] =>
  Array.isArray(rows) ? rows.map(coercePlace).filter((p): p is AtlasPlace => p !== null) : [];

/** Every place the account has; 'unavailable' while 087 is missing. Throws on any other error. */
export async function fetchAtlasPlaces(db?: Db): Promise<AtlasPlace[] | 'unavailable'> {
  const { data, error } = await (db ?? createClient()).from(ATLAS_TABLE).select(ATLAS_COLUMNS);
  if (error) {
    if (isMissingTable(error)) return 'unavailable';
    throw Object.assign(new Error(error.message ?? 'atlas positions: read failed'), { code: error.code });
  }
  return coerceAll(data);
}

/** The row an upsert sends: never user_id (087 grants no write of it; its default is auth.uid()). */
function rowFor(p: AtlasPlace, fields: AtlasFields): Record<string, unknown> {
  const row: Record<string, unknown> = { container_kind: p.kind, container_id: p.id };
  if (fields !== 'band') {
    const both = finite(p.x) && finite(p.y);
    row.x = both ? clampCoord(p.x as number) : null;
    row.y = both ? clampCoord(p.y as number) : null;
  }
  if (fields !== 'xy') row.pinned_band = p.band && BANDS.includes(p.band) ? p.band : null;
  return row;
}

/**
 * Write places in one upsert. `fields` picks the columns sent, and PostgREST's
 * upsert updates only the columns it is sent, so a drag ('xy') never clears a
 * pin another device set, and a pin ('band') never moves a card.
 */
export async function upsertAtlasPlaces(
  places: readonly AtlasPlace[],
  db?: Db,
  fields: AtlasFields = 'all'
): Promise<AtlasWrite> {
  const rows = places
    .filter((p) => KINDS.includes(p.kind) && typeof p.id === 'string' && p.id !== '')
    .map((p) => rowFor(p, fields));
  if (rows.length === 0) return 'ok';
  try {
    const { error } = await (db ?? createClient()).from(ATLAS_TABLE).upsert(rows, { onConflict: ATLAS_CONFLICT });
    if (!error) return 'ok';
    if (isMissingTable(error)) return 'unavailable';
    if ((error.message ?? '').includes('atlas_positions_limit')) return 'full';
    return 'failed';
  } catch {
    return 'failed';
  }
}

/** Forget one card (an unpinned card with no place). */
export async function deleteAtlasPlace(kind: AtlasKind, id: string, db?: Db): Promise<'ok' | 'unavailable' | 'failed'> {
  try {
    const { error } = await (db ?? createClient())
      .from(ATLAS_TABLE)
      .delete()
      .eq('container_kind', kind)
      .eq('container_id', id);
    if (!error) return 'ok';
    return isMissingTable(error) ? 'unavailable' : 'failed';
  } catch {
    return 'failed';
  }
}

// ── The per-device fallback ──────────────────────────────────────────────────

/** This device's places for `userId`; another account's blob, or none, is []. */
export function readLocalPlaces(userId: string): AtlasPlace[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(ATLAS_LOCAL_KEY);
    if (!raw) return [];
    const blob = JSON.parse(raw) as { userId?: unknown; places?: unknown };
    if (!blob || blob.userId !== userId) return [];
    return coerceAll(blob.places);
  } catch {
    return [];
  }
}

/** Replace this device's places for `userId`. A storage that throws is harmless. */
export function writeLocalPlaces(userId: string, places: readonly AtlasPlace[]): void {
  if (typeof window === 'undefined') return;
  try {
    const clean = coerceAll(places.map((p) => ({ kind: p.kind, id: p.id, x: p.x, y: p.y, band: p.band })));
    window.localStorage.setItem(ATLAS_LOCAL_KEY, JSON.stringify({ userId, places: clean }));
  } catch {
    // Private mode or a full quota: the places stay in memory for this tab.
  }
}

/** lib/local-state.ts's raw clearer: the blob is keyed by the account's container ids. */
export function clearAtlasLocalState(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(ATLAS_LOCAL_KEY);
  } catch {
    // Unreadable storage holds nothing we could remove.
  }
}
