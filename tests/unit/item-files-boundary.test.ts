// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Agents may WRITE a file onto an item and never read one (migration 081,
 * memory/plans/ai-vision.md "files in the timeline"). Held by a source scan of
 * everything an agent or a model reads through: the agent API, the chat route,
 * MCP and lib/ai-server. Only the one write route and its server half may name
 * the item_files table or import the item-files modules.
 */

const ROOT = path.resolve(__dirname, '../..');
const SCANNED = ['app/api/agent', 'app/api/chat', 'app/api/mcp', 'lib/mcp', 'lib/agent-api.ts', 'lib/ai-server'];
const ALLOWED = new Set(['app/api/agent/items/[id]/files/route.ts', 'lib/item-files-server.ts']);
const SOURCE_EXT = /\.(ts|tsx|js|mjs)$/;

function walk(p: string, out: string[] = []): string[] {
  let stat;
  try {
    stat = statSync(p);
  } catch {
    return out;
  }
  if (stat.isFile()) {
    if (SOURCE_EXT.test(p)) out.push(p);
    return out;
  }
  for (const name of readdirSync(p)) walk(path.join(p, name), out);
  return out;
}

const files = SCANNED.flatMap((d) => walk(path.join(ROOT, d))).map((f) =>
  path.relative(ROOT, f).split(path.sep).join('/')
);
const TABLE = /['"`]item_files['"`]/;
const IMPORT = /from\s+['"][^'"]*item-files[^'"]*['"]|import\(\s*['"][^'"]*item-files[^'"]*['"]\s*\)/;

describe('no agent or model reads a file', () => {
  it('scans something', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('app/api/agent/items/[id]/files/route.ts');
  });

  it.each(files.filter((f) => !ALLOWED.has(f)))(
    '%s names no item_files table and imports no item-files module',
    (f) => {
      const src = readFileSync(path.join(ROOT, f), 'utf8');
      expect(src).not.toMatch(TABLE);
      expect(src).not.toMatch(IMPORT);
    }
  );

  it('the item events route never selects from item_files', () => {
    const src = readFileSync(path.join(ROOT, 'app/api/agent/items/[id]/events/route.ts'), 'utf8');
    expect(src).not.toMatch(/item_files/);
  });

  it('the write route answers with the one file it wrote, never a listing', () => {
    // Its code, not its header (which says it writes no event).
    const src = readFileSync(path.join(ROOT, 'app/api/agent/items/[id]/files/route.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/listItemFiles|fileLink|thumbLinks|createSignedUrl/);
    expect(src).not.toMatch(/item_events/);
  });
});
