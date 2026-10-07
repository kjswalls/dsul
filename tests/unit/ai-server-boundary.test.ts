// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * The server/client line for the model connection, held by a source scan of
 * app/, lib/, components/ and hooks/.
 *
 *   - dsul has no key of its own: the app-key variable is named nowhere in the
 *     source, comments included (the env-sentinel tests live under tests/,
 *     outside this scan). The strict form is on purpose: a comment naming it is
 *     how a read of it comes back.
 *   - The SDKs and lib/ai-server (keys, ciphertext, provider calls) are
 *     imported only from app/api/** and lib/ai-server/**, so none of it can
 *     reach a browser bundle.
 *   - The client-safe AI modules import no Node builtin.
 *   - The encryption key is never a NEXT_PUBLIC_ variable.
 */

const ROOT = path.resolve(__dirname, '../..');
const SCANNED = ['app', 'lib', 'components', 'hooks'];
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

const FILES = SCANNED.flatMap((d) => walk(path.join(ROOT, d))).map((abs) => ({
  rel: path.relative(ROOT, abs).split(path.sep).join('/'),
  text: readFileSync(abs, 'utf8'),
}));

/** Every module specifier a file imports, re-exports, requires or dynamically imports. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
}

/** `@/lib/ai-server`, a relative path into it, or a file inside lib/ reaching it by `./ai-server`. */
function reachesAiServer(spec: string, fromRel: string): boolean {
  if (spec === '@/lib/ai-server' || spec.startsWith('@/lib/ai-server/')) return true;
  if (!spec.startsWith('.')) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  return resolved === 'lib/ai-server' || resolved.startsWith('lib/ai-server/');
}
const isSdk = (spec: string) =>
  spec === 'openai' || spec.startsWith('openai/') || spec === '@anthropic-ai/sdk' || spec.startsWith('@anthropic-ai/sdk/');
const serverSide = (rel: string) => rel.startsWith('app/api/') || rel.startsWith('lib/ai-server/');

describe('the AI server boundary', () => {
  it('scans a real tree', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((f) => f.rel === 'app/api/chat/route.ts')).toBe(true);
    expect(FILES.some((f) => f.rel.startsWith('lib/ai-server/'))).toBe(true);
  });

  it('names the app-key variable nowhere, comments included', () => {
    const NAME = ['OPENAI', 'API', 'KEY'].join('_');
    const hits = FILES.filter((f) => f.text.includes(NAME)).map((f) => f.rel);
    expect(hits).toEqual([]);
  });

  it('imports lib/ai-server and the provider SDKs only from app/api/** and lib/ai-server/**', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      if (serverSide(f.rel)) continue;
      for (const spec of specifiers(f.text)) {
        if (reachesAiServer(spec, f.rel) || isSdk(spec)) offenders.push(`${f.rel} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scan sees a server-side import when there is one (guards the regexes)', () => {
    const route = FILES.find((f) => f.rel === 'app/api/ai/connection/route.ts');
    expect(route).toBeDefined();
    expect(specifiers(route!.text).some((s) => reachesAiServer(s, route!.rel))).toBe(true);
    expect(reachesAiServer('./ai-server/secret-box', 'lib/foo.ts')).toBe(true);
    expect(reachesAiServer('../lib/ai-server', 'app/page.tsx')).toBe(true);
    expect(reachesAiServer('./ai-types', 'lib/foo.ts')).toBe(false);
    expect(isSdk('openai')).toBe(true);
    expect(isSdk('@anthropic-ai/sdk/resources')).toBe(true);
    expect(specifiers("import type { X } from 'openai';\nconst m = await import(\"@anthropic-ai/sdk\");")).toEqual([
      'openai',
      '@anthropic-ai/sdk',
    ]);
  });

  it.each([
    'lib/ai-types.ts',
    'lib/ai-registry.ts',
    'lib/ai-connection-store.ts',
    'lib/chat-target.ts',
    'lib/open-chat.ts',
    'lib/conversation-types.ts',
    'lib/conversations-store.ts',
    'lib/conversations-api.ts',
    'lib/chat-transport.ts',
    'lib/chat-errors.ts',
    'lib/conversation-summary.ts',
    'lib/rail-store.ts',
    'lib/plan-prompt.ts',
    'lib/ask-home.ts',
    'lib/agent-question.ts',
    'lib/make-ai.ts',
    'lib/make-draft.ts',
    'lib/json-extract.ts',
    'lib/recipes/describe.ts',
    'lib/ai-key-prefix.ts',
    'lib/ai-model-names.ts',
    'lib/connect-flow.ts',
    'lib/connect-return.ts',
    'lib/format-chat-timestamp.ts',
  ])('%s is client-safe: no Node builtin, no server module', (rel) => {
    const file = FILES.find((f) => f.rel === rel);
    expect(file, `${rel} exists`).toBeDefined();
    const builtins = new Set(builtinModules);
    const bad = specifiers(file!.text).filter(
      (s) => s.startsWith('node:') || builtins.has(s) || reachesAiServer(s, rel) || isSdk(s)
    );
    expect(bad).toEqual([]);
  });

  it('never exposes the encryption key as a NEXT_PUBLIC_ variable', () => {
    const hits = FILES.filter((f) => /NEXT_PUBLIC_\w*MODEL_KEYS/.test(f.text)).map((f) => f.rel);
    expect(hits).toEqual([]);
  });
});
