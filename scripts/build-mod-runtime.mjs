#!/usr/bin/env node
/**
 * Builds the mod sandbox (memory/plans/mods.md, build order 8): the worker
 * bundle, the wasm, and the one self-contained frame page served at
 * /mods/sandbox/<version> (app/mods/sandbox/[v]/route.ts).
 *
 *   node scripts/build-mod-runtime.mjs
 *
 * Runs from "postinstall" and "prebuild", and writes only
 * lib/mods/sandbox/generated/ (gitignored), and only the files whose content
 * changed:
 *   worker.ts   WORKER_JS_B64, lib/mods/runtime/worker-entry.ts as one script
 *   wasm.ts     WASM_B64, QuickJS's release-sync emscripten-module.wasm
 *   page.ts     SANDBOX_PAGE, SANDBOX_CSP, MOD_RUNTIME_VERSION
 *   version.ts  MOD_RUNTIME_VERSION alone, for the client (no 700KB page)
 *
 * The worker is bundled with Next's vendored webpack and a loader around
 * Next's swc binding (./mod-runtime-swc-loader.mjs): no bundler of its own.
 * Every non-default webpack setting below is load-bearing:
 * - minimize:false. The vendored default minimizer needs a terser plugin path
 *   Next 16.1.6 no longer ships, so the build throws MODULE_NOT_FOUND.
 * - url:false, publicPath:'', chunkLoading:false, wasmLoading:false. Without
 *   them webpack emits the glue's `new URL('emscripten-module.wasm',
 *   import.meta.url)` as an asset, and adds the auto-publicPath runtime,
 *   which reads importScripts; LOCKDOWN deletes that, so the worker would
 *   throw at startup.
 * - dynamicImportMode:'eager' inlines QuickJS's own import() calls.
 *
 * The page's version hashes every input (the frame script, LOCKDOWN, the CSP
 * template, the worker and the wasm), so any change is a new path and a page
 * cached as immutable is never the wrong one.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sandboxCsp } from '../lib/mods/sandbox/csp.mjs';
import { FRAME_SCRIPT_BODY, LOCKDOWN_JS } from '../lib/mods/sandbox/frame-script.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO, 'lib/mods/sandbox/generated');
const ENTRY = path.join(REPO, 'lib/mods/runtime/worker-entry.ts');
const LOADER = path.join(REPO, 'scripts/mod-runtime-swc-loader.mjs');

const require = createRequire(import.meta.url);

const b64 = (data) => Buffer.from(data).toString('base64');
const sha256 = (s) => createHash('sha256').update(s);

/**
 * The frame page from its inputs. Pure, and exported for
 * tests/unit/mods-sandbox-page.test.ts.
 *
 * Every block is base64, so nothing inside one can end it early; the
 * text/plain blocks never run, so only the frame script needs a hash. The
 * CSP template's hash slot is a fixed placeholder when the version is
 * computed, so nothing is circular.
 */
export function assembleSandboxPage({ lockdownJs, workerJs, wasmBytes, frameScriptBody, csp = sandboxCsp }) {
  const blocks = { lockdown: b64(lockdownJs), w: b64(workerJs), wasm: b64(wasmBytes) };
  const version = sha256([blocks.lockdown, blocks.w, blocks.wasm, frameScriptBody, csp('<hash>')].join('\n'))
    .digest('hex')
    .slice(0, 16);
  const frameScript = `const SANDBOX_VERSION='${version}';` + frameScriptBody;
  const policy = csp(sha256(frameScript).digest('base64'));
  const page = `<!doctype html><meta charset="utf-8"><title>sandbox</title>
<script type="text/plain" id="lockdown">${blocks.lockdown}</script>
<script type="text/plain" id="w">${blocks.w}</script>
<script type="text/plain" id="wasm">${blocks.wasm}</script>
<script>${frameScript}</script>`;
  return { page, csp: policy, version, frameScript };
}

/**
 * What must never be in the worker bundle. Comments are stripped first, so
 * webpack's own `/* import() eager *\/` markers do not count. Exported for
 * tests/unit/mods-runtime-bundle.test.ts, which runs it on the generated file.
 */
