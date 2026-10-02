import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import appIcon from '../../electron/lib/app-icon.cjs';
import builderConfig from '../../electron/electron-builder.config.cjs';

// The desktop shell's run-time icon (electron/lib/app-icon.cjs) names files that
// scripts/app-icon/build.mjs writes and electron-builder has to pack. A name that drifts on any
// side is an empty nativeImage in the packaged app, which main.cjs quietly ignores, so the
// Dock just never changes. These hold the three to each other.
const { LOOKS, DEFAULT_LOOK, parseLook, iconFile } = appIcon;
const root = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

/** electron-builder's `files` globs, as far as this config uses them: `*` and `**`. */
function globToRegExp(glob: string) {
  const body = glob
    .split(/(\*\*|\*)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`);
}

describe('electron/lib/app-icon.cjs', () => {
  it('stays pure: no requires and no imports, so this suite can load it without Electron', () => {
    const source = read('electron/lib/app-icon.cjs');
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/^\s*import\b/m);
  });

  it('knows exactly Aurora and Lime, Aurora first and the default', () => {
    expect(LOOKS).toEqual(['aurora', 'lime']);
    expect(DEFAULT_LOOK).toBe('aurora');
    expect(Object.isFrozen(LOOKS)).toBe(true);
  });

  it('accepts only a known look from the page', () => {
    expect(parseLook('aurora')).toBe('aurora');
    expect(parseLook('lime')).toBe('lime');
    for (const bad of ['LIME', 'Lime', '', ' lime', '../icon', 'icon', null, undefined, 1, {}, ['lime']]) {
      expect(parseLook(bad)).toBeNull();
    }
  });

  it('names a PNG for every look on every platform', () => {
    expect(LOOKS.map(iconFile)).toEqual(['app-icon-aurora.png', 'app-icon-lime.png']);
  });

  it('points at files build.mjs wrote and electron-builder packs', () => {
    const globs = (builderConfig.files as string[]).map(globToRegExp);
    for (const look of LOOKS) {
      const rel = `build/${iconFile(look)}`;
      expect(existsSync(path.join(root, 'electron', rel)), rel).toBe(true);
      expect(globs.some((g) => g.test(rel)), `${rel} is not in electron-builder's files`).toBe(true);
    }
    // The bundle icons stay out of the asar: electron-builder reads them from buildResources.
    expect(globs.some((g) => g.test('build/icon.png'))).toBe(false);
  });

  it('is wired into main and the preload on the same channel', () => {
    const main = read('electron/main.cjs');
    expect(main).toContain("require('./lib/app-icon.cjs')");
    expect(main).toMatch(/ipcMain\.handle\('dsul:set-app-icon',[\s\S]*?if \(!fromApp\(event\)\) return false;/);
    expect(read('electron/preload.cjs')).toContain("ipcRenderer\n      .invoke('dsul:set-app-icon'");
  });
});
