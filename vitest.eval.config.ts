import { readFileSync } from 'fs';
import path from 'path';
import { parseEnv } from 'util';
import { defineConfig } from 'vitest/config';

/**
 * `pnpm eval:chat`: the chat evals against real models (tests/evals/). Kept
 * out of `pnpm test` and CI because every run spends the caller's own keys.
 * EVAL_* variables come from the shell or .env.local, and nothing else in
 * .env.local is read.
 */
function evalEnv(): Record<string, string> {
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFileSync(path.resolve(__dirname, '.env.local'), 'utf8'));
  } catch {
    // No .env.local: the shell's EVAL_* variables are all there is.
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...file, ...process.env })) {
    if (k.startsWith('EVAL_') && v !== undefined) out[k] = v;
  }
  return out;
}

export default defineConfig({
  test: {
    include: ['tests/evals/**/*.eval.ts'],
    environment: 'node',
    globals: true,
    env: evalEnv(),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
