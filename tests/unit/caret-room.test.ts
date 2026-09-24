import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

/**
 * No text field paints its caret against its own clip edge.
 *
 * ## The bug this pins
 *
 * Kirby: "when typing in certain fields, like the task name and notes field on
 * the new item modal, the cursor is partly cut off at the edges of the field."
 *
 * An `<input>` or `<textarea>` clips its contents to its PADDING box, and the
 * caret is part of its contents. The borderless "reads as text, not a control"
 * fields — the item title and notes, the omnibar, the braindump capture row,
 * the chat composer, the Organize filters — all zeroed their inline padding so
 * the text would sit flush with the copy around it. With zero padding the caret
 * at position 0 sits ON the clip edge, and a caret wider than a hairline
 * (Safari's and macOS's are ~2px and centred on the position) loses its
 * outer half. Same at the far end once the text scrolls.
 *
 * ## The recipe
 *
 * `-mx-1 px-1`: four pixels of padding for the caret to paint into, cancelled
 * by a matching negative margin so the TEXT still starts exactly where it did.
 * A field that was `w-full` also takes `w-[calc(100%+0.5rem)]` so its right
 * edge stays put. The Organize title inputs already used this shape for their
 * focus well; this makes it the rule for every borderless field.
 *
 * ## What the test checks
 *
 * Every text-entry element in components/ and app/ whose className is static
 * enough to read: it must not zero its inline padding (`p-0` / `px-0`), and a
 * RAW `<input>`/`<textarea>` — which Tailwind's preflight leaves at padding 0 —
 * must pad both sides itself, in every state. `Input`/`Textarea` inherit `px-3` from
 * the primitive, so they only fail by overriding it to zero.
 */

const ROOTS = ['components', 'app'];
const RAW = new Set(['input', 'textarea', 'CommandPrimitive.Input']);
// Wrappers that merge a caller's className onto a text field: the override at
// the call site is what can zero the padding, so read it there.
const WRAPPED = new Set(['Input', 'Textarea', 'BufferedInput', 'BufferedTextarea', 'CommandInput']);
const NON_TEXT = /\b(checkbox|radio|range|color|file|hidden|date)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * The class tokens in a className expression. `all` is every literal anywhere
 * in it; `sure` skips conditional branches (`a ? b : c`, `x && 'y'`), so padding
 * that only exists in one state doesn't count as always there.
 */
function classTokens(init: ts.Node): { all: string[]; sure: string[] } {
  const all: string[] = [];
  const sure: string[] = [];
  (function visit(n: ts.Node, conditional: boolean) {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const tokens = n.text.split(/\s+/).filter(Boolean);
      all.push(...tokens);
      if (!conditional) sure.push(...tokens);
    }
    const branches =
      ts.isConditionalExpression(n) ||
      (ts.isBinaryExpression(n) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(n.operatorToken.kind));
    ts.forEachChild(n, (c) => visit(c, conditional || branches));
  })(init, false);
  return { all, sure };
}

/** `md:!px-0` → `px-0`: the utility with its variants and important flag off. */
const bare = (token: string) => token.slice(token.lastIndexOf(':') + 1).replace(/^!/, '');
const ZERO = /^(p|px|pl|pr|ps|pe)-(0|\[0(px|rem)?\])$/;
const PAD = /^(p|px|pl|pr|ps|pe)-(?!0$|\[0(px|rem)?\]$)\S+$/;

type Field = { where: string; tag: string; all: string[]; sure: string[] };

function fields(): Field[] {
  const out: Field[] = [];
  for (const file of ROOTS.flatMap((r) => walk(r))) {
    const src = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    (function visit(n: ts.Node) {
      if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
        const tag = n.tagName.getText(src);
        if (RAW.has(tag) || WRAPPED.has(tag)) {
          let cls: { all: string[]; sure: string[] } = { all: [], sure: [] };
          let type = '';
          for (const attr of n.attributes.properties) {
            if (!ts.isJsxAttribute(attr) || !attr.initializer) continue;
            const name = attr.name.getText(src);
            if (name === 'className') cls = classTokens(attr.initializer);
            if (name === 'type') type = attr.initializer.getText(src);
          }
          const { line } = src.getLineAndCharacterOfPosition(n.getStart(src));
          const invisible = cls.sure.some((t) => t === 'sr-only' || t === 'hidden');
          if (!NON_TEXT.test(type) && !invisible) {
            out.push({ where: `${file}:${line + 1}`, tag, ...cls });
          }
        }
      }
      ts.forEachChild(n, visit);
    })(src);
  }
  return out;
}

describe('caret room', () => {
  const all = fields();

  it('finds the fields it is guarding', () => {
    // A scan that silently matches nothing would pass forever.
    expect(all.some((f) => f.where.includes('item-dialog.tsx'))).toBe(true);
    expect(all.some((f) => f.where.includes('omnibar.tsx'))).toBe(true);
  });

  it('no text field zeroes its inline padding', () => {
    const zeroed = all.filter((f) => f.all.some((t) => ZERO.test(bare(t)))).map((f) => f.where);
    expect(zeroed).toEqual([]);
  });

  it('every raw input and textarea pads both sides in every state', () => {
    // Unvariant, unconditional tokens only: the caret needs room at BOTH ends
    // (the far end once the text scrolls), whatever state the field is in.
    const padded = (f: Field, side: 'start' | 'end') =>
      f.sure.some((t) => {
        if (t.includes(':') || !PAD.test(t.replace(/^!/, ''))) return false;
        const axis = t.replace(/^!/, '').split('-')[0];
        return (
          axis === 'p' || axis === 'px' || (side === 'start' ? ['pl', 'ps'] : ['pr', 'pe']).includes(axis)
        );
      });
    const unpadded = all
      .filter((f) => RAW.has(f.tag) && !(padded(f, 'start') && padded(f, 'end')))
      .map((f) => f.where);
    expect(unpadded).toEqual([]);
  });
});
