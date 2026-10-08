import { type Locator, type Page, type Response } from '@playwright/test';
import { BASE_URL } from './env';

/**
 * The AI, faked in the browser and saved for real.
 *
 * Never a real provider: the gate's answer (`GET /api/ai/connection`) and the
 * chat stream (`/api/chat`) are both answered by `page.route`, so no model key
 * is read and nothing leaves the machine. The conversations routes are NOT
 * stubbed: a finished turn is saved through the real `POST
 * /api/ai/conversations/<id>/turns` into the local stack's 057 tables, which
 * is the point of the specs that use this.
 *
 * Install the stubs BEFORE the navigation that reads them. The gate is asked
 * once, at sign-in (lib/ai-connection-store.ts), so a route added after the
 * page loaded changes nothing until the next load; and while the answer is
 * still unknown every AI surface is hidden, so a spec that does not wait for
 * it (`gateAnswered`) asserts the fail-closed moment instead of the answer.
 */

/**
 * The model id the stubbed gate reports. The answerer label under Ask's box
 * names it from the catalog (lib/ai-model-names.ts): "GPT-4o mini".
 */
export const STUB_MODEL = 'gpt-4o-mini';

/**
 * Keys `stubAIGate` answers without asking anyone, in Google's `AQ.` form so a
 * paste sends at once (lib/ai-key-prefix.ts). Not keys anyone issued: the
 * stub goes by the prefix alone, and a spec asserts neither ever lands in the
 * page's markup.
 */
export const STUB_GOOD_KEY = 'AQ.good-e2e-stub-not-a-key';
export const STUB_BAD_KEY = 'AQ.bad-e2e-stub-not-a-key';

/** The model a key `stubAIGate` accepts connects with, as Google's check would pick it. */
export const STUB_GEMINI_MODEL = 'gemini-flash-latest';

/** What the stub's check makes of a Gemini key, either of Google's forms: `AQ.good…`, `AIzabad…`. */
const STUB_VERDICT = /^(?:AQ\.|AIza)(good|bad)/;

/**
 * Answer the gate "a model is connected and working", for every load of this
 * page. `agent: true` also reports a paired OpenClaw agent (`canDelegate`),
 * which is what lets an item be handed off.
 */
export async function stubConnectedModel(page: Page, o: { agent?: boolean } = {}): Promise<void> {
  await page.route('**/api/ai/connection', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        available: true,
        model: {
          provider: 'openai',
          model: STUB_MODEL,
          baseUrl: null,
          authMethod: 'key',
          status: 'ok',
          problem: null,
          checkedAt: '2026-10-01T00:00:00.000Z',
        },
        openclaw: { gateway: false, pluginChat: false, agent: !!o.agent, agentId: null },
      }),
    })
  );
}

/** What `stubAIGate` was asked, and what it now answers. */
export type GateStub = {
  /** Every PATCH body the app sent, in order. */
  patches: Array<Record<string, unknown>>;
  /**
   * Every connect (PUT) the app sent, in order: which provider, and whether
   * the stub took the key. Never the key itself.
   */
  connects: Array<{ provider: unknown; accepted: boolean }>;
  /** The account's "No AI, thanks", as the stub now answers it. */
  hidden(): boolean;
};

/**
 * Answer the gate "nothing answers here, and AI may be offered", for every
 * load of this page: no OpenClaw at all, and either no model (`model: 'none'`,
 * the unlit "Set up AI" key) or a saved Gemini key its provider turned down
 * (`model: 'failing'`, "Fix AI").
 *
 * Stateful, because "No AI, thanks" and a connect are account writes: PATCH
 * `{hidden}` and a PUT are answered here and the next GET says what they
 * wrote, so a reload sees it. The real route is never reached. The e2e account
 * is shared by every parallel spec: a real `ai_hidden = true` on it would take
 * AI away from all of them, and a real connect would save a key to it and
 * light AI for all of them. `aiHidden` is always sent as a boolean: null (a
 * server that has not said) invites nobody.
 *
 * A connect is checked on the key's prefix alone: `STUB_GOOD_KEY` (any Gemini
 * key starting `AQ.good` or `AIzagood`) connects `STUB_GEMINI_MODEL`, working;
 * `STUB_BAD_KEY` (`AQ.bad…`, `AIzabad…`) is turned down as Google turns a
 * deleted key down (400 `key_rejected`), and the connection stays as it was.
 * Any other connect is refused as `invalid`.
 */
