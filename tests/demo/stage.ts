import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, type Locator, type Page } from '@playwright/test';

/**
 * Stagecraft for the demo reel (playwright.demo.config.ts).
 *
 * Playwright's video has no mouse pointer, so a viewer can't follow a click.
 * `test` here draws one, moves it the way a hand would, and when the beat ends
 * saves the clip to demo-reel/. With ffmpeg on the PATH the clip is an .mp4
 * that starts where the beat called `roll()`, so the dev server's first
 * compile and the blank page before it never make the cut; without ffmpeg it is
 * the whole .webm.
 */

export const REEL_DIR = 'demo-reel';

/** A drawn pointer that follows the real one and dips on press. */
function drawPointer() {
  const make = () => {
    if (document.getElementById('demo-pointer')) return;
    // Next's dev badge and "Compiling" toast are not part of the app.
    const hide = document.createElement('style');
    hide.textContent = 'nextjs-portal { display: none !important; }';
    document.head.appendChild(hide);
    const dot = document.createElement('div');
    dot.id = 'demo-pointer';
    Object.assign(dot.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '22px',
      height: '22px',
      margin: '-11px 0 0 -11px',
      borderRadius: '50%',
      background: 'rgba(255,255,255,0.85)',
      border: '2px solid rgba(20,20,20,0.85)',
      boxShadow: '0 1px 6px rgba(0,0,0,0.35)',
      pointerEvents: 'none',
      zIndex: '2147483647',
      transition: 'transform 120ms ease-out',
      transform: 'translate(-100px,-100px)',
    } as CSSStyleDeclaration);
    document.documentElement.appendChild(dot);
    let x = -100;
    let y = -100;
    let scale = 1;
    const paint = () => (dot.style.transform = `translate(${x}px,${y}px) scale(${scale})`);
    window.addEventListener('mousemove', (e) => ((x = e.clientX), (y = e.clientY), paint()), true);
    window.addEventListener('mousedown', () => ((scale = 0.7), paint()), true);
    window.addEventListener('mouseup', () => ((scale = 1), paint()), true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', make);
  else make();
}

/** Keycaps print ⌘, not Ctrl, on camera (lib/commands/keys.ts reads the platform). */
function actLikeAMac() {
  Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
}

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const bornAt = new WeakMap<Page, number>();
const rolledAt = new WeakMap<Page, number>();

/** Call when the shot is ready: the saved clip starts here. */
export function roll(page: Page): void {
  if (!rolledAt.has(page)) rolledAt.set(page, Date.now());
}

function hasFfmpeg(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

export const test = base.extend({
  page: async ({ page }, provide, testInfo) => {
    bornAt.set(page, Date.now());
    await page.addInitScript(actLikeAMac);
    await page.addInitScript(drawPointer);
    // Start the pointer somewhere on screen rather than in the corner.
    await page.mouse.move(760, 430);
    await provide(page);
    const video = page.video();
    await page.close();
    if (!video) return;
    mkdirSync(REEL_DIR, { recursive: true });
    const name = slug(testInfo.title);
    if (!hasFfmpeg()) {
      await video.saveAs(join(REEL_DIR, `${name}.webm`));
      return;
    }
    const raw = testInfo.outputPath('raw.webm');
    await video.saveAs(raw);
    // A little lead-in before the roll, so the first frame isn't mid-motion.
    const from = Math.max(0, ((rolledAt.get(page) ?? 0) - (bornAt.get(page) ?? 0)) / 1000 - 0.5);
    // -ss after -i: a webm from Playwright has sparse keyframes, so seek by decoding.
    const args = ['-y', '-loglevel', 'error', '-i', raw, '-ss', from.toFixed(2)];
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-an', join(REEL_DIR, `${name}.mp4`));
    const out = spawnSync('ffmpeg', args, { stdio: 'inherit' });
    if (out.status !== 0) await video.saveAs(join(REEL_DIR, `${name}.webm`));
  },
});

export { expect } from '@playwright/test';

/**
 * A close-up: the page drawn `factor` times larger, from its first paint. The
 * clip can't be scaled up afterwards without going soft (it is recorded at the
 * viewport's CSS pixels), so a small subject is enlarged in the page instead.
 * For a simple, centred page like sign-in; the planner's own layout reads its
 * width and would rearrange.
 */
export async function closeUp(page: Page, factor: number): Promise<void> {
  await page.addInitScript((z) => {
    const apply = () => (document.documentElement.style.zoom = String(z));
    if (document.documentElement) apply();
    document.addEventListener('DOMContentLoaded', apply);
  }, factor);
}

/** Scroll a close-up so `target` sits mid-frame. */
export async function centre(target: Locator): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
}

/** Let a moment land on camera. */
export const hold = (page: Page, ms = 1200) => page.waitForTimeout(ms);

/** Move the pointer to the middle of `target` over ~half a second. */
export async function glideTo(page: Page, target: Locator, steps = 30): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('glideTo: target has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
}

/** Glide over, pause a beat, click. */
export async function glideClick(page: Page, target: Locator): Promise<void> {
  await glideTo(page, target);
  await hold(page, 250);
  await target.click();
}

/** Type like a person, not a paste. */
export async function typeSlowly(target: Locator, text: string, delay = 55): Promise<void> {
  await target.pressSequentially(text, { delay });
}
