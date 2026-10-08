import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  AI_PANE_IDS,
  USE_AI_CHECK_FAILED,
  USE_AI_CHECK_FAILED_LINE,
  USE_AI_COPY,
  USE_AI_NEEDS_UPDATE,
  aiPaneLayout,
  connectionBody,
  connectionPill,
  connectionPillLabel,
  connectionPillTone,
  isAIOff,
  limitInForce,
  openClawStatus,
  type AIBusy,
  type AIPaneInput,
  type AIPaneLayout,
  type AliasId,
  type ConnectionPill,
} from '@/lib/ai-pane-state';
import type { ModelConnectionView, OpenClawView } from '@/lib/ai-types';
import {
  AI_HIDDEN,
  AI_OFF_CONNECTED,
  AI_OFF_PAIRED,
  CONNECTED_MODEL,
  DAILY_LIMIT,
  GEMINI_WORKING,
  KEY_TURNED_DOWN,
  NOTHING_CONNECTED,
  NO_MODEL_PICKED,
  OPENCLAW_PLUGIN,
  OPENCLAW_PULL_ONLY,
  paneInputFor,
  type SeedAI,
} from './helpers/ai-fixtures';

/**
 * Settings → AI as data (lib/ai-pane-state.ts): which word the Connection pill
 * says, which body sits under it, which form "Use AI in dsul" takes, which
 * sections show, and where each record's one anchor is. The pane and the panel
 * draw what these say, so every state is pinned here as a table.
 */

/** Before the reset DAILY_LIMIT carries, and after it. */
const BEFORE_RESET = Date.parse('2099-01-01T14:59:30.000Z');
const AFTER_RESET = Date.parse('2099-01-01T15:00:30.000Z');
const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const FUTURE = '2099-01-01T15:00:00.000Z';

/** The store-shaped input for the pill and the body, from a seed. */
function conn(seed?: SeedAI, busy: AIBusy = null) {
  const i = paneInputFor(seed);
  return { phase: i.phase, available: i.available, model: i.model, busy };
}

function withModel(seed: SeedAI, over: Partial<ModelConnectionView>): SeedAI {
  return { ...seed, model: { ...seed.model, ...over } };
}

describe('connectionPill', () => {
  const cases: [string, ReturnType<typeof conn>, ConnectionPill | null][] = [
    ['unknown', conn(), 'checking'],
    ['error', conn({ ...NOTHING_CONNECTED, phase: 'error' }), null],
    ['not available', conn({ ...GEMINI_WORKING, available: false }), null],
    ['busy connect', conn(NOTHING_CONNECTED, 'connect'), 'checking'],
    ['busy recheck', conn(GEMINI_WORKING, 'recheck'), 'checking'],
    ['busy model: the underlying pill', conn(GEMINI_WORKING, 'model'), 'working'],
    ['busy disconnect: the underlying pill', conn(KEY_TURNED_DOWN, 'disconnect'), 'needs_attention'],
    ['no model', conn(NOTHING_CONNECTED), 'not_set_up'],
    ['failing', conn(KEY_TURNED_DOWN), 'needs_attention'],
    ['failing beats a limit', conn(withModel(KEY_TURNED_DOWN, { limitedUntil: FUTURE })), 'needs_attention'],
    ['no model picked', conn(NO_MODEL_PICKED), 'needs_attention'],
    ['daily limit', conn(DAILY_LIMIT), 'daily_limit'],
    ['working', conn(GEMINI_WORKING), 'working'],
    ['OpenClaw only: still not set up', conn(OPENCLAW_PLUGIN), 'not_set_up'],
  ];
  it.each(cases)('%s', (_name, s, expected) => {
    expect(connectionPill(s, BEFORE_RESET)).toBe(expected);
  });

  it('a limit that has passed reads working again; with no clock yet it still holds', () => {
    expect(connectionPill(conn(DAILY_LIMIT), AFTER_RESET)).toBe('working');
    expect(connectionPill(conn(DAILY_LIMIT), null)).toBe('daily_limit');
  });

  it('the phase answers before busy: a recheck while the check failed draws no pill', () => {
    expect(connectionPill(conn({ ...GEMINI_WORKING, phase: 'error' }, 'recheck'), NOW)).toBeNull();
    expect(connectionPill(conn({ ...GEMINI_WORKING, available: false }, 'connect'), NOW)).toBeNull();
  });
});

