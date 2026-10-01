// Rasterises the Wave mark (mark.mjs) into the icon files. Chromium does the drawing because the
// halos use mix-blend-mode: plus-lighter, which other SVG renderers ignore.
//
//   node scripts/app-icon/build.mjs                  → public/icons/* and public/favicon.ico
//   node scripts/app-icon/build.mjs --native <dir>   → also iOS, macOS, Android and Windows files
// Run from the repo root.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { waveSVG } from './mark.mjs';

const nativeAt = process.argv.indexOf('--native');
const nativeDir = nativeAt > -1 ? process.argv[nativeAt + 1] : null;

// CHROMIUM_PATH points at a Chromium other than Playwright's own download, if you need one.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function png(svg, size, { pad = 0, shadow = false } = {}) {
  const canvas = size + 2 * pad;
  await page.setViewportSize({ width: canvas, height: canvas });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}#c{width:${canvas}px;height:${canvas}px;display:grid;place-items:center}` +
      `svg{display:block${shadow ? `;filter:drop-shadow(0 ${canvas * 0.01}px ${canvas * 0.012}px rgb(0 0 0 / .3))` : ''}}</style><div id="c">${svg}</div>`,
  );
  return page.locator('#c').screenshot({ omitBackground: true, type: 'png' });
}
function write(path, buf) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
}
// An .ico that embeds PNGs (Windows Vista and later, every browser).
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}
async function icoOf(sizes) {
  const images = [];
  for (const size of sizes) images.push({ size, data: await png(waveSVG(size), size) });
  return ico(images);
}

// ── Web app ───────────────────────────────────────────────────────────────────
const pub = 'public/icons';
for (const s of [16, 32]) {
  write(`${pub}/icon-${s}.png`, await png(waveSVG(s), s));
  write(`${pub}/icon-${s}-light.png`, await png(waveSVG(s, { theme: 'light' }), s));
}
// iOS home screen: a full-bleed square the phone rounds itself.
write(`${pub}/icon-180.png`, await png(waveSVG(180, { ground: 'square' }), 180));
// Maskable (Android and desktop installs): the dots and their outer squares stay inside the 80%
// safe circle. (The 1024 store masters go to --native, not public/: the service worker
// precaches everything in public/.)
for (const s of [192, 512]) write(`${pub}/icon-${s}.png`, await png(waveSVG(s, { ground: 'square', span: 0.52 }), s));
write('public/favicon.ico', await icoOf([16, 32, 48]));

// ── Native apps ───────────────────────────────────────────────────────────────
if (nativeDir) {
  const out = (p) => join(nativeDir, p);
  // iOS 18+: light (the default), dark and tinted, each a 1024 full-bleed square.
  write(out('ios/AppIcon-1024-light.png'), await png(waveSVG(1024, { ground: 'square', theme: 'light' }), 1024));
  write(out('ios/AppIcon-1024-dark.png'), await png(waveSVG(1024, { ground: 'square' }), 1024));
  {
    const tinted = waveSVG(1024, { theme: 'mono' }).replace('<defs>', '<rect width="1024" height="1024" fill="black"/><defs>');
    write(out('ios/AppIcon-1024-tinted.png'), await png(tinted, 1024));
  }
  // macOS: Apple's grid puts an 824px rounded tile inside the 1024 canvas, with a shadow.
  const macSizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const theme of ['dark', 'light']) {
    for (const s of macSizes) {
      const body = Math.round((s * 824) / 1024);
      const buf = await png(waveSVG(body, { theme }), body, { pad: (s - body) / 2, shadow: s >= 64 });
      const name = { 16: ['16x16'], 32: ['16x16@2x', '32x32'], 64: ['32x32@2x'], 128: ['128x128'], 256: ['128x128@2x', '256x256'], 512: ['256x256@2x', '512x512'], 1024: ['512x512@2x'] }[s];
      for (const n of name) write(out(`macos/AppIcon-${theme}.iconset/icon_${n}.png`), buf);
    }
  }
  // Android adaptive icon: 108dp layers at 4× (432px). The launcher shows the middle 72dp and
  // keeps the middle 66dp safe, so the dots span 0.4 of the layer.
  write(out('android/ic_launcher_foreground.png'), await png(waveSVG(432, { ground: 'none', span: 0.4 }), 432));
  write(out('android/ic_launcher_monochrome.png'), await png(waveSVG(432, { theme: 'mono', span: 0.4 }), 432));
  for (const [d, s] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
    write(out(`android/mipmap-${d}/ic_launcher.png`), await png(waveSVG(s), s));
  }
  write(out('android/play-store-512.png'), await png(waveSVG(512, { ground: 'square' }), 512));
  // Windows and desktop (Electron, Tauri): one .ico with every size the shell asks for.
  write(out('windows/icon.ico'), await icoOf([16, 24, 32, 48, 64, 128, 256]));
  // Vector masters.
  write(out('svg/wave-dark.svg'), waveSVG(1024, { ground: 'square' }));
  write(out('svg/wave-light.svg'), waveSVG(1024, { ground: 'square', theme: 'light' }));
  write(out('svg/wave-16.svg'), waveSVG(16));
  write(out('svg/wave-32.svg'), waveSVG(32));
}

await browser.close();
