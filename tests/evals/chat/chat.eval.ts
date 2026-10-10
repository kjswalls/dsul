// @vitest-environment node

/**
 * Chat evals against real models: `pnpm eval:chat`.
 *
 * Costs money and needs keys, so it is never part of `pnpm test` or CI. Name
 * the models and give each provider a key, in .env.local or the shell:
 *
 *   EVAL_MODELS=openai:gpt-5-mini,anthropic:claude-haiku-4-5,openrouter:qwen/qwen3-32b
 *   EVAL_KEY_OPENAI=…  EVAL_KEY_ANTHROPIC=…  EVAL_KEY_GEMINI=…  EVAL_KEY_OPENROUTER=…
 *   EVAL_KEY_CUSTOM=… with EVAL_BASE_URL_CUSTOM=https://…
 *   EVAL_ONLY=dentist-time,history   (optional: just these cases)
 *
 * Each case is one test per model, so a failure names the model, the ask and
 * what went wrong. A markdown report with every reply and every lookup lands
 * in tests/evals/chat/results/ (gitignored).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { credentialsFor, getAdapter } from '@/lib/ai-server/providers';
import { MODEL_PROVIDERS, type ModelProviderId } from '@/lib/ai-types';
import { CASES } from './cases';
import { grade, type Grade, type Transcript } from './grade';
import { NOW } from './planner';
import { evalSystem, runCase } from './run';

const CASE_TIMEOUT_MS = 120_000;

interface Target {
  provider: ModelProviderId;
  model: string;
}

function targets(): Target[] {
  return (process.env.EVAL_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => {
      const at = spec.indexOf(':');
      const provider = spec.slice(0, at) as ModelProviderId;
      if (at < 1 || !MODEL_PROVIDERS.includes(provider)) {
        throw new Error(`EVAL_MODELS: "${spec}" is not provider:model (providers: ${MODEL_PROVIDERS.join(', ')})`);
      }
      return { provider, model: spec.slice(at + 1) };
    });
}

const only = new Set((process.env.EVAL_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const cases = only.size ? CASES.filter((c) => only.has(c.id)) : CASES;

interface Row {
  target: Target;
  caseId: string;
  ask: string;
  transcript: Transcript | null;
  grade: Grade;
  ms: number;
}
const rows: Row[] = [];

// The snapshot is built once, with only Date frozen and only while it is
// built: the SDKs' own clocks keep running.
let system: string[] = [];
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  try {
    system = evalSystem();
  } finally {
    vi.useRealTimers();
  }
});

const list = targets();
if (list.length === 0) {
  it.skip('set EVAL_MODELS (and a key per provider) to run the chat evals', () => {});
}

for (const target of list) {
  describe(`${target.provider}:${target.model}`, () => {
    const key = process.env[`EVAL_KEY_${target.provider.toUpperCase()}`] ?? '';
    const baseUrl = target.provider === 'custom' ? (process.env.EVAL_BASE_URL_CUSTOM ?? null) : null;

    for (const c of cases) {
      it(c.id, { timeout: CASE_TIMEOUT_MS }, async () => {
        if (!key) throw new Error(`no EVAL_KEY_${target.provider.toUpperCase()}`);
        const started = Date.now();
        let transcript: Transcript | null = null;
        let g: Grade;
        try {
          transcript = await runCase(c, {
            adapter: getAdapter(target.provider),
            creds: credentialsFor(target.provider, baseUrl, key),
            model: target.model,
            system,
            signal: AbortSignal.timeout(CASE_TIMEOUT_MS - 5_000),
          });
          g = grade(c, transcript);
        } catch (err) {
          const kind = (err as { kind?: string } | null)?.kind;
          const msg = err instanceof Error ? err.message : String(err);
          g = { pass: false, failures: [`threw${kind ? ` (${kind})` : ''}: ${msg}`] };
        }
        rows.push({ target, caseId: c.id, ask: c.ask, transcript, grade: g, ms: Date.now() - started });
        expect(g.failures, c.why).toEqual([]);
      });
    }
  });
}

afterAll(() => {
  if (rows.length === 0) return;
  const dir = path.join(__dirname, 'results');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  writeFileSync(file, report(rows));
  console.log(`\nChat eval report: ${path.relative(process.cwd(), file)}\n${summary(rows)}`);
});

function label(t: Target): string {
  return `${t.provider}:${t.model}`;
}

function summary(all: Row[]): string {
  const by = new Map<string, Row[]>();
  for (const r of all) by.set(label(r.target), [...(by.get(label(r.target)) ?? []), r]);
  return [...by]
    .map(([name, rs]) => {
      const passed = rs.filter((r) => r.grade.pass).length;
      const calls = rs.reduce((n, r) => n + (r.transcript?.calls.length ?? 0), 0);
      const secs = rs.reduce((n, r) => n + r.ms, 0) / 1000 / rs.length;
      return `| ${name} | ${passed}/${rs.length} | ${calls} | ${secs.toFixed(1)}s |`;
    })
    .reduce((out, line) => `${out}\n${line}`, '| Model | Passed | Lookups | Avg time |\n| --- | --- | --- | --- |');
}

function report(all: Row[]): string {
  const out = [`# Chat evals, ${new Date().toISOString()}`, '', summary(all), ''];
  for (const r of all) {
    out.push(`## ${r.grade.pass ? '✓' : '✗'} ${label(r.target)} · ${r.caseId}`, '', `> ${r.ask}`, '');
    for (const f of r.grade.failures) out.push(`- **${f}**`);
    if (r.transcript) {
      for (const c of r.transcript.calls) out.push(`- \`${c.name}(${JSON.stringify(c.args)})\``);
      out.push('', r.transcript.reply.trim() || '_(empty)_');
    }
    out.push('');
  }
  return out.join('\n');
}
