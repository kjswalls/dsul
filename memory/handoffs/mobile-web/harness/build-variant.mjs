// Bundles the REAL DesktopShell / MobileShell from SRC, with any file under OVR standing in for
// the repo file at the same path, into OUT, for Chromium. Each build gets a root of its own, so
// builds can run side by side.
//
//   OVR=<dir mirroring repo paths, e.g. OVR/components/primitives/display-shelf.tsx>
//   OUT=<dir name, created under this harness dir>   [SRC=<repo root>, default /home/claude/dsul]
//   node build-variant.mjs
//
// Only `@/…` imports are redirected (every mount imports the shelf that way); a relative import
// inside a repo file still reaches the repo's copy. Tailwind scans OVR too, so new classes work.
import { build } from '/home/claude/dsul/node_modules/.pnpm/vite@8.0.3_@emnapi+core@1.10.0_@emnapi+runtime@1.10.0_@types+node@22.19.15_jiti@2.6.1_yaml@2.8.3/node_modules/vite/dist/node/index.js';
import react from '/home/claude/dsul/node_modules/@vitejs/plugin-react/dist/index.js';
import tailwind from '/home/claude/dsul/node_modules/@tailwindcss/postcss/dist/index.js';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(new URL(import.meta.url).pathname);
const SRC = process.env.SRC ?? '/home/claude/dsul';
const OVR = process.env.OVR ? path.resolve(process.env.OVR) : null;
if (!process.env.OUT) throw new Error('OUT is required');
const OUT = path.join(here, process.env.OUT);
const root = path.join(here, '.roots', path.basename(OUT));
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
for (const f of ['index.html', 'entry.tsx']) fs.copyFileSync(path.join(here, f), path.join(root, f));
fs.writeFileSync(
  path.join(root, 'styles.css'),
  `@import '${SRC}/app/globals.css';\n` + (OVR ? `@source '${OVR}';\n` : '') + (process.env.EXTRA ? fs.readFileSync(process.env.EXTRA,'utf8') : '')
);

const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
  );
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ovrAliases = OVR
  ? walk(OVR)
      .filter((f) => /\.(tsx?|css)$/.test(f))
      .map((f) => {
        const rel = path.relative(OVR, f).replace(/\.tsx?$/, '');
        return { find: new RegExp('^@/' + esc(rel) + '$'), replacement: f };
      })
  : [];
if (ovrAliases.length) console.log('overrides:', ovrAliases.map((a) => path.relative(OVR, a.replacement)).join(', '));

await build({
  root,
  base: './',
  mode: 'production',
  logLevel: 'warn',
  configFile: false,
  plugins: [react()],
  css: { postcss: { plugins: [tailwind({ base: SRC })] } },
  resolve: {
    alias: [
      { find: 'next/navigation', replacement: path.join(here, 'stubs/next-navigation.ts') },
      { find: 'next/font/google', replacement: path.join(here, 'stubs/next-font-google.ts') },
      { find: 'next/link', replacement: path.join(here, 'stubs/next-link.tsx') },
      { find: 'next-themes', replacement: path.join(here, 'stubs/next-themes.tsx') },
      { find: /^@\/lib\/supabase$/, replacement: path.join(here, 'stubs/supabase.ts') },
      { find: /^@\/preview\//, replacement: here + '/' },
      ...ovrAliases,
      { find: /^@\//, replacement: SRC + '/' },
      { find: /^@dsul\/types$/, replacement: path.join(SRC, 'packages/types/dist/index.js') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: { outDir: OUT, emptyOutDir: true, minify: false, sourcemap: false, target: 'es2022' },
});
fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true });
for (const f of ['inter-latin.woff2', 'inter-latin-ext.woff2']) fs.copyFileSync(path.join(here, f), path.join(OUT, 'fonts', f));
console.log('built', SRC, OVR ? `+ ${OVR}` : '', '->', OUT);
