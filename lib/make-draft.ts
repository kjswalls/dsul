import { z } from 'zod';
import { extractJsonObject } from './json-extract';
import { isMakeKind, type MakeKind } from './ai-limits';
import {
  LookManifestSchema,
  MOD_EVENT_KINDS,
  MOD_NAME_MAX,
  MOD_SOURCE_MAX_BYTES,
  ModManifestSchema,
  RecipeManifestSchema,
  SECRET_SHAPED_RE,
  ThemeManifestSchema,
  URL_RE,
  isModLabel,
  isModName,
  normalizeModText,
  passesSurfaceRule,
  surfaceMessage,
  type LookManifest,
  type ModEventKind,
  type ModManifest,
  type RecipeManifest,
  type ThemeManifest,
  type UserMod,
} from './mods/schema';
import { METHOD_USES } from './mods/broker-core';
import { faultCodeWords } from './mods/faults';
import { MOD_METHODS, type FaultCode, type ModMethod } from './mods/protocol';
import { MOD_TEMPLATE } from './mods/template';
import { MOD_USE_WORDS } from './mods/words';
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
 * A mod (build order 10) is read in two steps, because its manifest is what
 * its code declares, and only running the code can say that. parseMakeDraft
 * takes the source out of the reply (`ok: 'scratch'`); the Write box runs it
 * once in the sandbox with no `$` and no hook; finishModDraft turns what that
 * run read into the draft. Its extra checks (draftChecks) are a quality and
 * copy guard, not the safety boundary: that is the switched-off save, the
 * runtime's manifest comparison and the broker's per-call gate.
 *
 * Drafts come only from Make's own Write box, never from a chat reply
 * (tests/unit/make-boundary.test.ts).
 */

export type MakeDraft =
  | { kind: 'recipe'; name: string; manifest: RecipeManifest }
  | { kind: 'theme'; name: string; manifest: ThemeManifest; warnings: ContrastWarning[] }
  | { kind: 'look'; name: string; manifest: LookManifest }
  /**
   * `manifest` and `hooks` are what the code declared when it was run once
   * (finishModDraft); null when it would not load or its manifest is not
   * valid, and Install is held. The hooks are as written now: `register` is
   * ordinary code and may pick others next time.
   */
  | { kind: 'mod'; name: string; source: string; manifest: ModManifest | null; hooks: ModEventKind[] };

/** `cut_short`: an object was opened and never closed, so the reply ran out of room. */
export type DraftFailure = 'unreadable' | 'cut_short' | 'wrong_kind' | 'not_this_kind';

export type DraftResult =
  /** `problems` non-empty: Install is held, Edit still opens it. */
  | { ok: true; draft: MakeDraft; problems: string[] }
  /** A mod's source, to be run once in the sandbox and then read by finishModDraft. */
  | { ok: 'scratch'; name: string; source: string }
  /** `message`: words of its own for this failure, in place of the reason's. */
  | { ok: false; reason: DraftFailure; suggest?: MakeKind; message?: string };

/**
 * What one sandbox run of a mod's code read (lib/mods/sandbox-host.ts's
 * ScratchResult, without its status answers, which the Write box handles
 * before it gets here). Structural, so this file never imports the sandbox.
 */
export type ScratchLike =
  | { manifestJson: string; hooks: ModEventKind[] }
  | { fault: { code: FaultCode; message: string } };

export interface DraftEnv {
  recipe: RecipeEnv;
  /** mods-store's rows: the person's own themes and Looks. */
  rows: readonly UserMod[];
}

export const FALLBACK_NAME: Record<MakeKind, string> = {
  recipe: 'New recipe',
  theme: 'New theme',
  look: 'New Look',
  mod: 'New mod',
};

export const CONTRAST_PROBLEM = 'Some colours are hard to read. Open it in Edit to check them.';
export const ECHO_COPY = 'It repeated the example instead of writing your mod.';

const EnvelopeSchema = z.union([
  z.object({ kind: z.literal('none'), suggest: z.unknown().optional() }).passthrough(),
  z.object({ kind: z.string(), name: z.unknown().optional(), manifest: z.unknown() }).passthrough(),
]);

