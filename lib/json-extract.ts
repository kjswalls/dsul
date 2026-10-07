/**
 * Best-effort JSON object out of whatever a model actually said.
 *
 * The OpenAI branch can demand `json_object` and get it. A gateway agent is
 * some model behind some system prompt the user configured, and it may fence
 * the JSON, preface it ("Sure! Here's the plan:"), or append a sign-off. All
 * three are recoverable and all three would otherwise read to the user as "the
 * assistant is broken".
 *
 * Pure and client-safe: /api/ai/propose uses it on the server (through
 * lib/openclaw-gateway.ts's re-export) and Settings → Make's "Write with AI"
 * in the browser (lib/make-draft.ts).
 *
 * Returns null rather than throwing: upstream treats "nothing to suggest" as a
 * normal outcome, and an unparseable reply is indistinguishable from one.
 */
export function extractJsonObject(raw: string): unknown | null {
  const text = raw.trim()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    // Fall through to the substring attempt.
  }

  // Widest span that could be an object. Slicing to the LAST brace rather than
  // scanning for a balanced one keeps this to a few lines, and a trailing
  // sign-off after the JSON is far more common than a second object after it.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}
