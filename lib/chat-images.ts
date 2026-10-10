/**
 * Images in a chat message (AI step 2c): the shape, the limits, and the one
 * check the browser and /api/chat both apply.
 *
 * SENT, NEVER STORED. An image goes to the connected model with the message it
 * was attached to, for that turn only, and nothing keeps it: not the saved
 * conversation (chat_messages holds the words), not a bucket, not the server.
 * The transcript says "1 image" under the message for as long as this page
 * holds it, and a later turn, a retry or an edit sends words only. OpenClaw is
 * never sent one (its transports carry text).
 *
 * The browser shrinks each picture before it is attached
 * (components/ai/chat-image-attach.ts): its long edge to IMAGE_LONG_EDGE_PX,
 * re-encoded as JPEG, so a phone photo is a few hundred KB and three of them
 * fit inside the route's body cap with the transcript beside them.
 */

export const CHAT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type ChatImageType = (typeof CHAT_IMAGE_TYPES)[number];

export interface ChatImage {
  mediaType: ChatImageType;
  /** Base64, no `data:` prefix. */
  data: string;
}

/** At most this many images on one message. */
export const MAX_CHAT_IMAGES = 3;
/** One image's base64, at most (about 750 KB of picture). */
export const MAX_IMAGE_DATA_CHARS = 1_000_000;
/** The long edge an attached picture is shrunk to: what the providers scale to anyway. */
export const IMAGE_LONG_EDGE_PX = 1568;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The images a request carries, checked: an array of at most MAX_CHAT_IMAGES
 * `{mediaType, data}` of a listed type and size. Absent is none; anything else
 * malformed is null, which the route answers as a bad request rather than
 * quietly sending the words without the picture they are about.
 */
export function sanitizeChatImages(raw: unknown): ChatImage[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_CHAT_IMAGES) return null;
  const out: ChatImage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const { mediaType, data } = entry as { mediaType?: unknown; data?: unknown };
    if (typeof mediaType !== 'string' || !(CHAT_IMAGE_TYPES as readonly string[]).includes(mediaType)) return null;
    if (typeof data !== 'string' || data.length === 0 || data.length > MAX_IMAGE_DATA_CHARS) return null;
    if (data.length % 4 !== 0 || !BASE64.test(data)) return null;
    out.push({ mediaType: mediaType as ChatImageType, data });
  }
  return out;
}

/** A `data:` URL for an image, as the OpenAI-compatible APIs and an <img> take it. */
export function imageDataUrl(image: ChatImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

/** "1 image", "2 images": the line under a message that carried some. */
export function imageCountLabel(n: number): string {
  return n === 1 ? '1 image' : `${n} images`;
}
