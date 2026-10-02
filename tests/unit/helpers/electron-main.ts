/**
 * Reading electron/ from the root unit suite. CI can't run Electron, so the electron-*.test.ts
 * files hold main.cjs's load-bearing lines as text; these cut that text up.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';

/** A repo file's text, by its path from the repo root. */
export const read = (p: string) => readFileSync(path.resolve(__dirname, '../../..', p), 'utf8');

/** One function's source out of main.cjs, from its declaration to the next top-level one. */
export function fnSource(main: string, name: string) {
  const start = main.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = main.indexOf('\nfunction ', start + 1);
  return main.slice(start, end === -1 ? undefined : end);
}

/** One `contents.on(...)` / `win.on(...)` handler out of main.cjs, up to its closing `});`. */
export function handlerSource(main: string, head: string) {
  const start = main.indexOf(head);
  expect(start, head).toBeGreaterThan(-1);
  return main.slice(start, main.indexOf('\n  });\n', start) + 6);
}
