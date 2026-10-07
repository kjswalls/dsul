import type { ModUse } from './schema';

/**
 * A new mod's starting point in Make's editor (components/settings/mod-editor.tsx):
 * counts glasses of water from a ⌘K command. Pure text, so the QuickJS core
 * test (tests/unit/mods-runtime-core.test.ts) can run it as the editor would
 * save it, and the e2e (tests/e2e/mods-sandbox.spec.ts) can expect its toast.
 */
export const MOD_TEMPLATE = `// Water: counts the glasses you drink today.
// Run "Add a glass" from the command bar (Ctrl or Cmd K).
export const manifest = {
  version: 1,
  uses: ['storage', 'ui'],
  commands: [{ id: 'add-glass', label: 'Add a glass', keywords: ['water', 'drink'] }],
};

export function register(on) {
  on('command', async ($, e) => {
    if (e.id !== 'add-glass') return;
    const { date } = await $.today();
    const saved = await $.store.get({ key: 'glasses' });
    const count = saved && saved.date === date ? saved.count + 1 : 1;
    await $.store.set({ key: 'glasses', value: { date, count } });
    await $.ui.toast({ text: count + ' of 8 glasses today' });
  });
}
`;

export const MOD_TEMPLATE_NAME = 'Water';
/** What the template's manifest asks for, shown before the first save has read it. */
export const MOD_TEMPLATE_USES: ModUse[] = ['storage', 'ui'];