describe('connectionPillLabel', () => {
  it('says each word', () => {
    expect(connectionPillLabel('checking', null)).toBe('Checking…');
    expect(connectionPillLabel('not_set_up', null)).toBe('Not set up');
    expect(connectionPillLabel('working', null)).toBe('Working');
    expect(connectionPillLabel('needs_attention', null)).toBe('Needs attention');
  });

  it('names the reset when there is one, and stops at the words when there is none', () => {
    expect(connectionPillLabel('daily_limit', '7 am')).toBe('Daily limit · back at 7 am');
    expect(connectionPillLabel('daily_limit', null)).toBe('Daily limit');
  });
});

describe('connectionPillTone', () => {
  it('is lime only for working while something answers here', () => {
    expect(connectionPillTone('working', true)).toBe('lime');
    expect(connectionPillTone('working', false)).toBe('grey');
  });

  it('is honey for the states that want the person, grey for the rest', () => {
    expect(connectionPillTone('needs_attention', true)).toBe('honey');
    expect(connectionPillTone('daily_limit', true)).toBe('honey');
    expect(connectionPillTone('checking', true)).toBe('grey');
    expect(connectionPillTone('not_set_up', true)).toBe('grey');
    expect(connectionPillTone('needs_attention', false)).toBe('honey');
  });
});

describe('limitInForce', () => {
  const model = paneInputFor(GEMINI_WORKING).model!;

  it('is false with no model, no field, or a field that does not parse', () => {
    expect(limitInForce(null, NOW)).toBe(false);
    expect(limitInForce({ ...model, limitedUntil: null }, NOW)).toBe(false);
    expect(limitInForce({ ...model, limitedUntil: 'nope' }, NOW)).toBe(false);
    expect(limitInForce({ ...model, limitedUntil: 'nope' }, null)).toBe(false);
  });

  it('holds until the reset, and counts any parseable one before the clock has a time', () => {
    expect(limitInForce({ ...model, limitedUntil: FUTURE }, BEFORE_RESET)).toBe(true);
    expect(limitInForce({ ...model, limitedUntil: FUTURE }, AFTER_RESET)).toBe(false);
    expect(limitInForce({ ...model, limitedUntil: FUTURE }, Date.parse(FUTURE))).toBe(false);
    expect(limitInForce({ ...model, limitedUntil: '2000-01-01T00:00:00.000Z' }, null)).toBe(true);
  });
});

describe('isAIOff', () => {
  it('is off only once the server has said so', () => {
    expect(isAIOff({ phase: 'unknown', aiHidden: true })).toBe(false);
    expect(isAIOff({ phase: 'error', aiHidden: true })).toBe(false);
    expect(isAIOff({ phase: 'ready', aiHidden: true })).toBe(true);
    expect(isAIOff({ phase: 'ready', aiHidden: null })).toBe(false);
    expect(isAIOff({ phase: 'ready', aiHidden: false })).toBe(false);
  });
});

describe('connectionBody', () => {
  const body = (seed: SeedAI | undefined, now: number | null = BEFORE_RESET) => {
    const i = paneInputFor(seed);
    return connectionBody({ phase: i.phase, available: i.available, model: i.model }, now);
  };

  it.each([
    ['unknown', undefined, 'checking'],
    ['error', { ...NOTHING_CONNECTED, phase: 'error' as const }, 'failed'],
    ['not available', { ...GEMINI_WORKING, available: false }, 'unavailable'],
    ['no model', NOTHING_CONNECTED, 'connect'],
    ['OpenClaw only', OPENCLAW_PLUGIN, 'connect'],
    ['failing', KEY_TURNED_DOWN, 'fix'],
    ['failing with a limit', withModel(KEY_TURNED_DOWN, { limitedUntil: FUTURE }), 'fix'],
    ['daily limit', DAILY_LIMIT, 'limit'],
    ['no model picked, with a limit: the picker first', withModel(NO_MODEL_PICKED, { limitedUntil: FUTURE }), 'working'],
    ['no model picked', NO_MODEL_PICKED, 'working'],
    ['working', GEMINI_WORKING, 'working'],
  ] as const)('%s', (_name, seed, expected) => {
    expect(body(seed)).toBe(expected);
  });

  it('a limit that has passed is the working card again', () => {
    expect(body(DAILY_LIMIT, AFTER_RESET)).toBe('working');
    expect(body(DAILY_LIMIT, null)).toBe('limit');
  });

  it('never reads busy, so a check in flight keeps its body mounted', () => {
    const i = paneInputFor(GEMINI_WORKING);
    // @ts-expect-error: connectionBody takes no `busy`; passing one is a compile error.
    connectionBody({ phase: i.phase, available: i.available, model: i.model, busy: 'recheck' }, NOW);
    // And at runtime a stray one changes nothing.
    const withBusy = { phase: i.phase, available: i.available, model: i.model, busy: 'connect' };
    expect(connectionBody(withBusy, NOW)).toBe('working');
  });
});

