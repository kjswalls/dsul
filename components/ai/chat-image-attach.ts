'use client';

import {
  CHAT_IMAGE_TYPES,
  IMAGE_LONG_EDGE_PX,
  MAX_IMAGE_DATA_CHARS,
  type ChatImage,
} from '@/lib/chat-images';

/**
 * A picked or pasted picture, made ready to send (lib/chat-images.ts): drawn
 * onto a canvas no longer than IMAGE_LONG_EDGE_PX on its long edge, over white
 * (a transparent PNG would otherwise turn black), and re-encoded as JPEG. That
 * one step bounds the size, strips the file's metadata (a phone photo's
 * location goes nowhere), and gives every provider a type it takes. A GIF
 * sends its first frame.
 *
 * Never rejects: a file that is not a picture, or one the browser cannot
 * decode, comes back as the reason, in the words the box shows.
 */

export type AttachResult = { ok: true; image: ChatImage } | { ok: false; reason: string };

export const ATTACH_COPY = Object.freeze({
  notImage: 'Only pictures can be attached (JPEG, PNG, WebP or GIF).',
  unreadable: 'Couldn’t read that picture.',
  tooLarge: 'That picture is too large to send.',
  tooMany: (max: number) => `At most ${max} pictures on one message.`,
});

const QUALITY = 0.85;

export async function readChatImage(file: File): Promise<AttachResult> {
  if (!(CHAT_IMAGE_TYPES as readonly string[]).includes(file.type)) return { ok: false, reason: ATTACH_COPY.notImage };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: ATTACH_COPY.unreadable };
  }
  try {
    const scale = Math.min(1, IMAGE_LONG_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (!g) return { ok: false, reason: ATTACH_COPY.unreadable };
    g.fillStyle = '#fff';
    g.fillRect(0, 0, width, height);
    g.drawImage(bitmap, 0, 0, width, height);
    const url = canvas.toDataURL('image/jpeg', QUALITY);
    const data = url.slice(url.indexOf(',') + 1);
    if (!url.startsWith('data:image/jpeg;base64,') || !data) return { ok: false, reason: ATTACH_COPY.unreadable };
    if (data.length > MAX_IMAGE_DATA_CHARS) return { ok: false, reason: ATTACH_COPY.tooLarge };
    return { ok: true, image: { mediaType: 'image/jpeg', data } };
  } finally {
    bitmap.close();
  }
}
