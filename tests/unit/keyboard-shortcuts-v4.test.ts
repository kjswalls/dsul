import { describe, it, expect, beforeEach } from 'vitest';
import { getShortcutBindings, useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import { encodeKeys } from '@/lib/commands/keys';

/**
 * keyboard-shortcuts v4 (AI step 2a): Ctrl+J became toggle_right_sidebar's
 * default. It was free before, so a user may have recorded it for another
 * command, and the dispatcher takes the FIRST matching binding, which would
 * now be Ask's (with no AI, a consumed key that does nothing). The migration
 * keeps their chord's meaning and gives Ask its old key back.
 */

const KEY = 'dsul-keyboard-shortcuts';

async function rehydrateFrom(record: unknown) {
  localStorage.setItem(KEY, JSON.stringify(record));
  await useKeyboardShortcutsStore.persist.rehydrate();
  return useKeyboardShortcutsStore.getState().overrides;
}

/** Every binding that answers Ctrl+J (or ⌘J) now. */
const ctrlJOwners = () =>
  getShortcutBindings()
    .filter((b) => encodeKeys(b.keys) === encodeKeys(['mod', 'j']))
    .map((b) => b.id);

beforeEach(() => {
  localStorage.removeItem(KEY);
  useKeyboardShortcutsStore.setState({ overrides: {} });
});

describe('the v3 → v4 migration', () => {
  it('gives Ask its old key when the user had recorded Ctrl+J for something else', async () => {
    const overrides = await rehydrateFrom({ state: { overrides: { system_capture: ['j', 'mod'] } }, version: 3 });
    expect(overrides).toEqual({ system_capture: ['j', 'mod'], toggle_right_sidebar: ['meta', ']'] });
    expect(ctrlJOwners()).toEqual(['system_capture']);
  });

  it('reads ⌘J and Ctrl+J as the same chord', async () => {
    const overrides = await rehydrateFrom({ state: { overrides: { undo: ['ctrl', 'j'] } }, version: 3 });
    expect(overrides.toggle_right_sidebar).toEqual(['meta', ']']);
  });

  it('changes nothing for a record with no Ctrl+J in it', async () => {
    const before = { system_capture: ['mod', 'u'] };
    expect(await rehydrateFrom({ state: { overrides: before }, version: 3 })).toEqual(before);
    expect(ctrlJOwners()).toEqual(['toggle_right_sidebar']);
  });

  it('leaves a toggle_right_sidebar the user already moved where they put it', async () => {
    const before = { system_capture: ['j', 'mod'], toggle_right_sidebar: ['mod', 'u'] };
    expect(await rehydrateFrom({ state: { overrides: before }, version: 3 })).toEqual(before);
  });

  it('runs on a v1/v2 record too, after its own step', async () => {
    const overrides = await rehydrateFrom({
      state: { shortcuts: [{ id: 'system_capture', keys: ['meta', 'j'] }] },
      version: 2,
    });
    expect(overrides).toEqual({ system_capture: ['meta', 'j'], toggle_right_sidebar: ['meta', ']'] });
  });

  it('does not run again on a v4 record', async () => {
    const before = { system_capture: ['j', 'mod'] };
    expect(await rehydrateFrom({ state: { overrides: before }, version: 4 })).toEqual(before);
  });
});
