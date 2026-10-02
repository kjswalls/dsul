import { describe, it, expect } from 'vitest';
import { NO_AI, resolveAICapabilities, type AIInputs } from '@/lib/ai-registry';
import type { ChatTarget, ModelConnectionView, OpenClawView } from '@/lib/ai-types';

/**
 * The AI gate is the single answer to "what can answer right now, and what may
 * it do" — the sibling of lib/item-registry.ts. These tests exist mostly to
 * stop the failure mode it was built to prevent: a surface offering chat, a
 * plan, or a hand-off that nothing will act on.
 */

const MODEL_OK: ModelConnectionView = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: null,
  authMethod: 'key',
  status: 'ok',
  problem: null,
  checkedAt: '2026-10-01T00:00:00.000Z',
};

const NO_OPENCLAW: OpenClawView = { gateway: false, pluginChat: false, agent: false, agentId: null };
const GATEWAY: OpenClawView = { gateway: true, pluginChat: false, agent: true, agentId: 'kirby-1' };
const PLUGIN: OpenClawView = { gateway: false, pluginChat: true, agent: true, agentId: 'kirby-1' };

function inputs(over: Partial<AIInputs> = {}): AIInputs {
  return {
    phase: 'ready',
    available: true,
    model: null,
    openclaw: NO_OPENCLAW,
    choice: 'model',
    ...over,
  };
}

describe('fail closed', () => {
  it.each(['unknown', 'error'] as const)('is NO_AI while the phase is %s, whatever is connected', (phase) => {
    // A status read that has not answered, or failed, is not permission. The
    // surfaces hide for a moment rather than offer something that may not answer.
    const caps = resolveAICapabilities(
      inputs({ phase, model: MODEL_OK, openclaw: { ...GATEWAY, pluginChat: true } })
    );
    expect(caps).toBe(NO_AI);
    expect(caps.known).toBe(false);
    expect(caps.canChat).toBe(false);
    expect(caps.canPropose).toBe(false);
    expect(caps.canDelegate).toBe(false);
  });

  it('NO_AI turns every capability off', () => {
    expect(Object.values(NO_AI).some((v) => v === true)).toBe(false);
    expect(NO_AI.target).toBe('none');
  });

  it('nothing connected: known, but nothing answers', () => {
    const caps = resolveAICapabilities(inputs());
    expect(caps.known).toBe(true);
    expect(caps).toMatchObject({
      target: 'none',
      canChat: false,
      canPropose: false,
      canDelegate: false,
      answererName: null,
      modelUsable: false,
      openclawUsable: false,
    });
  });
});

describe('modelUsable', () => {
  it('needs available, an ok status and a chosen model', () => {
    expect(resolveAICapabilities(inputs({ model: MODEL_OK })).modelUsable).toBe(true);
    expect(resolveAICapabilities(inputs({ model: MODEL_OK, available: false })).modelUsable).toBe(false);
    expect(
      resolveAICapabilities(inputs({ model: { ...MODEL_OK, status: 'failing', problem: 'key_rejected' } }))
        .modelUsable
    ).toBe(false);
    expect(resolveAICapabilities(inputs({ model: { ...MODEL_OK, model: null } })).modelUsable).toBe(false);
  });

  it('flags a failing key, and a connection with no model, as needing attention', () => {
    const failing = resolveAICapabilities(
      inputs({ model: { ...MODEL_OK, status: 'failing', problem: 'key_rejected' } })
    );
    expect(failing.modelFailing).toBe(true);
    expect(failing.modelNeedsAttention).toBe(true);

    const unchosen = resolveAICapabilities(inputs({ model: { ...MODEL_OK, model: null } }));
    expect(unchosen.modelFailing).toBe(false);
    expect(unchosen.modelNeedsAttention).toBe(true);

    const fine = resolveAICapabilities(inputs({ model: MODEL_OK }));
    expect(fine.modelFailing).toBe(false);
    expect(fine.modelNeedsAttention).toBe(false);

    expect(resolveAICapabilities(inputs()).modelNeedsAttention).toBe(false);
  });
});

