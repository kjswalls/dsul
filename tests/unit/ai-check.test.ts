// @vitest-environment node
/**
 * lib/ai-server/check.ts: the check a key gets before dsul keeps it.
 *
 * The adapter is a stub, so what is under test is only the decision tree: when
 * the test question is asked at all, which model it goes to, which failures
 * the key survives, and the three second asks (Anthropic's default, OpenRouter's
 * next free default, one transient retry) with the deadline that gates them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkConnection,
  RETRY_MIN_MS,
  RETRY_PAUSE_MS,
  type CheckOptions,
} from '@/lib/ai-server/check';
import { ProviderError, type ProviderErrorKind } from '@/lib/ai-server/errors';
import type {
  ListedModel,
  ProviderAdapter,
  ProviderCredentials,
  VerifyResult,
} from '@/lib/ai-server/providers/types';
import type { ModelProviderId } from '@/lib/ai-types';

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
/** Comfortably more than RETRY_MIN_MS + RETRY_PAUSE_MS. */
const BUDGET = 20_000;

const model = (id: string, extra: Partial<ListedModel> = {}): ListedModel => ({
  id,
  label: id,
  ...extra,
});

const listResult = (ids: string[], extra: Partial<VerifyResult> = {}): VerifyResult => ({
  models: ids.map((id) => model(id)),
  listed: true,
  ...extra,
});

interface StubOpts {
  id?: ModelProviderId;
  verify?: VerifyResult | ProviderError;
  list?: VerifyResult;
  /** One entry per ask, in order; a kind fails that ask, null answers it. */
  pings?: (ProviderErrorKind | ProviderError | null)[];
  pickDefault?: (result: VerifyResult) => string | null;
}

interface Stub {
  adapter: ProviderAdapter;
  asked: string[];
  verifyCalls: { modelHint?: string }[];
  listCalls: number;
}

function stub(o: StubOpts = {}): Stub {
  const asked: string[] = [];
  const verifyCalls: { modelHint?: string }[] = [];
  const result = o.verify ?? listResult(['one', 'two']);
  const pings = [...(o.pings ?? [])];
  const s: Stub = {
    asked,
    verifyCalls,
    listCalls: 0,
    adapter: {
      id: o.id ?? 'openai',
      openStream: vi.fn(),
      completeText: vi.fn(),
      verify: vi.fn(async (_creds, opts) => {
        verifyCalls.push({ modelHint: opts.modelHint });
        if (result instanceof ProviderError) throw result;
        return result;
      }),
      listModels: vi.fn(async () => {
        s.listCalls += 1;
        return o.list ?? listResult(['free-a', 'free-b']);
      }),
      ping: vi.fn(async (_creds, m: string) => {
        asked.push(m);
        const next = pings.length > 0 ? pings.shift() : null;
        if (next === null || next === undefined) return;
        throw next instanceof ProviderError ? next : new ProviderError(next);
      }),
      pickDefaultModel: o.pickDefault ?? ((r) => r.models[0]?.id ?? null),
    } as unknown as ProviderAdapter,
  };
  return s;
}

const creds = (provider: ModelProviderId = 'openai'): ProviderCredentials => ({
  provider,
  apiKey: 'k',
  baseUrl: 'https://api.test',
});

