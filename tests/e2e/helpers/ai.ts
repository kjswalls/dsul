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

/** The model id the stubbed gate reports; the answerer label under Ask's box reads it. */
export const STUB_MODEL = 'gpt-4o-mini';

/** Answer the gate "a model is connected and working", for every load of this page. */
export async function stubConnectedModel(page: Page): Promise<void> {
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
        openclaw: { gateway: false, pluginChat: false, agent: false, agentId: null },
      }),
    })
  );
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