describe('openclawTransport', () => {
  it('prefers the gateway, then the plugin chat url', () => {
    expect(resolveAICapabilities(inputs({ openclaw: GATEWAY })).openclawTransport).toBe('gateway');
    expect(resolveAICapabilities(inputs({ openclaw: PLUGIN })).openclawTransport).toBe('plugin');
    expect(
      resolveAICapabilities(inputs({ openclaw: { ...GATEWAY, pluginChat: true } })).openclawTransport
    ).toBe('gateway');
    expect(resolveAICapabilities(inputs()).openclawTransport).toBeNull();
  });

  it('an agent key alone is not a chat transport', () => {
    const caps = resolveAICapabilities(
      inputs({ openclaw: { ...NO_OPENCLAW, agent: true, agentId: 'kirby-1' } })
    );
    expect(caps.openclawUsable).toBe(false);
    expect(caps.canChat).toBe(false);
    // …but it is enough to hand work to the agent.
    expect(caps.canDelegate).toBe(true);
  });
});

describe('the effective target (precedence table)', () => {
  type Row = [ChatTarget, boolean, boolean, ChatTarget];
  // [choice, model usable, openclaw usable, effective target]
  const table: Row[] = [
    ['model', true, true, 'model'],
    ['model', true, false, 'model'],
    ['model', false, true, 'openclaw'],
    ['model', false, false, 'none'],
    ['openclaw', true, true, 'openclaw'],
    ['openclaw', false, true, 'openclaw'],
    ['openclaw', true, false, 'model'],
    ['openclaw', false, false, 'none'],
    ['none', true, true, 'none'],
    ['none', true, false, 'none'],
    ['none', false, true, 'none'],
    ['none', false, false, 'none'],
  ];

  it.each(table)('choice %s, model %s, openclaw %s → %s', (choice, model, openclaw, expected) => {
    const caps = resolveAICapabilities(
      inputs({ choice, model: model ? MODEL_OK : null, openclaw: openclaw ? PLUGIN : NO_OPENCLAW })
    );
    expect(caps.target).toBe(expected);
    expect(caps.canChat).toBe(expected !== 'none');
    expect(caps.answererName).toBe(
      expected === 'model' ? 'AI' : expected === 'openclaw' ? 'OpenClaw' : null
    );
  });
});

describe('proposeTarget (D14)', () => {
  it('proposes through the model when the model answers', () => {
    const caps = resolveAICapabilities(inputs({ model: MODEL_OK }));
    expect(caps.proposeTarget).toBe('model');
    expect(caps.canPropose).toBe(true);
  });

  it('proposes through OpenClaw only on its gateway', () => {
    const caps = resolveAICapabilities(inputs({ choice: 'openclaw', openclaw: GATEWAY }));
    expect(caps.target).toBe('openclaw');
    expect(caps.proposeTarget).toBe('openclaw');
    expect(caps.canPropose).toBe(true);
  });

  it('never reroutes an OpenClaw plugin user to the model to propose', () => {
    // The propose route promises never to reroute an OpenClaw user's planner
    // to a model they did not pick. The plugin path has no proposal transport.
    const caps = resolveAICapabilities(
      inputs({ choice: 'openclaw', openclaw: PLUGIN, model: MODEL_OK })
    );
    expect(caps.target).toBe('openclaw');
    expect(caps.canChat).toBe(true);
    expect(caps.proposeTarget).toBeNull();
    expect(caps.canPropose).toBe(false);
  });

  it('cannot propose when nothing answers', () => {
    const caps = resolveAICapabilities(inputs({ choice: 'none', model: MODEL_OK, openclaw: GATEWAY }));
    expect(caps.proposeTarget).toBeNull();
    expect(caps.canPropose).toBe(false);
  });
});

describe('canDelegate', () => {
  it('follows the agent key, independent of who answers chat', () => {
    for (const choice of ['model', 'openclaw', 'none'] as const) {
      expect(
        resolveAICapabilities(inputs({ choice, model: MODEL_OK, openclaw: PLUGIN })).canDelegate
      ).toBe(true);
      expect(resolveAICapabilities(inputs({ choice, model: MODEL_OK })).canDelegate).toBe(false);
    }
  });

  it('carries the agent id through', () => {
    expect(resolveAICapabilities(inputs({ openclaw: PLUGIN })).agentId).toBe('kirby-1');
    expect(resolveAICapabilities(inputs()).agentId).toBeNull();
  });
});