function opts(over: Partial<CheckOptions> = {}): CheckOptions {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + BUDGET,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('checkConnection: what is asked', () => {
  it('asks the hint, else the adapter default, and reports the model it asked', async () => {
    const hinted = stub();
    const a = await checkConnection(hinted.adapter, creds(), opts({ modelHint: 'two' }));
    expect(a.model).toBe('two');
    expect(a.ping).toEqual({ ok: true });
    expect(hinted.asked).toEqual(['two']);
    // The hint reaches verify too: a custom host probes it there.
    expect(hinted.verifyCalls).toEqual([{ modelHint: 'two' }]);

    const plain = stub();
    const b = await checkConnection(plain.adapter, creds(), opts());
    expect(b.model).toBe('one');
    expect(plain.asked).toEqual(['one']);
    expect(plain.verifyCalls).toEqual([{ modelHint: undefined }]);
  });

  it('`choose` decides, over both the hint and the default', async () => {
    const s = stub();
    const seen: VerifyResult[] = [];
    const out = await checkConnection(
      s.adapter,
      creds(),
      opts({
        modelHint: 'two',
        choose: (r) => {
          seen.push(r);
          return 'kept';
        },
      })
    );
    expect(out.model).toBe('kept');
    expect(s.asked).toEqual(['kept']);
    expect(seen[0]?.models.map((m) => m.id)).toEqual(['one', 'two']);
  });

  it('nothing is asked when there is no model, or when the host is a custom one', async () => {
    const none = stub({ verify: listResult([], { listed: true }) });
    const a = await checkConnection(none.adapter, creds(), opts());
    expect(a.model).toBeNull();
    expect(a.ping).toEqual({ ok: true });
    expect(none.asked).toEqual([]);

    // A custom host's verify already asked its model, when it knew one.
    const custom = stub({ id: 'custom' });
    const b = await checkConnection(custom.adapter, creds('custom'), opts({ modelHint: 'local-7b' }));
    expect(b.model).toBe('local-7b');
    expect(b.ping).toEqual({ ok: true });
    expect(custom.asked).toEqual([]);
  });

  it('a verify failure throws, and nothing is asked', async () => {
    const s = stub({ verify: new ProviderError('auth', 401) });
    await expect(checkConnection(s.adapter, creds(), opts())).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
    });
    expect(s.asked).toEqual([]);
  });

  it('OpenRouter lists the catalog its key check does not, and keeps freeTier', async () => {
    const s = stub({
      id: 'openrouter',
      verify: { models: [], listed: false, freeTier: true },
      list: listResult(['x-free', 'y-free']),
    });
    const out = await checkConnection(s.adapter, creds('openrouter'), opts());
    expect(s.listCalls).toBe(1);
    expect(out.result.models.map((m) => m.id)).toEqual(['x-free', 'y-free']);
    expect(out.result.freeTier).toBe(true);
    expect(out.model).toBe('x-free');
  });
});

describe('checkConnection: what a failure means', () => {
  const PASSES: ProviderErrorKind[] = ['bad_request', 'bad_model', 'empty', 'refused', 'forbidden'];
  const FAILS: ProviderErrorKind[] = [
    'auth',
    'quota',
    'daily_limit',
    'region',
    'blocked_url',
    'model_required',
    'aborted',
  ];

  it.each(PASSES)('%s is the model\'s business, so the key passes', async (kind) => {
    const s = stub({ pings: [kind] });
    const out = await checkConnection(s.adapter, creds(), opts({ modelHint: 'two' }));
    expect(out.ping).toEqual({ ok: true });
    expect(out.model).toBe('two');
    // A pass is never worth a second ask.
    expect(s.asked).toEqual(['two']);
  });

  it.each(FAILS)('%s comes back as the failure it is', async (kind) => {
    const s = stub({ pings: [kind] });
    const out = await checkConnection(s.adapter, creds(), opts({ modelHint: 'two' }));
    expect(out.ping.ok).toBe(false);
    expect(out.ping.ok === false && out.ping.error.kind).toBe(kind);
    expect(out.model).toBe('two');
    expect(s.asked).toEqual(['two']);
  });

  it('keeps the status and the reset time of the error it reports', async () => {
    const at = new Date(NOW + 3 * 3_600_000).toISOString();
    const s = stub({ pings: [new ProviderError('daily_limit', 429, at)] });
    const out = await checkConnection(s.adapter, creds(), opts());
    expect(out.ping.ok === false && out.ping.error.status).toBe(429);
    expect(out.ping.ok === false && out.ping.error.resetAt).toBe(at);
  });

  it('a transient failure that carries a reset time is not retried', async () => {
    const at = new Date(NOW + 3 * 3_600_000).toISOString();
    const s = stub({ pings: [new ProviderError('rate_limit', 429, at), null] });
    const out = await checkConnection(s.adapter, creds(), opts());
    expect(s.asked).toEqual(['one']);
    expect(out.ping.ok === false && out.ping.error.kind).toBe('rate_limit');
  });
});