export async function stubAIGate(
  page: Page,
  o: { model?: 'none' | 'failing'; aiHidden?: boolean } = {}
): Promise<GateStub> {
  let hidden = o.aiHidden ?? false;
  const patches: GateStub['patches'] = [];
  const connects: GateStub['connects'] = [];
  let model: Record<string, unknown> | null =
    o.model === 'failing'
      ? {
          provider: 'gemini',
          model: STUB_GEMINI_MODEL,
          baseUrl: null,
          authMethod: 'key',
          status: 'failing',
          problem: 'key_rejected',
          checkedAt: '2026-10-01T00:00:00.000Z',
          limitedUntil: null,
          modelLabel: null,
        }
      : null;
  const json = (status: number, body: unknown) => ({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  });
  await page.route('**/api/ai/connection', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      return route.fulfill(
        json(200, {
          available: true,
          model,
          openclaw: { gateway: false, pluginChat: false, agent: false, agentId: null },
          aiHidden: hidden,
        })
      );
    }
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    if (req.method() === 'PUT') {
      // Read for its prefix and dropped: the key is never kept, not even here.
      const verdict =
        body.provider === 'gemini' && typeof body.apiKey === 'string'
          ? STUB_VERDICT.exec(body.apiKey)?.[1]
          : undefined;
      const accepted = verdict === 'good';
      connects.push({ provider: body.provider, accepted });
      if (accepted) {
        model = {
          provider: 'gemini',
          model: STUB_GEMINI_MODEL,
          baseUrl: null,
          authMethod: 'key',
          status: 'ok',
          problem: null,
          checkedAt: new Date().toISOString(),
          limitedUntil: null,
          modelLabel: null,
        };
        return route.fulfill(
          json(200, {
            connection: model,
            models: [{ id: STUB_GEMINI_MODEL, label: 'Gemini Flash' }],
            listed: true,
          })
        );
      }
      if (verdict === 'bad') return route.fulfill(json(400, { error: 'key_rejected' }));
      return route.fulfill(json(400, { error: 'invalid' }));
    }
    patches.push(body);
    if (req.method() === 'PATCH' && typeof body.hidden === 'boolean') {
      hidden = body.hidden;
      return route.fulfill(json(200, { aiHidden: hidden }));
    }
    // A fresh check, as the route answers it: the check was made, so 200,
    // with the connection as it stands (a key still turned down, still failing).
    if (req.method() === 'PATCH' && body.recheck === true && model) {
      return route.fulfill(json(200, { connection: model }));
    }
    // Anything else (a model pick, a disconnect) is not this stub's to
    // answer, and must not reach the real route either.
    return route.fulfill(json(400, { error: 'invalid' }));
  });
  return { patches, connects, hidden: () => hidden };
}

/**
 * Paste `text` into a key box, as Ctrl+V does: one `paste` event carrying it
 * as text/plain, which the box reads (components/ai/connect/key-field.tsx).
 * Dispatched in the page, so the system clipboard is never touched and no
 * permission prompt is involved.
 */
export async function pasteInto(field: Locator, text: string): Promise<void> {
  await field.focus();
  await field.evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

/** Answer every chat request with `reply`, in one chunk of the app's SSE. */
export async function stubChatReply(page: Page, reply: string): Promise<void> {
  await page.route('**/api/chat', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-store' },
      body: `data: ${JSON.stringify({ content: reply })}\n\ndata: [DONE]\n\n`,
    })
  );
}

