import type { ModUse } from './schema';

/**
 * A new mod's starting point in Make's editor (components/settings/mod-editor.tsx):
 * counts glasses of water from a ⌘K command or from its card panel's +1.
 * Pure text, so the QuickJS core test (tests/unit/mods-runtime-core.test.ts)
 * can run it as the editor would save it, and the e2e
 * (tests/e2e/mods-sandbox.spec.ts) can expect its toast.
 */
export const MOD_TEMPLATE = `// Water: counts the glasses you drink today.
// Run "Add a glass" from the command bar (Ctrl or Cmd K), or press +1 on
// the Water card under the braindump.
export const manifest = {
  version: 1,
  uses: ['storage', 'ui'],
  commands: [{ id: 'add-glass', label: 'Add a glass', keywords: ['water', 'drink'] }],
  panels: [{ id: 'water', label: 'Water', icon: 'CupSoda', card: true }],
};

const GOAL = 8;

async function glassesToday($) {
  const { date } = await $.today();
  const saved = await $.store.get({ key: 'glasses' });
  return { date, count: saved && saved.date === date ? saved.count : 0 };
}

async function addGlass($) {
  const { date, count } = await glassesToday($);
  await $.store.set({ key: 'glasses', value: { date, count: count + 1 } });
  return count + 1;
}

export function register(on) {
  on('command', async ($, e) => {
    if (e.id !== 'add-glass') return;
    const count = await addGlass($);
    await $.ui.toast({ text: count + ' of ' + GOAL + ' glasses today' });
  });

  // What the Water panel draws. It may only read here.
  on('ui.resolve', async ($, e) => {
    if (e.panelId !== 'water') return;
    const { count } = await glassesToday($);
    return {
      type: 'stack',
      children: [
        { type: 'stat', value: count + ' of ' + GOAL, label: 'Glasses today', tone: count >= GOAL ? 'accent' : undefined },
        { type: 'progress', value: count, max: GOAL, label: 'Water' },
        { type: 'button', label: '+1', action: 'add', tone: 'accent' },
      ],
    };
  });

  // A press on the panel: the same count as the command.
  on('ui.action', async ($, e) => {
    if (e.action === 'add') await addGlass($);
  });
}
`;

export const MOD_TEMPLATE_NAME = 'Water';
/** What the template's manifest asks for, shown before the first save has read it. */
export const MOD_TEMPLATE_USES: ModUse[] = ['storage', 'ui'];