export function workerBundleProblems(js) {
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const forbidden = [
    ['importScripts', /\bimportScripts\b/],
    ['__webpack_require__.e', /__webpack_require__\.e\b/],
    ['__webpack_require__.p', /__webpack_require__\.p\b/],
    ['import(', /(^|[^\w$.])import\s*\(/],
    ['zustand', /zustand/],
    ['@supabase', /@supabase/],
    ['createClient', /createClient/],
  ];
  return forbidden.filter(([, re]) => re.test(code)).map(([name]) => name);
}

async function bundleWorker() {
  const webpack = require('next/dist/compiled/webpack/webpack');
  // Older Next exported init() to pick webpack 4 or 5; 16.1.6 has only the getter.
  webpack.init?.();
  const wp = webpack.webpack;
  const out = mkdtempSync(path.join(tmpdir(), 'dsul-mod-runtime-'));
  try {
    const stats = await new Promise((resolve, reject) => {
      wp(
        {
          mode: 'production',
          target: 'webworker',
          devtool: false,
          context: REPO,
          entry: ENTRY,
          output: { path: out, filename: 'worker.js', iife: true, publicPath: '', chunkLoading: false, wasmLoading: false },
          resolve: { extensions: ['.ts', '.mjs', '.js'], alias: { '@': REPO }, conditionNames: ['browser', 'import', 'default'] },
          module: {
            parser: { javascript: { dynamicImportMode: 'eager', url: false } },
            rules: [{ test: /\.ts$/, loader: LOADER }],
          },
          optimization: { splitChunks: false, runtimeChunk: false, moduleIds: 'deterministic', minimize: false },
          plugins: [new wp.DefinePlugin({ 'import.meta.url': '"https://dsul.invalid/"' })],
        },
        (err, result) => (err ? reject(err) : resolve(result))
      );
    });
    if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
    const emitted = readdirSync(out);
    if (emitted.length !== 1 || emitted[0] !== 'worker.js') {
      throw new Error(`the worker build emitted more than worker.js: ${emitted.join(', ')}`);
    }
    const js = readFileSync(path.join(out, 'worker.js'), 'utf8');
    const problems = workerBundleProblems(js);
    if (problems.length) throw new Error(`the worker bundle contains ${problems.join(', ')}`);
    return js;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function readWasm() {
  // Through quickjs-emscripten, which is the dependency; the variant is its own.
  const umbrella = createRequire(require.resolve('quickjs-emscripten'));
  return readFileSync(umbrella.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'));
}

function writeIfChanged(name, content) {
  const file = path.join(OUT_DIR, name);
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return false;
  writeFileSync(file, content);
  return true;
}

const HEADER = '// Generated by scripts/build-mod-runtime.mjs. Do not edit; gitignored.\n';

async function main() {
  const workerJs = await bundleWorker();
  const wasmBytes = readWasm();
  const { page, csp, version } = assembleSandboxPage({
    lockdownJs: LOCKDOWN_JS,
    workerJs,
    wasmBytes,
    frameScriptBody: FRAME_SCRIPT_BODY,
  });
  mkdirSync(OUT_DIR, { recursive: true });
  const changed = [
    writeIfChanged('worker.ts', `${HEADER}export const WORKER_JS_B64 = ${JSON.stringify(b64(workerJs))};\n`),
    writeIfChanged('wasm.ts', `${HEADER}export const WASM_B64 = ${JSON.stringify(b64(wasmBytes))};\n`),
    writeIfChanged(
      'page.ts',
      `${HEADER}export const MOD_RUNTIME_VERSION = ${JSON.stringify(version)};\n` +
        `export const SANDBOX_CSP = ${JSON.stringify(csp)};\n` +
        `export const SANDBOX_PAGE = ${JSON.stringify(page)};\n`
    ),
    writeIfChanged('version.ts', `${HEADER}export const MOD_RUNTIME_VERSION = ${JSON.stringify(version)};\n`),
  ].some(Boolean);
  console.log(
    `mod runtime ${version}: worker ${Math.round(workerJs.length / 1024)}KB, wasm ${Math.round(wasmBytes.length / 1024)}KB, page ${Math.round(page.length / 1024)}KB${changed ? '' : ' (unchanged)'}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error('build-mod-runtime failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
