// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

/**
 * The AI has no name. "Beacon" survives only where the user never reads it:
 * identifiers (`askBeacon`, `buildBeaconSystemPrompt`), file names, stored
 * values (`assignee: 'beacon'`, the `beacon` pane id), and comments.
 *
 * Why an AST scan and not a grep: the word is everywhere in comments and
 * identifiers on purpose (they are contracts or history), and a grep cannot
 * tell `askBeacon()` from `'Ask Beacon'`. The compiler can. Every piece of text
 * that can reach a screen in this codebase is one of: a string literal (which
 * covers JSX attribute strings), a template literal chunk, or JSX text. Comments
 * are not nodes at all, so internal notes stay free to say the old name.
 *
 * ONE literal is allowed, by file and exact text: the persisted, unread
 * `assistantName: 'Beacon'` default in lib/ai-settings-store.ts. It is a stored
 * setting that no view reads (kept per the CLAUDE.md rule on such settings), so
 * it cannot reach a screen; the allowlist is exact so it cannot grow quietly.
 */

const ROOT = path.resolve(__dirname, '../..');
const SCANNED_DIRS = ['app', 'components', 'lib', 'hooks'];
const NAME = /\bBeacon\b/;

/** file → the exact literal texts allowed there. */
const ALLOWED: Record<string, string[]> = {
  'lib/ai-settings-store.ts': ['Beacon'],
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  kind: string;
  text: string;
}

/**
 * The node kinds that carry text a user can read, labelled by hand: SyntaxKind
 * has aliased members (TemplateTail is also LastTemplateToken), so
 * `ts.SyntaxKind[kind]` would print whichever alias was declared last.
 */
const TEXT_KINDS = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.StringLiteral, 'string'],
  [ts.SyntaxKind.NoSubstitutionTemplateLiteral, 'template'],
  [ts.SyntaxKind.TemplateHead, 'template'],
  [ts.SyntaxKind.TemplateMiddle, 'template'],
  [ts.SyntaxKind.TemplateTail, 'template'],
  [ts.SyntaxKind.JsxText, 'jsx-text'],
]);

/** Every user-visible text node in `source` that says the old name. */
function hitsIn(rel: string, source: string): Hit[] {
  const sf = ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    const kind = TEXT_KINDS.get(node.kind);
    if (kind) {
      // JsxText and every literal-like node expose their cooked text as `.text`.
      const text = (node as ts.LiteralLikeNode).text;
      if (NAME.test(text)) {
        hits.push({
          file: rel,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          kind,
          text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function allHits(): Hit[] {
  return SCANNED_DIRS.flatMap((d) => sourceFiles(path.join(ROOT, d))).flatMap((file) =>
    hitsIn(path.relative(ROOT, file).split(path.sep).join('/'), readFileSync(file, 'utf8'))
  );
}

const isAllowed = (h: Hit) => (ALLOWED[h.file] ?? []).includes(h.text);

describe('no "Beacon" in user-visible copy', () => {
  it('finds the old name in no string, template chunk or JSX text', () => {
    const offenders = allHits()
      .filter((h) => !isAllowed(h))
      .map((h) => `${h.file}:${h.line} ${h.kind} ${JSON.stringify(h.text.trim().slice(0, 120))}`);
    expect(offenders).toEqual([]);
  });

  it('still finds every allowlisted literal, so the allowlist cannot go stale', () => {
    const allowedHits = allHits().filter(isAllowed);
    for (const [file, texts] of Object.entries(ALLOWED)) {
      for (const text of texts) {
        expect(
          allowedHits.some((h) => h.file === file && h.text === text),
          `${file} ${JSON.stringify(text)}`
        ).toBe(true);
      }
    }
  });

  it('sees through comments and identifiers, and catches each kind of text', () => {
    // The scanner's own contract, on a fixture: if it ever stopped seeing one of
    // these node kinds, the scan above would pass vacuously.
    const fixture = [
      '// Beacon in a comment is fine',
      'const askBeacon = () => null;',
      "const a = 'Ask Beacon';",
      'const b = `Plan with ${askBeacon}, Beacon`;',
      'const c = <p title="Beacon">Hello Beacon</p>;',
      "const d = 'beacon';",
    ].join('\n');
    const kinds = hitsIn('fixture.tsx', fixture).map((h) => h.kind);
    // 'Ask Beacon', the title="Beacon" attribute, the template's tail chunk,
    // and the JSX text. Not the comment, the identifier, or lowercase 'beacon'.
    expect(kinds.sort()).toEqual(['jsx-text', 'string', 'string', 'template']);
  });
});