function draftName(raw: unknown, kind: MakeKind): string {
  if (typeof raw !== 'string') return FALLBACK_NAME[kind];
  const name = Array.from(raw.trim()).slice(0, MOD_NAME_MAX).join('').trim();
  // A mod's name is shown in the command bar ("Your mod · <name>: ..."), so
  // it takes the label rule the store will hold it to.
  const ok = isModName(name) && (kind !== 'mod' || isModLabel(name));
  return ok ? name : FALLBACK_NAME[kind];
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

const CONTROL_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * The slice with every raw control character inside a JSON string turned
 * into its escape. A model asked for a module as one JSON string often writes
 * its newlines as they are, which JSON.parse refuses; the scanner still
 * closes the object, since it tracks quotes, not lines.
 */
export function escapeRawControlsInStrings(slice: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const c of slice) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      else if (c < ' ') {
        out += CONTROL_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
        continue;
      }
    } else if (c === '"') inString = true;
    out += c;
  }
  return out;
}

/**
 * Every top-level `{...}` in the text, string- and escape-aware, and whether
 * one was left open at the end (the reply ran out of room). A model that
 * repeats the example before its answer writes two objects; the widest-span
 * extraction alone would read both as one and fail. `repairControls` (a mod's
 * reply only) gives an object JSON.parse refused one more try with its raw
 * control characters escaped.
 */
export function scanJsonObjects(
  text: string,
  { repairControls = false }: { repairControls?: boolean } = {}
): { objects: unknown[]; open: boolean } {
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
        const slice = text.slice(start, i + 1);
        try {
          objects.push(JSON.parse(slice));
        } catch {
          // Not JSON after all: skip it, unless the repair reads it.
          if (repairControls) {
            try {
              objects.push(JSON.parse(escapeRawControlsInStrings(slice)));
            } catch {
              // Not even then.
            }
          }
        }
      }
    }
  }
  return { objects, open: depth > 0 };
}

/**
 * The object to read: the last one of the asked kind, else the last one, else
 * the widest span. `open` means the reply was cut short. For a mod that is any
 * object left open at the end, even after one that closed, so an example the
 * model repeated before a draft that ran out of room is never installed.
 */
function pickObject(raw: string, kind: MakeKind): { json: unknown; open: boolean } {
  const mod = kind === 'mod';
  const { objects, open } = scanJsonObjects(raw, { repairControls: mod });
  if (mod && open) return { json: undefined, open: true };
  const isKind = (o: unknown) => !!o && typeof o === 'object' && (o as { kind?: unknown }).kind === kind;
  const json = [...objects].reverse().find(isKind) ?? objects.at(-1) ?? extractJsonObject(raw);
  return { json, open: objects.length === 0 && open };
}

const encoder = new TextEncoder();

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
    case 'mod': {
      const source = (e as { source?: unknown }).source;
      if (typeof source !== 'string' || source.trim() === '') return { ok: false, reason: 'unreadable' };
      // A guard: the stream's own cap is lower than the column's.
      if (encoder.encode(source).length > MOD_SOURCE_MAX_BYTES) return { ok: false, reason: 'unreadable' };
      if (source.trim() === MOD_TEMPLATE.trim()) return { ok: false, reason: 'unreadable', message: ECHO_COPY };
      return { ok: 'scratch', name, source };
    }
  }
}

/**
 * A mod's source read as JavaScript, roughly: its string literals (template
 * literals whole, their `${}` parts with them) and its code with comments
 * and literals taken out. Enough for the checks below, which are hints and
 * copy guards; a regex literal holding a quote can throw it off.
 */
function splitSource(source: string): { literals: string[]; code: string } {
  const literals: string[] = [];
  let code = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      code += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      let text = '';
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') {
          text += source[i + 1] ?? '';
          i += 2;
        } else {
          // A plain quote ends at the line; a template literal does not.
          if (c !== '`' && source[i] === '\n') break;
          text += source[i++];
        }
      }
      i++;
      literals.push(text);
      code += "''";
    } else {
      code += c;
      i++;
    }
  }
  return { literals, code };
}

