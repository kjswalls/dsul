import type { SupabaseClient } from '@supabase/supabase-js';
import { DRAFT_SLUG, USER_THEME_SLUG_RE, themeSlugForId } from '@/lib/user-themes/css';

/**
 * The names "Write with AI" may show the model (memory/plans/mods.md, "AI
 * writes it"): the person's project names, their own item types, and their
 * own themes' and Looks' names with the refs a recipe or Look uses. Nothing
 * else. Never an item, a title, a note or a conversation: an item's text can
 * come from outside (a captured email, an agent's item) and could carry
 * instructions, and none of it is needed to write a recipe, a theme or a Look.
 *
 * Server-only, and read here from the database, never from the request body,
 * so a client cannot put anything else in front of the model. Three narrow
 * selects through the session client (RLS), never the service role.
 *
 * Every name is user- or agent-writable text, so each is made one plain line
 * (control characters and line breaks gone, clipped). The prompt then frames
 * the lists as data and JSON-encodes them (./make-prompt.ts), and whatever
 * comes back is schema-checked in the browser and saved switched off.
 *
 * A failed read (a table missing on an older database, anything else) is an
 * empty list and one log line: Write still works without names.
 */

export interface MakeContext {
  projects: string[];
  types: { name: string; label: string }[];
  themes: { ref: `u-${string}`; name: string; mode: 'light' | 'dark' }[];
  looks: { ref: `u-${string}`; name: string }[];
}

export const EMPTY_MAKE_CONTEXT: MakeContext = Object.freeze({
  projects: [],
  types: [],
  themes: [],
  looks: [],
}) as unknown as MakeContext;

const MAX_PROJECTS = 50;
const MAX_TYPES = 20;
const MAX_MODS = 40;
const NAME_MAX = 60;

/** C0, DEL, C1, and the Unicode line and paragraph separators: each becomes a space. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/**
 * Characters that show nothing but can hide or reorder text: zero-width
 * marks, bidi embeddings, overrides and isolates, the word joiner and the
 * byte-order mark. Each is dropped.
 */
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** One plain line of at most 60 characters, or '' for nothing left. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(INVISIBLE_RE, '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, NAME_MAX).join('').trim();
}

type Rows = Record<string, unknown>[];

async function read(table: string, run: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<Rows> {
  try {
    const { data, error } = await run();
    if (error) throw error;
    return Array.isArray(data) ? (data as Rows) : [];
  } catch {
    // Never the error itself: it can quote the row.
    console.warn(`[ai] make context ${table} failed`);
    return [];
  }
}

export async function buildMakeContext(db: SupabaseClient, userId: string): Promise<MakeContext> {
  const [projectRows, typeRows, modRows] = await Promise.all([
    read('projects', () =>
      db
        .from('projects')
        .select('name')
        .eq('user_id', userId)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .limit(MAX_PROJECTS)
    ),
    read('item_types', () =>
      db
        .from('item_types')
        .select('name,label')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(MAX_TYPES)
    ),
    read('user_mods', () =>
      db
        .from('user_mods')
        .select('id,kind,name,created_at,mode:manifest->>mode')
        .eq('user_id', userId)
        .in('kind', ['theme', 'look'])
        .order('created_at', { ascending: true })
        .limit(MAX_MODS)
    ),
  ]);

  const projects = [...new Set(projectRows.map((r) => cleanName(r.name)).filter(Boolean))];

  const types: MakeContext['types'] = [];
  for (const r of typeRows) {
    const name = typeof r.name === 'string' && /^[a-z][a-z0-9-]{0,29}$/.test(r.name) ? r.name : '';
    const label = cleanName(r.label);
    if (name && label && !types.some((t) => t.name === name)) types.push({ name, label });
  }

  // The older row keeps a shared ref, as Make and the registry decide it.
  const themes: MakeContext['themes'] = [];
  const looks: MakeContext['looks'] = [];
  const seen = { theme: new Set<string>(), look: new Set<string>() };
  for (const r of modRows) {
    if (typeof r.id !== 'string' || (r.kind !== 'theme' && r.kind !== 'look')) continue;
    const ref = themeSlugForId(r.id);
    if (!USER_THEME_SLUG_RE.test(ref) || ref === DRAFT_SLUG || seen[r.kind].has(ref)) continue;
    const name = cleanName(r.name);
    if (!name) continue;
    if (r.kind === 'theme') {
      if (r.mode !== 'light' && r.mode !== 'dark') continue;
      seen.theme.add(ref);
      themes.push({ ref: ref as `u-${string}`, name, mode: r.mode });
    } else {
      seen.look.add(ref);
      looks.push({ ref: ref as `u-${string}`, name });
    }
  }

  return { projects, types, themes, looks };
}