/* ── aiPaneLayout ────────────────────────────────────────────────────────── */

const FOUR: readonly AliasId[] = ['beacon.provider', 'beacon.instructions', 'beacon.gatewayUrl', 'beacon.gatewayToken'];
const DEVICE: readonly AliasId[] = ['beacon.provider', 'beacon.instructions'];
const SIX: readonly AliasId[] = [
  'beacon.apiKey',
  'beacon.model',
  'beacon.provider',
  'beacon.instructions',
  'beacon.gatewayUrl',
  'beacon.gatewayToken',
];

/** A whole layout: a ready, connected, on state, overridden per row. */
function layout(over: Partial<AIPaneLayout>): AIPaneLayout {
  return {
    known: true,
    aiOff: false,
    nothingConnected: false,
    explainer: 'sentence',
    useAi: 'on',
    useAiReason: null,
    useAiLine: null,
    showOpenClaw: true,
    showDevice: true,
    connectionAliases: [],
    offCardAliases: [],
    ...over,
  };
}

const UNKNOWN_LAYOUT = layout({
  known: false,
  explainer: 'none',
  useAi: 'pending',
  useAiLine: 'Still loading…',
  showOpenClaw: false,
  showDevice: false,
  connectionAliases: FOUR,
});

const TABLE: [string, AIPaneInput, AIPaneLayout][] = [
  ['unknown', paneInputFor(), UNKNOWN_LAYOUT],
  ['unknown, latched', paneInputFor(undefined, true), UNKNOWN_LAYOUT],
  [
    'error',
    paneInputFor({ ...NOTHING_CONNECTED, phase: 'error' }),
    layout({
      known: false,
      explainer: 'none',
      useAi: 'unavailable',
      useAiReason: USE_AI_CHECK_FAILED,
      useAiLine: USE_AI_CHECK_FAILED_LINE,
      showOpenClaw: false,
      showDevice: false,
      connectionAliases: FOUR,
    }),
  ],
  [
    'nothing connected (F18)',
    paneInputFor(NOTHING_CONNECTED),
    layout({
      nothingConnected: true,
      explainer: 'tiles',
      useAi: 'button',
      showDevice: false,
      connectionAliases: DEVICE,
    }),
  ],
  [
    'nothing connected, chat Off here',
    paneInputFor({ ...NOTHING_CONNECTED, choice: 'none' }),
    layout({ nothingConnected: true, explainer: 'tiles', useAi: 'button', showDevice: true, connectionAliases: [] }),
  ],
  [
    'nothing connected, On this device latched',
    paneInputFor(NOTHING_CONNECTED, true),
    layout({ nothingConnected: true, explainer: 'tiles', useAi: 'button', showDevice: true, connectionAliases: [] }),
  ],
  [
    'nothing connected, not available',
    paneInputFor({ ...NOTHING_CONNECTED, available: false }),
    layout({
      nothingConnected: true,
      explainer: 'tiles',
      useAi: 'button',
      showDevice: false,
      connectionAliases: DEVICE,
    }),
  ],
  [
    'AI off, not available (isAIOff ignores available)',
    paneInputFor({ ...AI_HIDDEN, available: false }),
    layout({
      aiOff: true,
      nothingConnected: true,
      explainer: 'none',
      useAi: 'off',
      showOpenClaw: false,
      showDevice: false,
      offCardAliases: SIX,
    }),
  ],
  [
    'AI off beats the latch',
    paneInputFor(AI_HIDDEN, true),
    layout({
      aiOff: true,
      nothingConnected: true,
      explainer: 'none',
      useAi: 'off',
      showOpenClaw: false,
      showDevice: false,
      offCardAliases: SIX,
    }),
  ],
  ['Gemini working (F19)', paneInputFor(GEMINI_WORKING), layout({})],
  ['Gemini working, latched', paneInputFor(GEMINI_WORKING, true), layout({})],
  ['key turned down (F20)', paneInputFor(KEY_TURNED_DOWN), layout({})],
  ['daily limit (F21)', paneInputFor(DAILY_LIMIT), layout({})],
  ['no model picked', paneInputFor(NO_MODEL_PICKED), layout({})],
  [
    'AI off with a model (F22)',
    paneInputFor(AI_OFF_CONNECTED),
    layout({
      aiOff: true,
      explainer: 'none',
      useAi: 'off',
      showOpenClaw: false,
      showDevice: false,
      offCardAliases: SIX,
    }),
  ],
  [
    'AI off, OpenClaw paired',
    paneInputFor(AI_OFF_PAIRED),
    layout({
      aiOff: true,
      explainer: 'none',
      useAi: 'off',
      showOpenClaw: false,
      showDevice: false,
      offCardAliases: SIX,
    }),
  ],
  [
    'aiHidden null (060 missing)',
    paneInputFor({ ...GEMINI_WORKING, aiHidden: null }),
    layout({
      useAi: 'unavailable',
      useAiReason: USE_AI_NEEDS_UPDATE,
      useAiLine: `Unavailable: ${USE_AI_NEEDS_UPDATE}`,
    }),
  ],
  [
    'aiHidden null, nothing connected',
    paneInputFor({ ...NOTHING_CONNECTED, aiHidden: null }),
    layout({
      nothingConnected: true,
      explainer: 'tiles',
      useAi: 'unavailable',
      useAiReason: USE_AI_NEEDS_UPDATE,
      useAiLine: `Unavailable: ${USE_AI_NEEDS_UPDATE}`,
      showDevice: false,
      connectionAliases: DEVICE,
    }),
  ],
  ['OpenClaw plugin chat', paneInputFor(OPENCLAW_PLUGIN), layout({})],
  ['OpenClaw pull-only', paneInputFor(OPENCLAW_PULL_ONLY), layout({})],
  ['a model on a device with chat Off', paneInputFor({ ...CONNECTED_MODEL, choice: 'none' }), layout({})],
];

