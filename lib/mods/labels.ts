/**
 * The rules for text a mod writes where the app draws it: its name in ⌘K, a
 * toast, the undo strip and Problems, and the titles and labels it writes
 * (memory/plans/mods.md, "Anti-spoofing"; build order 8). Pure, and imports
 * nothing, so ./schema.ts can re-export every name here.
 *
 * A mod is code its owner wrote or pasted, so its text is the one string in
 * the app that may be trying to look like the app. The checks run on the NFKC
 * form, so a full-width "ＡＩ" is "AI", and they refuse what could pass for
 * host chrome or a credential: the words the app's own sign-in, settings and
 * AI surfaces use, links and bare domains, key-shaped values, invisible
 * format characters (zero-width, bidi overrides), and one word spelled in
 * two alphabets ("Sеttings" with a Cyrillic е). A label written wholly in
 * another script is fine.
 *
 * Recipes keep their own, older rules (./schema.ts): these apply to mods.
 */

/** 061's name CHECK: char_length, which counts code points. */
export const MOD_NAME_MAX = 60;

/** Control characters, C0, DEL and C1: a little stricter than SQL's [[:cntrl:]], never looser. */
export const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** Titles a recipe or a mod writes carry no links (mods.md, "Never reachable"). */
export const URL_RE = /https?:\/\/|www\./i;

/** Format characters: zero-width, bidi overrides and isolates, the BOM. */
const FORMAT_RE = /\p{Cf}/u;

/** `evil.com/x`, `pay.example:443`. For mod-written text only. */
export const BARE_DOMAIN_RE = /\b[a-z0-9-]{2,}\.[a-z]{2,}(?:[/:]|\b)/i;

/** OpenAI-style and Google-style key prefixes. */
export const KEY_SHAPED_RE = /\b(?:sk-[A-Za-z0-9_-]{6,}|AIza[0-9A-Za-z_-]{6,})/;

/**
 * Words a mod's label may not use: the app's own account, sign-in, settings
 * and AI vocabulary and every model provider's name (a test holds these to
 * MODEL_PROVIDERS), and never "Beacon".
 */
export const MOD_LABEL_FORBIDDEN_RE =
  /\b(?:ai|settings?|sign[\s-]?(?:in|out|up)|log[\s-]?(?:in|out)|login|logout|account|keys?|passwords?|passcode|session|verify|verification|billing|payments?|card|beacon|openai|anthropic|claude|gemini|google|openrouter|openclaw)\b/i;

const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u];

export function normalizeModText(s: string): string {
  return s.normalize('NFKC');
}

export function isModName(s: string): boolean {
  const length = Array.from(s).length;
  return length >= 1 && length <= MOD_NAME_MAX && s.trim() !== '' && !CONTROL_RE.test(s);
}

/** True when one word's letters come from more than one of Latin, Cyrillic and Greek. */
export function isMixedScript(s: string): boolean {
  return s.split(/[^\p{L}\p{M}]+/u).some((word) => {
    let seen = 0;
    for (const re of SCRIPTS) if (re.test(word)) seen++;
    return seen > 1;
  });
}

/** No format or control characters, no link, bare domain or key-shaped value. */
export function isPlainModText(s: string): boolean {
  const n = normalizeModText(s);
  return (
    !FORMAT_RE.test(s) &&
    !FORMAT_RE.test(n) &&
    !CONTROL_RE.test(n) &&
    !URL_RE.test(n) &&
    !BARE_DOMAIN_RE.test(n) &&
    !KEY_SHAPED_RE.test(n)
  );
}

/** Plain text that also stays clear of the app's own words and of mixed-script look-alikes. */
export function passesLabelRule(s: string): boolean {
  const n = normalizeModText(s);
  return isPlainModText(s) && !isMixedScript(n) && !MOD_LABEL_FORBIDDEN_RE.test(n);
}

/** A name, command label or keyword a mod may show under the app's own chrome. */
export function isModLabel(s: string): boolean {
  return isModName(s) && passesLabelRule(s);
}

/**
 * What every surface calls a mod: its name when that passes the label rule,
 * else its slug, whose own regex is safe. The owner can write `name` straight
 * through PostgREST, so modLabel's looser rule is not enough here.
 */
export function modDisplayLabel(row: { name: string; slug: string }): string {
  return isModLabel(row.name) ? row.name : row.slug;
}