/** The gate's answer arriving. Create it before the load, await it after. */
export function gateAnswered(page: Page): Promise<Response> {
  return page.waitForResponse(
    (r) => r.url().includes('/api/ai/connection') && r.request().method() === 'GET'
  );
}

const TURNS_PATH = /^\/api\/ai\/conversations\/[0-9a-f-]{36}\/turns$/;

/**
 * A finished turn's one save (lib/conversations-store.ts: question and reply
 * together, once the reply has ended, never per token). Create it before the
 * send. A reload before it lands would abort the save it is waiting for, and
 * the reload would then prove nothing.
 */
export function turnSaved(page: Page): Promise<Response> {
  return page.waitForResponse(
    (r) => r.request().method() === 'POST' && TURNS_PATH.test(new URL(r.url()).pathname)
  );
}

/** A PATCH (rename, star) or DELETE of one conversation answering. */
export function conversationWritten(
  page: Page,
  method: 'PATCH' | 'DELETE',
  id: string
): Promise<Response> {
  return page.waitForResponse(
    (r) =>
      r.request().method() === method &&
      new URL(r.url()).pathname === `/api/ai/conversations/${id}`
  );
}

/**
 * A word nothing else on the account contains, for a search to find a
 * conversation by: put in a stubbed reply, never in a title (a title comes
 * from testTitle, whose prefix is what the litter sweep looks for). Built
 * here, not in a spec: e2e-fixture-hygiene.test.ts keeps Date.now() out of
 * specs, where it is the tell of a hand-built title.
 */
export function uniqueWord(label: string): string {
  return `${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The desktop's right column: an item, or Ask. */
export function rail(page: Page): Locator {
  return page.locator('[data-rail]');
}

/** The Ask button on the canvas's header row, shown while Ask is closed. */
export function askButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Open Ask' });
}

/**
 * The same key while nothing answers: unlit, and named for what it opens
 * ("Set up AI", or "Fix AI" for a saved model that stopped working).
 */
export function unlitKey(page: Page): Locator {
  return page.locator('[data-ask-opener][data-lit="false"]');
}

/**
 * The box in `scope` that sends to the AI (Ask's, a conversation's, an
 * item's: each is "Message AI" to a screen reader). By role, so one that is
 * hidden under an item does not count.
 */
export function askBox(scope: Locator): Locator {
  return scope.getByRole('textbox', { name: 'Message AI' });
}

type SummaryRow = { id: string; title?: string };

/**
 * Delete every saved conversation whose title starts with `prefix`, through
 * the same routes the app uses (History's list, the row's DELETE), as the
 * signed-in test user. A spec that sends anything must call it in `finally`:
 * every finished turn is a row that outlives the test, and History lists them
 * all. Never throws: a cleanup failure is a warning, and globalSetup's sweep
 * is the backstop for a run aborted before its `finally`.
 *
 * `page.request` carries the context's session cookie and no Origin header,
 * which the routes' same-origin check reads as same-origin.
 */
export async function cleanupConversations(page: Page, prefix: string): Promise<void> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  // Starred rows come whole on the first page; the rest are paged newest first.
  for (let n = 0; n < 10; n++) {
    const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const res = await page.request.get(`${BASE_URL}/api/ai/conversations?limit=50${query}`);
    if (!res.ok()) {
      console.warn(`[cleanup] conversation list failed: ${res.status()}`);
      break;
    }
    const body = (await res.json()) as {
      conversations?: SummaryRow[];
      starred?: SummaryRow[];
      nextCursor?: string | null;
    };
    for (const c of [...(body.starred ?? []), ...(body.conversations ?? [])]) {
      if (c.title?.startsWith(prefix)) ids.add(c.id);
    }
    cursor = body.nextCursor ?? null;
    if (!cursor) break;
  }
  for (const id of ids) {
    const res = await page.request.delete(`${BASE_URL}/api/ai/conversations/${id}`);
    if (!res.ok() && res.status() !== 404) {
      console.warn(`[cleanup] conversation ${id} not deleted: ${res.status()}`);
    }
  }
}