describe('aiPaneLayout', () => {
  it.each(TABLE)('%s', (_name, input, expected) => {
    expect(aiPaneLayout(input)).toEqual(expected);
  });

  it('an OpenClaw agent key alone is something: the switch, not the button', () => {
    const l = aiPaneLayout(paneInputFor(OPENCLAW_PULL_ONLY));
    expect(l.nothingConnected).toBe(false);
    expect(l.explainer).toBe('sentence');
    expect(l.useAi).toBe('on');
  });

  it('keepDevice defaults to false', () => {
    const input: AIPaneInput = { ...paneInputFor(NOTHING_CONNECTED) };
    delete input.keepDevice;
    expect('keepDevice' in input).toBe(false);
    expect(aiPaneLayout(input).showDevice).toBe(false);
  });

  it('covers every id but Use AI exactly once, in every state', () => {
    // Use AI in dsul is always its own row; the other six each need exactly one
    // anchor: a real row (On this device, the OpenClaw fold) or an alias on the
    // section standing in for it. apiKey and model are the panel's own anchors
    // while the panel draws, so only the off card covers them here.
    const device: AliasId[] = ['beacon.provider', 'beacon.instructions'];
    const gateway: AliasId[] = ['beacon.gatewayUrl', 'beacon.gatewayToken'];
    for (const [name, input] of TABLE) {
      for (const keepDevice of [false, true]) {
        const l = aiPaneLayout({ ...input, keepDevice });
        const covered = [
          ...l.connectionAliases,
          ...l.offCardAliases,
          ...(l.showDevice ? device : []),
          ...(l.showOpenClaw ? gateway : []),
        ];
        for (const id of ['beacon.provider', 'beacon.instructions', 'beacon.gatewayUrl', 'beacon.gatewayToken']) {
          expect(covered.filter((c) => c === id), `${name} keepDevice=${keepDevice}: ${id}`).toHaveLength(1);
        }
        // While the panel is hidden (AI off) the card stands in for its two anchors too.
        if (l.aiOff) expect(l.offCardAliases).toEqual(expect.arrayContaining(['beacon.apiKey', 'beacon.model']));
        else {
          expect(l.connectionAliases).not.toContain('beacon.apiKey');
          expect(l.connectionAliases).not.toContain('beacon.model');
        }
      }
    }
  });

  it('names every record the pane anchors, and Use AI is first', () => {
    expect(AI_PANE_IDS[0]).toBe('beacon.useAi');
    expect([...AI_PANE_IDS].sort()).toEqual(['beacon.useAi', ...SIX].sort());
  });

  it('USE_AI_COPY holds the three sentences', () => {
    expect(USE_AI_COPY).toEqual({
      button:
        'AI is optional. No AI, thanks hides Ask and every invitation to set it up, on all your devices. You can turn it back on here.',
      on: 'Off hides Ask, plan suggestions, Break it down and every invitation to set AI up, on all your devices. dsul works fully either way.',
      off: 'AI is off. Ask, plan suggestions, Break it down and every invitation to set AI up are hidden on all your devices.',
    });
    expect(Object.isFrozen(USE_AI_COPY)).toBe(true);
    expect(USE_AI_CHECK_FAILED).toBe('Couldn’t check your AI connection.');
    expect(USE_AI_CHECK_FAILED_LINE).toBe('Unavailable until the check below works.');
    expect(USE_AI_NEEDS_UPDATE).toBe('Needs a database update that has not landed here yet.');
  });
});

