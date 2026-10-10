// @vitest-environment node
/**
 * lib/ai-model-names.ts: a model's name as a person reads it.
 *
 * Three sources in order (catalog, id shape, the provider's own label), and a
 * raw id as the last resort, because an unknown model is still the person's
 * choice and must still be nameable on screen.
 */

import { describe, expect, it } from 'vitest';
import { modelName } from '@/lib/ai-model-names';

describe('modelName: the catalog', () => {
  it('names the ids dsul picks by default, and says what some are for', () => {
    expect(modelName('gemini', 'gemini-flash-latest')).toEqual({
      name: 'Gemini Flash',
      about: 'Google’s quick everyday model',
    });
    expect(modelName('openai', 'gpt-5-mini')).toEqual({
      name: 'GPT-5 mini',
      about: 'OpenAI’s quick everyday model',
    });
    expect(modelName('openrouter', 'openrouter/auto')).toEqual({
      name: 'Auto',
      about: 'OpenRouter picks the model for each question',
    });
  });

  it('leaves `about` null where there is nothing worth saying', () => {
    expect(modelName('openai', 'gpt-4o')).toEqual({ name: 'GPT-4o', about: null });
    expect(modelName('openai', 'gpt-4.1-mini')).toEqual({ name: 'GPT-4.1 mini', about: null });
  });

  it('beats the label the provider listed', () => {
    expect(modelName('openai', 'gpt-5', 'GPT 5 (chat latest)').name).toBe('GPT-5');
  });

  it('is read for whichever provider lists the id, since OpenRouter lists them all', () => {
    expect(modelName('openrouter', 'gpt-4o-mini').name).toBe('GPT-4o mini');
  });

  it('is exact: a suffix or a prefix is a different model', () => {
    expect(modelName('openai', 'gpt-5-mini-2026-01-01').name).toBe('gpt-5-mini-2026-01-01');
    expect(modelName('gemini', 'models/gemini-flash-latest').name).toBe('models/gemini-flash-latest');
  });

  it('is not fooled by an inherited property name', () => {
    expect(modelName('openai', 'toString').name).toBe('toString');
    expect(modelName('openai', 'constructor').name).toBe('constructor');
  });
});

describe('modelName: id shapes', () => {
  it.each([
    ['claude-sonnet-4-5', 'Claude Sonnet 4.5'],
    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
    ['claude-sonnet-4', 'Claude Sonnet 4'],
    ['claude-haiku-3-5-20241022', 'Claude Haiku 3.5'],
  ])('reads %s as %s', (id, name) => {
    expect(modelName('anthropic', id)).toEqual({ name, about: null });
  });

  it.each([
    ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
    ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite'],
    ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
    ['gemini-3-pro', 'Gemini 3 Pro'],
  ])('reads %s as %s', (id, name) => {
    expect(modelName('gemini', id)).toEqual({ name, about: null });
  });

  it('a shape it does not know is left as the id', () => {
    for (const id of [
      'claude-wonder-4-5',
      'claude-sonnet',
      'claude-sonnet-4-5-preview',
      'gemini-2.5-ultra',
      'gemini-flash',
      'gemini-2.5-flash-lite-preview-09-2026',
    ]) {
      expect(modelName('anthropic', id).name).toBe(id);
    }
  });
});

describe('modelName: the provider\'s label, and the id', () => {
  it('uses the listed label when nothing else names the model', () => {
    expect(modelName('openrouter', 'deepseek/deepseek-chat-v3:free', 'DeepSeek V3 (free)')).toEqual({
      name: 'DeepSeek V3 (free)',
      about: null,
    });
  });

  it('falls back to the id for a blank label, or one that is just the id again', () => {
    const id = 'qwen/qwen3-30b';
    expect(modelName('openrouter', id, '   ').name).toBe(id);
    expect(modelName('openrouter', id, id).name).toBe(id);
    expect(modelName('openrouter', id, null).name).toBe(id);
    expect(modelName('openrouter', id).name).toBe(id);
  });

  it('trims a label the provider padded', () => {
    expect(modelName('openrouter', 'x/y', '  Something Large  ').name).toBe('Something Large');
  });

  it('never reads the catalog or a shape for another service, whose ids are its own', () => {
    // A local host may serve anything under any id; its own list is the only
    // thing that can name it.
    expect(modelName('custom', 'gpt-4o').name).toBe('gpt-4o');
    expect(modelName('custom', 'claude-sonnet-4-5').name).toBe('claude-sonnet-4-5');
    expect(modelName('custom', 'gemini-2.5-flash').name).toBe('gemini-2.5-flash');
    expect(modelName('custom', 'gpt-4o', 'My GPT').name).toBe('My GPT');
  });
});
