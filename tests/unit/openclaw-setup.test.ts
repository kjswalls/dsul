// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPENCLAW_WORK_BRIEF, openClawSetup } from '@/lib/openclaw-setup';

/**
 * The commands Settings → AI → OpenClaw → Connect shows (lib/openclaw-setup.ts).
 * They are pasted into a real shell, so they are run through one here, against
 * a stand-in `openclaw` that records the argv it was given.
 */

const KEY = "dsul_ak_it's-a-key_with-quote";

function runScript(origin: string, key: string) {
  const home = mkdtempSync(join(tmpdir(), 'oc-setup-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const log = join(home, 'calls.jsonl');
  writeFileSync(
    join(bin, 'openclaw'),
    `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`
  );
  chmodSync(join(bin, 'openclaw'), 0o755);
  execFileSync('/bin/sh', ['-c', openClawSetup(origin, key).script], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
  });
  const calls = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as string[]);
  return { home, calls };
}

describe('openClawSetup', () => {
  it('has three steps, each with a label', () => {
    const { steps } = openClawSetup('https://do.dsul.app', KEY);
    expect(steps.map((s) => s.label)).toEqual([
      'Save the key where only you can read it',
      "Give OpenClaw dsul's tools",
      'Let dsul tell it when there is work',
    ]);
  });

  it('saves the key, unreadable to anyone else, and never spells it out after that', () => {
    const { home } = runScript('https://do.dsul.app', KEY);
    const file = join(home, '.openclaw', 'dsul.key');
    expect(readFileSync(file, 'utf8')).toBe(KEY);
    expect(statSync(file).mode & 0o077).toBe(0);
    const { steps } = openClawSetup('https://do.dsul.app', KEY);
    expect(steps.slice(1).some((s) => s.command.includes(KEY))).toBe(false);
  });

  it("adds dsul's MCP server with the key as a bearer, after removing any earlier one", () => {
    const { calls } = runScript('https://do.dsul.app/', KEY);
    expect(calls[0]).toEqual(['mcp', 'unset', 'dsul']);
    expect(calls[1]).toEqual([
      'mcp', 'add', 'dsul',
      '--url', 'https://do.dsul.app/api/mcp',
      '--transport', 'streamable-http',
      '--header', `Authorization=Bearer ${KEY}`,
    ]);
  });

  it('adds one listening automation, which a later Connect replaces rather than doubles', () => {
    const { calls } = runScript('https://do.dsul.app', KEY);
    const add = calls[2];
    expect(add.slice(0, 2)).toEqual(['automations', 'add']);
    const flag = (name: string) => add[add.indexOf(name) + 1];
    expect(flag('--name')).toBe('dsul');
    expect(flag('--declaration-key')).toBe('dsul');
    expect(flag('--stream-mode')).toBe('match');
    expect(flag('--stream-match')).toBe('^data: work');
    expect(flag('--session')).toBe('isolated');
    expect(flag('--message')).toBe(OPENCLAW_WORK_BRIEF);

    const argv = JSON.parse(flag('--stream-command')) as string[];
    expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
    // The key is read from its file when the loop runs, never written into the job.
    expect(argv[2]).toContain('$(cat ~/.openclaw/dsul.key)');
    expect(argv[2]).not.toContain(KEY);
    expect(argv[2]).toContain('https://do.dsul.app/api/agent/events');
    expect(argv[2]).toMatch(/^while :; do curl -sN .*; sleep 5; done$/);
  });

  it('the listening loop itself parses as a shell command', () => {
    const { calls } = runScript('https://do.dsul.app', KEY);
    const add = calls[2];
    const argv = JSON.parse(add[add.indexOf('--stream-command') + 1]) as string[];
    expect(() => execFileSync('/bin/sh', ['-n', '-c', argv[2]])).not.toThrow();
  });

  it('tells the agent to work its queue through MCP, and to do nothing when nothing is new', () => {
    expect(OPENCLAW_WORK_BRIEF).toContain('dsul_my_work');
    expect(OPENCLAW_WORK_BRIEF).toContain('dsul_report_progress');
    expect(OPENCLAW_WORK_BRIEF).toContain('dsul_ask_user');
    expect(OPENCLAW_WORK_BRIEF).toContain('do nothing');
  });
});
