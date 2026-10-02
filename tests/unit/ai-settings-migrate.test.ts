import { describe, it, expect, beforeEach } from 'vitest';
import { migrateAISettings, useAISettingsStore } from '@/lib/ai-settings-store';

/**
 * `dsul-ai-settings` v0 → v1.
 *
 * v0 held a plaintext AI key in localStorage. v1 holds none: the key moved
 * server-side, sealed, and the browser keeps only who answers chat. The
 * migration's whole job is that the first load of this build takes the key
 * OFF the disk — zustand's persist writes the partialized state back after a
 * migrate, and these tests read the disk to prove it did.
 */

const KEY = 'dsul-ai-settings';
const SENTINEL = 'sk-SENTINEL-4242';

function writeV0(state: Record<string, unknown>) {
  localStorage.setItem(KEY, JSON.stringify({ state, version: 0 }));
}

function disk(): { state: Record<string, unknown>; version: number } {
  const raw = localStorage.getItem(KEY);
  if (!raw) throw new Error('nothing persisted');
  return JSON.parse(raw);
}

beforeEach(() => {
  localStorage.clear();
  useAISettingsStore.getState().clearUserScopedState();
  localStorage.clear();
});

describe('migrateAISettings (pure)', () => {
  it('maps an OpenAI key holder to the model target and raises the legacy notice', () => {
    expect(
      migrateAISettings({ provider: 'openai', apiKey: SENTINEL, model: 'gpt-4o' }, 0)
    ).toMatchObject({ chatTarget: 'model', legacyNotice: true });
  });

  it.each([
    ['openclaw', 'openclaw'],
    ['none', 'none'],
    ['anthropic', 'model'],
    ['openai', 'model'],
    [undefined, 'model'],
    ['something-else', 'model'],
  ] as const)('provider %s → chatTarget %s', (provider, chatTarget) => {
    expect(migrateAISettings({ provider, apiKey: '' }, 0).chatTarget).toBe(chatTarget);
  });

  it('raises the legacy notice for a paid-vendor provider or any stored key, and only then', () => {
    expect(migrateAISettings({ provider: 'anthropic', apiKey: '' }, 0).legacyNotice).toBe(true);
    expect(migrateAISettings({ provider: 'openai', apiKey: '' }, 0).legacyNotice).toBe(true);
    expect(migrateAISettings({ provider: 'openclaw', apiKey: SENTINEL }, 0).legacyNotice).toBe(true);
    expect(migrateAISettings({ provider: 'openclaw', apiKey: '' }, 0).legacyNotice).toBe(false);
    expect(migrateAISettings({ provider: 'none' }, 0).legacyNotice).toBe(false);
  });

  it('keeps the instructions and the name, and drops the key and the model', () => {
    const out = migrateAISettings(
      {
        provider: 'openai',
        apiKey: SENTINEL,
        model: 'gpt-4o',
        assistantName: 'Beacon',
        systemPrompt: 'Be brief.',
      },
      0
    );
    expect(out).toEqual({
      chatTarget: 'model',
      assistantName: 'Beacon',
      systemPrompt: 'Be brief.',
      legacyNotice: true,
    });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it('survives a blob that is not an object', () => {
    expect(migrateAISettings(null, 0)).toEqual({
      chatTarget: 'model',
      assistantName: 'Beacon',
      systemPrompt: '',
      legacyNotice: false,
    });
  });
});

describe('the store, rehydrating a v0 blob from disk', () => {
  it('lands on v1 and the key is gone from memory AND from disk', async () => {
    writeV0({
      provider: 'openai',
      apiKey: SENTINEL,
      model: 'gpt-4o',
      assistantName: 'Beacon',
      systemPrompt: 'Plan around school pickup.',
    });

    await useAISettingsStore.persist.rehydrate();

    const s = useAISettingsStore.getState();
    expect(s.chatTarget).toBe('model');
    expect(s.legacyNotice).toBe(true);
    expect(s.systemPrompt).toBe('Plan around school pickup.');
    expect('apiKey' in s).toBe(false);
    expect('provider' in s).toBe(false);
    expect('model' in s).toBe(false);

    // The disk copy is rewritten after the migrate, without the key.
    const after = disk();
    expect(after.version).toBe(1);
    expect(after.state).toEqual({
      chatTarget: 'model',
      assistantName: 'Beacon',
      systemPrompt: 'Plan around school pickup.',
      legacyNotice: true,
    });
    expect(JSON.stringify(localStorage)).not.toContain(SENTINEL);
  });

  it.each([
    ['openclaw', 'openclaw', false],
    ['none', 'none', false],
    ['anthropic', 'model', true],
  ] as const)('provider %s rehydrates as %s (legacy notice %s)', async (provider, target, notice) => {
    writeV0({ provider, apiKey: '', model: 'gpt-4o-mini', assistantName: 'Beacon', systemPrompt: '' });

    await useAISettingsStore.persist.rehydrate();

    expect(useAISettingsStore.getState().chatTarget).toBe(target);
    expect(useAISettingsStore.getState().legacyNotice).toBe(notice);
    expect(disk().state).not.toHaveProperty('apiKey');
    expect(disk().state).not.toHaveProperty('provider');
  });

  it('leaves a v1 blob as it is', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: { chatTarget: 'openclaw', assistantName: 'Beacon', systemPrompt: 'x', legacyNotice: false },
        version: 1,
      })
    );

    await useAISettingsStore.persist.rehydrate();

    expect(useAISettingsStore.getState().chatTarget).toBe('openclaw');
    expect(useAISettingsStore.getState().systemPrompt).toBe('x');
  });

  it('dismissLegacyNotice clears the flag and persists it', () => {
    useAISettingsStore.setState({ legacyNotice: true });
    useAISettingsStore.getState().dismissLegacyNotice();
    expect(useAISettingsStore.getState().legacyNotice).toBe(false);
    expect(disk().state.legacyNotice).toBe(false);
  });
});