describe('checkConnection: the transient retry', () => {
  const run = (s: Stub, over: Partial<CheckOptions> = {}) => {
    const p = checkConnection(s.adapter, creds(), opts(over));
    // The pause is the only timer; the asks themselves resolve as microtasks.
    return { p, settle: async () => { await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS); return p; } };
  };

  it('asks the same model once more, after the fixed pause', async () => {
    const s = stub({ pings: ['upstream', null] });
    const { settle } = run(s);
    const out = await settle();
    expect(s.asked).toEqual(['one', 'one']);
    expect(out.ping).toEqual({ ok: true });
    expect(out.model).toBe('one');
  });

  it.each(['rate_limit', 'upstream', 'timeout', 'network'] as ProviderErrorKind[])(
    '%s is worth one more ask',
    async (kind) => {
      const s = stub({ pings: [kind, null] });
      const { settle } = run(s);
      expect((await settle()).ping).toEqual({ ok: true });
      expect(s.asked).toHaveLength(2);
    }
  );

  it('a second failure is the one reported, judged like a first', async () => {
    const s = stub({ pings: ['network', 'auth'] });
    const { settle } = run(s);
    const out = await settle();
    expect(out.ping.ok === false && out.ping.error.kind).toBe('auth');

    const passing = stub({ pings: ['network', 'bad_request'] });
    const second = run(passing);
    expect((await second.settle()).ping).toEqual({ ok: true });
  });

  it('is skipped when the deadline leaves no room for a whole attempt', async () => {
    const tight = stub({ pings: ['upstream', null] });
    const out = await checkConnection(
      tight.adapter,
      creds(),
      opts({ deadline: Date.now() + RETRY_MIN_MS + RETRY_PAUSE_MS - 1 })
    );
    expect(tight.asked).toEqual(['one']);
    expect(out.ping.ok === false && out.ping.error.kind).toBe('upstream');
  });

  it('is skipped once the signal has aborted', async () => {
    const ac = new AbortController();
    const s = stub({ pings: ['network', null] });
    ac.abort();
    const out = await checkConnection(s.adapter, creds(), opts({ signal: ac.signal }));
    expect(s.asked).toEqual(['one']);
    expect(out.ping.ok === false && out.ping.error.kind).toBe('network');
  });

  it('a signal that aborts during the pause ends it at once, with no second ask', async () => {
    const ac = new AbortController();
    const s = stub({ pings: ['network', null] });
    let settled = false;
    const p = checkConnection(s.adapter, creds(), opts({ signal: ac.signal })).then((out) => {
      settled = true;
      return out;
    });
    // Halfway through the pause: the first ask failed, the second waits.
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS / 2);
    expect(settled).toBe(false);
    expect(s.asked).toEqual(['one']);

    ac.abort();
    // No time passes: only the abort can end the pause now.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    const out = await p;
    expect(s.asked).toEqual(['one']);
    expect(out.ping.ok === false && out.ping.error.kind).toBe('network');
  });
});

describe('checkConnection: Anthropic 400s', () => {
  const anthropic = (o: StubOpts = {}) =>
    stub({ id: 'anthropic', verify: listResult(['default-model', 'picked-model']), ...o });

  it('tries the account default before blaming the account', async () => {
    const s = anthropic({ pings: ['bad_request', null] });
    const out = await checkConnection(s.adapter, creds('anthropic'), opts({ modelHint: 'picked-model' }));
    expect(s.asked).toEqual(['picked-model', 'default-model']);
    // The default answered, so the account is fine and the picked model stays.
    expect(out.ping).toEqual({ ok: true });
    expect(out.model).toBe('picked-model');
  });

  it('a default that balks at itself still clears the account', async () => {
    const s = anthropic({ pings: ['bad_request', 'bad_model'] });
    const out = await checkConnection(s.adapter, creds('anthropic'), opts({ modelHint: 'picked-model' }));
    expect(out.ping).toEqual({ ok: true });
    expect(out.model).toBe('picked-model');
  });

  it('two 400s read as no credit', async () => {
    const s = anthropic({ pings: [new ProviderError('bad_request', 400), 'bad_request'] });
    const out = await checkConnection(s.adapter, creds('anthropic'), opts({ modelHint: 'picked-model' }));
    expect(s.asked).toEqual(['picked-model', 'default-model']);
    expect(out.ping.ok === false && out.ping.error.kind).toBe('quota');
    expect(out.ping.ok === false && out.ping.error.status).toBe(400);
    expect(out.ping.ok === false && out.ping.error.message).toBe(new ProviderError('quota').message);
  });

  it('what the default says about the key is reported as it is', async () => {
    const s = anthropic({ pings: ['bad_request', 'auth'] });
    const out = await checkConnection(s.adapter, creds('anthropic'), opts({ modelHint: 'picked-model' }));
    expect(out.ping.ok === false && out.ping.error.kind).toBe('auth');
  });

  it('a 400 on the default itself is the account, with no second ask', async () => {
    const s = anthropic({ pings: ['bad_request', null] });
    const out = await checkConnection(s.adapter, creds('anthropic'), opts({ modelHint: 'default-model' }));
    expect(s.asked).toEqual(['default-model']);
    expect(out.ping.ok === false && out.ping.error.kind).toBe('quota');
  });

  it.each(['rate_limit', 'upstream', 'timeout', 'network'] as ProviderErrorKind[])(
    'a 400 on the retry after %s is still the account',
    async (kind) => {
      const s = anthropic({ pings: [kind, new ProviderError('bad_request', 400)] });
      const p = checkConnection(s.adapter, creds('anthropic'), opts({ modelHint: 'default-model' }));
      await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS);
      const out = await p;
      expect(s.asked).toEqual(['default-model', 'default-model']);
      expect(out.ping.ok === false && out.ping.error.kind).toBe('quota');
      expect(out.ping.ok === false && out.ping.error.status).toBe(400);
    }
  );

  it('a picked model\'s 400 on the retry still gets the default\'s word first', async () => {
    const s = anthropic({ pings: ['upstream', 'bad_request', null] });
    const p = checkConnection(s.adapter, creds('anthropic'), opts({ modelHint: 'picked-model' }));
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS);
    const out = await p;
    expect(s.asked).toEqual(['picked-model', 'picked-model', 'default-model']);
    expect(out.ping).toEqual({ ok: true });
    expect(out.model).toBe('picked-model');
  });

  it('no room before the deadline means no second ask', async () => {
    const s = anthropic({ pings: ['bad_request', null] });
    const out = await checkConnection(
      s.adapter,
      creds('anthropic'),
      opts({ modelHint: 'picked-model', deadline: Date.now() + RETRY_MIN_MS - 1 })
    );
    expect(s.asked).toEqual(['picked-model']);
    expect(out.ping.ok === false && out.ping.error.kind).toBe('quota');
  });

  it('is Anthropic only: elsewhere a 400 is the model\'s, and the key passes', async () => {
    const s = stub({ pings: ['bad_request'] });
    const out = await checkConnection(s.adapter, creds(), opts({ modelHint: 'two' }));
    expect(out.ping).toEqual({ ok: true });
    expect(s.asked).toEqual(['two']);
  });
});

