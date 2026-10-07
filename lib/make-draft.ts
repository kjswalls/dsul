import { z } from 'zod';
import { extractJsonObject } from './json-extract';
import { isMakeKind, type MakeKind } from './ai-limits';
import {
  LookManifestSchema,
  MOD_NAME_MAX,
  RecipeManifestSchema,
  ThemeManifestSchema,
  isModName,
  type LookManifest,
  type RecipeManifest,
  type ThemeManifest,
  type UserMod,
} from './mods/schema';
import { canonicalTokens } from './mods/theme-grammar';
import { contrastWarnings, type ContrastWarning } from './mods/theme-contrast';
import { validateRecipe, type RecipeEnv } from './recipes/validate';
import { lookRefForId, lookRefProblems, ownThemesOfMode } from './user-looks';
import { isUserThemeSlug } from './user-themes/css';

/**
 * A "Write with AI" reply, checked (memory/plans/mods.md, "AI writes it").
 * Pure: the text in, a draft or a plain reason out. Nothing here is stored.
 *
 * The reply is owner-untrusted text from a model, so it goes through the same
 * schemas and run rules every saved row does (the theme grammar included),
 * plus three rules of its own:
 *  - a step may act only on the item that started the recipe. A step naming an
 *    item by id is refused: an id comes with a title, and the model never sees
 *    titles, so any id it writes is made up. The person can add one in Edit.
 *  - a theme never carries `contrastOverride`. Saving colours that are hard to
 *    read is the person's choice, made in the editor, so it is stripped here
 *    and a shortfall is a problem that holds Install (Edit still opens).
 *  - a recipe or Look ref of the person's own must name one they have.
 *
 * Drafts come only from Make's own Write box, never from a chat reply
 * (tests/unit/make-boundary.test.ts).
 */

export type MakeDraft =
  | { kind: 'recipe'; name: string; manifest: RecipeManifest }
  | { kind: 'theme'; name: string; manifest: ThemeManifest; warnings: ContrastWarning[] }
  | { kind: 'look'; name: string; manifest: LookManifest };

/** `cut_short`: an object was opened and never closed, so the reply ran out of room. */
export type DraftFailure = 'unreadable' | 'cut_short' | 'wrong_kind' | 'not_this_kind';

export type DraftResult =
  /** `problems` non-empty: Install is held, Edit still opens it. */
  | { ok: true; draft: MakeDraft; problems: string[] }
  | { ok: false; reason: DraftFailure; suggest?: MakeKind };

export interface DraftEnv {
  recipe: RecipeEnv;
  /** mods-store's rows: the person's own themes and Looks. */
  rows: readonly UserMod[];
}

export const FALLBACK_NAME: Record<MakeKind, string> = {
  recipe: 'New recipe',
  theme: 'New theme',
  look: 'New Look',
};

export const CONTRAST_PROBLEM = 'Some colours are hard to read. Open it in Edit to check them.';

const EnvelopeSchema = z.union([
  z.object({ kind: z.literal('none'), suggest: z.unknown().optional() }).passthrough(),
  z.object({ kind: z.string(), name: z.unknown().optional(), manifest: z.unknown() }).passthrough(),
]);

function draftName(raw: unknown, kind: MakeKind): string {
  if (typeof raw !== 'string') return FALLBACK_NAME[kind];
  const name = Array.from(raw.trim()).slice(0, MOD_NAME_MAX).join('').trim();
  return isModName(name) ? name : FALLBACK_NAME[kind];
}

/** A recipe's steps that name a theme or Look of the person's own they do not have. */
function ownRefProblems(m: RecipeManifest, rows: readonly UserMod[]): string[] {
  const problems: string[] = [];
  m.steps.forEach((step, i) => {
    if (step.do === 'setTheme' && isUserThemeSlug(step.theme)) {
      if (!ownThemesOfMode(rows, step.mode).some((t) => t.slug === step.theme)) {
        problems.push(`Step ${i + 1} names a ${step.mode} theme you do not have.`);
      }
    }
    if (step.do === 'applyLook' && isUserThemeSlug(step.look)) {
      if (!rows.some((r) => r.kind === 'look' && lookRefForId(r.id) === step.look)) {
        problems.push(`Step ${i + 1} names a Look you do not have.`);
      }
    }
  });
  return problems;
}

/**
 * Every top-level `{...}` in the text, string- and escape-aware, and whether
 * one was left open at the end (the reply ran out of room). A model that
 * repeats the example before its answer writes two objects; the widest-span
 * extraction alone would read both as one and fail.
 */
export function scanJsonObjects(text: string): { objects: unknown[]; open: boolean } {
  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      if (depth > 0) inString = true;
    } else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        try {
          objects.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // Not JSON after all: skip it.
        }
      }
    }
  }
  return { objects, open: depth > 0 };
}

/** The object to read: the last one of the asked kind, else the last one, else the widest span. */
function pickObject(raw: string, kind: MakeKind): { json: unknown; open: boolean } {
  const { objects, open } = scanJsonObjects(raw);
  const isKind = (o: unknown) => !!o && typeof o === 'object' && (o as { kind?: unknown }).kind === kind;
  const json = [...objects].reverse().find(isKind) ?? objects.at(-1) ?? extractJsonObject(raw);
  return { json, open: objects.length === 0 && open };
}

export function parseMakeDraft(raw: string, kind: MakeKind, env: DraftEnv): DraftResult {
  const { json, open } = pickObject(raw, kind);
  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) return { ok: false, reason: open ? 'cut_short' : 'unreadable' };
  const e = envelope.data;

  if (e.kind === 'none') {
    const suggest = isMakeKind(e.suggest) && e.suggest !== kind ? e.suggest : undefined;
    return { ok: false, reason: 'not_this_kind', ...(suggest && { suggest }) };
  }
  if (e.kind !== kind) {
    return { ok: false, reason: 'wrong_kind', ...(isMakeKind(e.kind) && { suggest: e.kind }) };
  }
  const name = draftName((e as { name?: unknown }).name, kind);
  const manifest = (e as { manifest?: unknown }).manifest;

  switch (kind) {
    case 'recipe': {
      const parsed = RecipeManifestSchema.safeParse(manifest);
      if (!parsed.success) return { ok: false, reason: 'unreadable' };
      const m = parsed.data;
      // Only the item that started it: see the header.
      if (m.steps.some((s) => 'item' in s && s.item !== 'trigger')) return { ok: false, reason: 'unreadable' };
      const problems = [...validateRecipe(m, env.recipe), ...ownRefProblems(m, env.rows)];
      return { ok: true, draft: { kind, name, manifest: m }, problems };
    }
    case 'theme': {
      if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
        // The person's call, never the model's.
        delete (manifest as Record<string, unknown>).contrastOverride;
      }
      const parsed = ThemeManifestSchema.safeParse(manifest);
      if (!parsed.success) return { ok: false, reason: 'unreadable' };
      const m: ThemeManifest = { ...parsed.data, tokens: canonicalTokens(parsed.data.tokens) };
      const warnings = contrastWarnings(m);
      return { ok: true, draft: { kind, name, manifest: m, warnings }, problems: warnings.length ? [CONTRAST_PROBLEM] : [] };
    }
    case 'look': {
      const parsed = LookManifestSchema.safeParse(manifest);
      if (!parsed.success) return { ok: false, reason: 'unreadable' };
      return { ok: true, draft: { kind, name, manifest: parsed.data }, problems: lookRefProblems(parsed.data, env.rows) };
    }
  }
}