const EVENT_NAMES: ReadonlySet<string> = new Set(MOD_EVENT_KINDS);
const METHODS: ReadonlySet<string> = new Set(MOD_METHODS);
/** `$.items.query(`, not `x$.y(`; the path's own spaces are dropped. */
const DOLLAR_CALL_RE = /(?<![\w$])\$\s*\.\s*([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/g;
const PATH_SHOWN_MAX = 40;

/**
 * The extra rules a mod Write drafted is held to, on top of the schema
 * (build order 10): run by finishModDraft and, for the whole session of a
 * draft opened in Edit, by the mod editor's Save. Each problem holds Install
 * (or Save). None of it is a security boundary.
 *  - A command's label and keywords take the stricter surface rule too.
 *  - No string literal holds a link or something shaped like a key. Event
 *    names are skipped by name; the bare-domain rule is not used, since it
 *    matches every dotted event name.
 *  - The hooks and the manifest agree: panels are drawn, commands are run,
 *    and panel hooks have panels.
 *  - Every `$.x(` is a method mods have, and its use is declared. A hint: the
 *    scan misses `$['x']` and destructuring, and the broker holds every call.
 */
export function draftChecks(source: string, manifest: ModManifest, hooks: readonly ModEventKind[]): string[] {
  const problems: string[] = [];
  manifest.commands.forEach((c, i) => {
    if (!passesSurfaceRule(c.label)) problems.push(`Command ${i + 1} has a label that cannot be shown.`);
    if (c.keywords?.some((k) => !passesSurfaceRule(k))) {
      problems.push(`Command ${i + 1} has a keyword that cannot be shown.`);
    }
  });

  const { literals, code } = splitSource(source);
  const plain = literals.filter((l) => !EVENT_NAMES.has(l)).map(normalizeModText);
  if (plain.some((l) => URL_RE.test(l))) problems.push('Its code holds a link. Mods cannot reach the web.');
  if (plain.some((l) => SECRET_SHAPED_RE.test(l))) problems.push('Its code holds something shaped like a key.');

  const has = (k: ModEventKind) => hooks.includes(k);
  if (manifest.panels.length > 0 && !has('ui.resolve')) {
    problems.push('It has panels but no "ui.resolve" hook to draw them.');
  }
  if (manifest.commands.length > 0 && !has('command')) {
    problems.push('It has commands but no "command" hook to run them.');
  }
  if (manifest.commands.length === 0 && has('command')) problems.push('It has a "command" hook but no commands.');
  if (manifest.panels.length === 0 && (has('ui.action') || has('atom.changed'))) {
    problems.push('It listens to a panel but has no panels.');
  }

  for (const m of code.matchAll(DOLLAR_CALL_RE)) {
    const path = m[1].replace(/\s+/g, '');
    if (!METHODS.has(path)) {
      problems.push(`It calls $.${path.slice(0, PATH_SHOWN_MAX)}, which mods do not have.`);
      continue;
    }
    const use = METHOD_USES[path as ModMethod];
    if (use && !manifest.uses.includes(use)) {
      problems.push(`It uses $.${path} but did not ask to ${MOD_USE_WORDS[use]}.`);
    }
  }
  return [...new Set(problems)];
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * A mod's draft from its source and what one sandbox run of it read. Always
 * a draft, so the card can show the code and open it in Edit; anything wrong
 * is a problem that holds Install. The manifest shown and installed is the
 * one the code declared in that run, never one the reply wrote apart from it.
 * The mod's own words reach the card only through surfaceMessage.
 */
export function finishModDraft(pending: { name: string; source: string }, scratch: ScratchLike): DraftResult {
  const { name, source } = pending;
  const held = (problems: string[]): DraftResult => ({
    ok: true,
    draft: { kind: 'mod', name, source, manifest: null, hooks: [] },
    problems,
  });
  if ('fault' in scratch) {
    const { code, message } = scratch.fault;
    const head = code === 'load' ? 'It would not load.' : `It would not load: ${lowerFirst(faultCodeWords(code))}.`;
    return held(message.trim() ? [head, `Your mod reported: ${surfaceMessage(message.trim())}`] : [head]);
  }
  let parsed: ReturnType<typeof ModManifestSchema.safeParse>;
  try {
    parsed = ModManifestSchema.safeParse(JSON.parse(scratch.manifestJson));
  } catch {
    return held(['Its manifest is not valid.']);
  }
  if (!parsed.success) {
    // The path only: an issue's message can quote the code's own values.
    const path = parsed.error.issues[0]?.path.join('.');
    return held(path ? ['Its manifest is not valid.', `Check "${path}" in it.`] : ['Its manifest is not valid.']);
  }
  const manifest = parsed.data;
  const hooks = [...scratch.hooks];
  return { ok: true, draft: { kind: 'mod', name, source, manifest, hooks }, problems: draftChecks(source, manifest, hooks) };
}