describe('openClawStatus', () => {
  const o = (over: Partial<OpenClawView>): OpenClawView => ({
    gateway: false,
    pluginChat: false,
    agent: false,
    agentId: null,
    ...over,
  });

  it('a stale agentId with no chat transport is never named', () => {
    expect(openClawStatus(o({ agent: true, agentId: 'atlas' }))).toEqual({
      paired: true,
      answers: false,
      agent: true,
      name: 'OpenClaw',
    });
  });

  it('names the agent while its plugin chat is live', () => {
    expect(openClawStatus(paneInputFor(AI_OFF_PAIRED).openclaw)).toEqual({
      paired: true,
      answers: true,
      agent: true,
      name: 'atlas',
    });
  });

  it('a gateway answers and is paired without an agent key', () => {
    expect(openClawStatus(o({ gateway: true, agentId: 'g1' }))).toEqual({
      paired: true,
      answers: true,
      agent: false,
      name: 'g1',
    });
  });

  it("'main' and no id read OpenClaw", () => {
    expect(openClawStatus(o({ agent: true, pluginChat: true, agentId: 'main' })).name).toBe('OpenClaw');
    expect(openClawStatus(o({ agent: true, pluginChat: true, agentId: null })).name).toBe('OpenClaw');
  });

  it('the plugin fixture is kirby-1 and answers', () => {
    const s = openClawStatus(paneInputFor(OPENCLAW_PLUGIN).openclaw);
    expect(s.name).toBe('kirby-1');
    expect(s.answers).toBe(true);
  });

  it('pull-only is paired and answers nothing', () => {
    expect(openClawStatus(paneInputFor(OPENCLAW_PULL_ONLY).openclaw)).toEqual({
      paired: true,
      answers: false,
      agent: true,
      name: 'OpenClaw',
    });
  });

  it('nothing is not paired', () => {
    expect(openClawStatus(o({})).paired).toBe(false);
    expect(openClawStatus(o({})).answers).toBe(false);
  });
});

describe('lib/ai-pane-state.ts copy', () => {
  it('has no em dash, no ⌘ and never says Beacon', () => {
    const src = readFileSync(join(process.cwd(), 'lib/ai-pane-state.ts'), 'utf8');
    expect(src).not.toContain('—');
    expect(src).not.toContain('⌘');
    expect(src).not.toMatch(/\bBeacon\b/);
  });
});
