// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * "Write with AI" lines (memory/plans/mods.md, "AI writes it"):
 *   - drafts are never parsed out of chat replies: nothing that draws or sends
 *     chat imports the draft checker or the Make call;
 *   - the context the model sees is built from three name tables only, never
 *     items, notes or saved conversations;
 *   - the Make call is the one fetch of lib/make-ai.ts, and only Make's own
 *     Write box imports it.
 */

const ROOT = path.resolve(__dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');
const read = (r: string) => readFileSync(path.join(ROOT, r), 'utf8');
const FILES = ['app', 'lib', 'components', 'hooks'].flatMap((d) => walk(path.join(ROOT, d))).map(rel);

const importsOf = (text: string) =>
  [...text.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
const names = (spec: string, mod: string) => spec === `@/lib/${mod}` || spec.endsWith(`/${mod}`);

describe('Write with AI boundaries', () => {
  it('chat never imports the draft checker or the Make call', () => {
    const chat = FILES.filter(
      (f) =>
        f.startsWith('components/ai/') ||
        ['lib/open-chat.ts', 'lib/conversations-store.ts', 'lib/chat-transport.ts', 'app/api/chat/route.ts'].includes(f)
    );
    expect(chat.length).toBeGreaterThan(10);
    const offenders = chat.flatMap((f) =>
      importsOf(read(f))
        .filter((s) => names(s, 'make-draft') || names(s, 'make-ai'))
        .map((s) => `${f} → ${s}`)
    );
    expect(offenders).toEqual([]);
  });

  it('only the Write box calls the Make route', () => {
    const callers = FILES.filter((f) => importsOf(read(f)).some((s) => names(s, 'make-ai')));
    expect(callers).toEqual(['components/settings/make-write.tsx']);
    const routeUsers = FILES.filter((f) => read(f).includes("'/api/ai/make'"));
    expect(routeUsers).toEqual(['lib/make-ai.ts']);
    expect(read('lib/make-ai.ts').match(/\bfetch\(/g)).toHaveLength(1);
  });

  it('the model context names three tables, and never items, notes or conversations', () => {
    const text = read('lib/ai-server/make-context.ts');
    const tables = [...text.matchAll(/\.from\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort();
    expect(tables).toEqual(['item_types', 'projects', 'user_mods']);
    expect(text).not.toMatch(/['"]items['"]/);
    expect(text).not.toMatch(/notes/);
    expect(text).not.toMatch(/chat_/);
    expect(text).not.toMatch(/createServiceClient|supabase-service/);
  });

  it('the route reads only kind and ask from the body', () => {
    const route = read('app/api/ai/make/route.ts');
    const reads = [...route.matchAll(/\bbody\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(reads)].sort()).toEqual(['ask', 'kind']);
    expect(route).not.toMatch(/appendInstructions|customInstructions\s*[),]/);
  });
});
