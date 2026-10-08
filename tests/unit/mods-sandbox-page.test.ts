// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FRAME_SCRIPT_BODY, LOCKDOWN_JS } from '@/lib/mods/sandbox/frame-script.mjs';
import { sandboxCsp } from '@/lib/mods/sandbox/csp.mjs';
import { assembleSandboxPage } from '../../scripts/build-mod-runtime.mjs';

vi.mock('@/lib/mods/sandbox/generated/page', () => ({
  MOD_RUNTIME_VERSION: '0123456789abcdef',
  SANDBOX_CSP: "sandbox allow-scripts; default-src 'none'",
  SANDBOX_PAGE: '<!doctype html><title>sandbox</title>',
}));

const inputs = {
  lockdownJs: LOCKDOWN_JS,
  workerJs: 'self.onmessage = function () {}; // </script><script>alert(1)</script>',
  wasmBytes: Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
  frameScriptBody: FRAME_SCRIPT_BODY,
};
const built = assembleSandboxPage(inputs);

const directives = (csp: string) =>
  Object.fromEntries(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    })
  );

describe('the sandbox CSP', () => {
  const d = directives(built.csp);

  it('sandboxes scripts only, never with the app origin', () => {
    expect(d.sandbox).toEqual(['allow-scripts']);
    expect(built.csp).not.toContain('allow-same-origin');
  });

  it('allows exactly the frame script hash and wasm, no self and no inline', () => {
    expect(d['script-src']).toEqual([expect.stringMatching(/^'sha256-[A-Za-z0-9+/=]+'$/), "'wasm-unsafe-eval'"]);
    expect(built.csp).not.toContain("'self' ");
    expect(built.csp).not.toContain('unsafe-inline');
  });

  it('allows blob workers and nothing on the network', () => {
    expect(d['connect-src']).toEqual(["'none'"]);
    expect(d['default-src']).toEqual(["'none'"]);
    expect(d['worker-src']).toEqual(['blob:']);
    expect(d['child-src']).toEqual(['blob:']);
    expect(d['frame-ancestors']).toEqual(["'self'"]);
  });
});

describe('the sandbox page', () => {
  const scripts = [...built.page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];

  it('has three text/plain blocks of base64 and one script, pinned by its hash', () => {
    expect(scripts.map((s) => s[1].trim())).toEqual([
      'type="text/plain" id="lockdown"',
      'type="text/plain" id="w"',
      'type="text/plain" id="wasm"',
      '',
    ]);
    for (const s of scripts.slice(0, 3)) expect(s[2]).toMatch(/^[A-Za-z0-9+/=]*$/);
    const inline = scripts[3][2];
    expect(inline).toBe(built.frameScript);
    const hash = createHash('sha256').update(inline).digest('base64');
    expect(directives(built.csp)['script-src'][0]).toBe(`'sha256-${hash}'`);
  });

  it('carries the worker text whole, even one that tries to end its block', () => {
    expect(Buffer.from(scripts[1][2], 'base64').toString()).toBe(inputs.workerJs);
    expect(Buffer.from(scripts[0][2], 'base64').toString()).toBe(LOCKDOWN_JS);
  });

  it('puts the version in front of a frame script that holds no <', () => {
    expect(FRAME_SCRIPT_BODY).not.toContain('<');
    expect(built.frameScript).toBe(`const SANDBOX_VERSION='${built.version}';${FRAME_SCRIPT_BODY}`);
    expect(built.frameScript).not.toContain('<');
    expect(built.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives a new version when any input changes', () => {
    const versions = new Set([
      built.version,
      assembleSandboxPage({ ...inputs, frameScriptBody: FRAME_SCRIPT_BODY + ' ' }).version,
      assembleSandboxPage({ ...inputs, lockdownJs: LOCKDOWN_JS + ' ' }).version,
      assembleSandboxPage({ ...inputs, workerJs: inputs.workerJs + ' ' }).version,
      assembleSandboxPage({ ...inputs, wasmBytes: Buffer.from([...inputs.wasmBytes, 0]) }).version,
      assembleSandboxPage({ ...inputs, csp: (h: string) => `${sandboxCsp(h)}; img-src blob:` }).version,
    ]);
    expect(versions.size).toBe(6);
    expect(assembleSandboxPage(inputs).version).toBe(built.version);
  });
});

describe('the sandbox route', () => {
  it('serves only the current version, static, with no X-Frame-Options', async () => {
    const route = await import('@/app/mods/sandbox/[v]/route');
    expect(route.generateStaticParams()).toEqual([{ v: '0123456789abcdef' }]);
    expect(route.dynamicParams).toBe(false);
    expect(route.dynamic).toBe('force-static');
    const res = route.GET();
    expect(await res.text()).toBe('<!doctype html><title>sandbox</title>');
    expect(res.headers.get('content-security-policy')).toBe("sandbox allow-scripts; default-src 'none'");
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBeNull();
  });
});
