import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginConfig } from "./plugin-types.js";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { readBody } from "./webhook.js";
import { isValidChatToken, pluginChatToken } from "./chat-token.js";

const SESSION_KEY_PREFIX = "dsul-chat";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  // Required for Chrome's Private Network Access policy when a public origin
  // (Vercel) fetches directly to a private/Tailscale host.
  "Access-Control-Allow-Private-Network": "true",
};

export async function handleChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: PluginConfig,
  runtime: PluginRuntime,
  logger: { info: (s: string) => void; warn: (s: string) => void; error: (s: string) => void }
): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const authHeader = (req.headers["authorization"] as string | undefined) ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  // The bearer is the derived chat token, never the API key itself (#142):
  // dsul hands the browser only the token, so the key that reaches dsul's
  // agent API is never in a page. A raw key presented here is refused.
  if (!isValidChatToken(token, cfg.apiKey)) {
    res.writeHead(401, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  let message: string;
  let sessionKey: string;
  let extraContext: string | undefined;

  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw) as { message?: string; sessionKey?: string; context?: string };
    if (!body.message?.trim()) {
      res.writeHead(400, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing message" }));
      return;
    }
    message = body.message.trim();
    sessionKey = body.sessionKey ?? `${SESSION_KEY_PREFIX}:${pluginChatToken(cfg.apiKey).slice(-8)}`;
    extraContext = body.context;
  } catch {
    res.writeHead(400, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  // Single JSON response. This handler blocks on `waitForRun` until the agent
  // turn is complete, so there is nothing to stream incrementally — it used to
  // write SSE framing (`text/event-stream` + `data: …\n\n`) around exactly one
  // payload, which made clients implement a reader loop for no benefit. If real
  // token streaming lands later, reintroduce SSE deliberately on both ends.
  const send = (payload: { content: string } | { error: string }) => {
    if (res.headersSent) return;
    const body = JSON.stringify(payload);
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    res.end(body);
  };

  try {
    logger.info(`dsul-context: chat turn — session ${sessionKey}`);

    const { runId } = await runtime.subagent.run({
      sessionKey,
      message,
      idempotencyKey: `dsul-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...(extraContext ? { extraSystemPrompt: extraContext } : {}),
    });

    const result = await runtime.subagent.waitForRun({ runId, timeoutMs: 120_000 });

    if (result.status === "error") {
      logger.warn(`dsul-context: chat run errored — ${result.error ?? "unknown"}`);
      send({ error: result.error ?? "Agent run failed" });
      return;
    }

    const { messages } = await runtime.subagent.getSessionMessages({ sessionKey, limit: 10 });

    const lastAssistant = [...messages].reverse().find((m) => {
      const msg = m as Record<string, unknown>;
      return msg.role === "assistant";
    }) as Record<string, unknown> | undefined;

    if (!lastAssistant) {
      send({ error: "No response received" });
      return;
    }

    let text = "";
    const content = lastAssistant.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null)
        .filter((block) => block.type === "text")
        .map((block) => block.text as string)
        .join("");
    }

    if (text) {
      send({ content: text });
    } else {
      send({ error: "Empty response" });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error(`dsul-context: chat handler error — ${msg}`);
    send({ error: msg });
  } finally {
    // Safety net: never leave the socket open if some path above returned
    // without responding. `send` no-ops once headers are committed.
    send({ error: "No response received" });
  }
}