describe('checkConnection: OpenRouter free models', () => {
  const free = (o: StubOpts = {}): Stub =>
    stub({
      id: 'openrouter',
      verify: { models: [], listed: false, freeTier: true },
      list: {
        models: [model('a:free', { free: true }), model('b:free', { free: true }), model('c', { free: false })],
        listed: true,
      },
      ...o,
    });

  it('moves to the next free default and saves the one that answered', async () => {
    const s = free({ pings: ['rate_limit', null] });
    const out = await checkConnection(s.adapter, creds('openrouter'), opts());
    expect(s.asked).toEqual(['a:free', 'b:free']);
    expect(out.ping).toEqual({ ok: true });
    expect(out.model).toBe('b:free');
  });

  it('a model nobody can reach falls back to judging the first failure', async () => {
    const s = free({ pings: ['bad_model', 'rate_limit'] });
    const out = await checkConnection(s.adapter, creds('openrouter'), opts());
    expect(s.asked).toEqual(['a:free', 'b:free']);
    // bad_model passes: the key answered, the picker opens on the list.
    expect(out.ping).toEqual({ ok: true });
    expect(out.model).toBe('a:free');

    const hard = free({ pings: ['upstream', 'upstream'] });
    const out2 = await checkConnection(hard.adapter, creds('openrouter'), opts());
    expect(out2.ping.ok === false && out2.ping.error.kind).toBe('upstream');
    // The same-model retry is not taken on top of the fallback.
    expect(hard.asked).toEqual(['a:free', 'b:free']);
  });

  it('only a listed free model is worth the second ask', async () => {
    const s = stub({
      id: 'openrouter',
      verify: { models: [], listed: false, freeTier: true },
      list: { models: [model('a:free', { free: true }), model('paid')], listed: true },
      pings: ['rate_limit', null],
    });
    const pending = checkConnection(s.adapter, creds('openrouter'), opts());
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS);
    const out = await pending;
    // No free model left, so this is the ordinary transient retry: same model.
    expect(s.asked).toEqual(['a:free', 'a:free']);
    expect(out.model).toBe('a:free');
  });

  it('is not taken for a model the person kept, nor off the free tier', async () => {
    const kept = free({ pings: ['rate_limit', null] });
    const keptRun = checkConnection(kept.adapter, creds('openrouter'), opts({ choose: () => 'b:free' }));
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS);
    expect((await keptRun).model).toBe('b:free');
    expect(kept.asked).toEqual(['b:free', 'b:free']);

    const paid = free({
      verify: { models: [], listed: false, freeTier: false },
      pings: ['rate_limit', null],
    });
    const paidRun = checkConnection(paid.adapter, creds('openrouter'), opts());
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS);
    expect((await paidRun).model).toBe('a:free');
    expect(paid.asked).toEqual(['a:free', 'a:free']);
  });
});
