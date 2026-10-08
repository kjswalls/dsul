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
 * MODEL_PROVIDERS), and never "Beacon". A word ends where the letters do, so
 * "my_settings" and "Settings2" are refused as "Settings" is, and plurals
 * are spelled out; "Said" and "Aim" are not "AI". Tested against
 * confusableSkeleton(), so "АІ" in Cyrillic letters is refused too.
 */
export const MOD_LABEL_FORBIDDEN_RE =
  /(?<!\p{L})(?:ai|settings?|sign[\s_-]?(?:in|out|up)s?|log[\s_-]?(?:in|out)s?|logins?|logouts?|accounts?|keys?|passkeys?|passwords?|passcodes?|sessions?|verify|verification|billing|payments?|cards?|credentials?|tokens?|beacon|openai|anthropic|claude|gemini|google|openrouter|openclaw)(?!\p{L})/iu;

/**
 * Cyrillic and Greek letters that read as Latin ones. A label written wholly
 * in another script passes the mixed-script check, so the forbidden words are
 * tested against this skeleton as well.
 */
const CONFUSABLES: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', Ү: 'Y',
  І: 'I', Ӏ: 'I', Ј: 'J', Ѕ: 'S', Ԁ: 'D', Ԛ: 'Q', Ԝ: 'W',
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', х: 'x', у: 'y', ү: 'y',
  і: 'i', ӏ: 'l', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ԛ: 'q', ԝ: 'w', п: 'n', г: 'r',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y',
};

/** The text with every Cyrillic and Greek look-alike swapped for the Latin letter it reads as. */
export function confusableSkeleton(s: string): string {
  return s.replace(/[\u0370-\u03ff\u0400-\u052f]/g, (ch) => CONFUSABLES[ch] ?? ch);
}

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
  return (
    isPlainModText(s) &&
    !isMixedScript(n) &&
    !MOD_LABEL_FORBIDDEN_RE.test(n) &&
    !MOD_LABEL_FORBIDDEN_RE.test(confusableSkeleton(n))
  );
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

/* ── What a panel draws (build order 9) ─────────────────────────────────── */

// A panel sits in the app's own rail, sheet and braindump, so its text is held
// to a stricter rule than a ⌘K label. These are new names: widening the label
// rule itself would make manifests stored under build order 8 fail at load.

/**
 * A credential's shape: KEY_SHAPED_RE's prefixes, the common provider and
 * forge token prefixes, a JWT's head, and any run of 32 or more base64ish
 * characters holding both a letter and a digit.
 */
export const SECRET_SHAPED_RE = new RegExp(
  [
    KEY_SHAPED_RE.source,
    String.raw`\b(?:sk_(?:live|test)_|rk_live_|ghp_|gho_|github_pat_|glpat-|xox[abpr]-)`,
    String.raw`\bAKIA[0-9A-Z]{16}`,
    String.raw`\beyJ[\w-]{10,}\.`,
    String.raw`(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_=-]*[A-Za-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]{32,}`,
  ].join('|')
);

/**
 * The words a panel may not draw: the label rule's, plus sign-in, session,
 * model and chat words. A bare "pin" stays allowed (dsul pins items), so only
 * "your PIN" and "enter PIN" are a credential's ask; "author" is not "auth".
 */
const SURFACE_EXTRA_WORDS = [
  String.raw`signed|signing|logged|logging|log[\s_-]?off|re-?connect(?:s|ed|ing)?|secrets?|otp|2fa|mfa|api|assistant|chat(?:s|bot)?|gpt|models?|ask`,
  String.raw`sign[\s_-]+back[\s_-]+in|auth[nz]?|authenticat\w*|re-?auth\w*|(?:un)?authori[sz]\w*|oauth\w*`,
  String.raw`passphrases?|(?:your|enter)[\s_-]+pins?|pin[\s_-]?(?:codes?|numbers?)|user[\s_-]?names?`,
  String.raw`unlock(?:s|ed|ing)?|identity|identities|expired`,
].join('|');
export const MOD_SURFACE_FORBIDDEN_RE = new RegExp(
  MOD_LABEL_FORBIDDEN_RE.source.replace('(?:', `(?:${SURFACE_EXTRA_WORDS}|`),
  'iu'
);

function linePassesSurfaceRule(line: string): boolean {
  const n = normalizeModText(line);
  const skeleton = confusableSkeleton(n);
  return (
    isPlainModText(line) &&
    !isMixedScript(n) &&
    !MOD_LABEL_FORBIDDEN_RE.test(n) &&
    !MOD_LABEL_FORBIDDEN_RE.test(skeleton) &&
    !MOD_SURFACE_FORBIDDEN_RE.test(n) &&
    !MOD_SURFACE_FORBIDDEN_RE.test(skeleton) &&
    !SECRET_SHAPED_RE.test(n)
  );
}

/**
 * Text a mod draws in a panel, a panel or setting label, or an atom it sets.
 * Checked line by line, so a newline is the one control character it may hold.
 */
export function passesSurfaceRule(s: string): boolean {
  return s.split('\n').every(linePassesSurfaceRule);
}

/**
 * What the person typed into a mod's field or setting, before the mod sees it.
 * Ordinary words are fine ("chat with mom"); a value shaped like a password
 * manager's fill or a pasted key is not.
 */
export function isSafeTypedValue(s: string): boolean {
  return !FORMAT_RE.test(s) && !SECRET_SHAPED_RE.test(normalizeModText(s));
}

/**
 * What a panel's chrome calls a mod (the rail, the card, the sheet, the
 * opener, ⌘K's Open commands): modDisplayLabel, kept clear of the surface
 * words as well, else the slug. Only the words: a name is the owner's own and
 * a long one with digits in it is a name, not a key someone pasted. Only the
 * display falls back, so a name stored under build order 8 still loads.
 */
export function modSurfaceLabel(row: { name: string; slug: string }): string {
  if (!isModLabel(row.name)) return row.slug;
  const n = normalizeModText(row.name);
  return MOD_SURFACE_FORBIDDEN_RE.test(n) || MOD_SURFACE_FORBIDDEN_RE.test(confusableSkeleton(n)) ? row.slug : row.name;
}

/** A fault message or disabled reason as a panel may show it. */
export function surfaceMessage(s: string): string {
  return passesSurfaceRule(s) ? s : '(message hidden)';
}
