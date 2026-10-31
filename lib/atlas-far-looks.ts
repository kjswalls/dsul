import { ATLAS_COPY } from './atlas-copy';

/**
 * How Atlas's far zoom looks on a light theme (design PR3, D11). Bloom keeps
 * the paper and paints each cluster in a watercolour wash; Dusk drops the
 * board to slate while zoomed out, so the tiles glow as they do at night.
 *
 * Device only for now: the pick lives in look-store and this device's
 * localStorage (`ATLAS_FAR_PAPER_STORAGE_KEY`). Migration 087 adds
 * `user_settings.atlas_far_paper`, but nothing reads or writes it until a
 * follow-up that lands once 087 is on prod (the pending-column fallback in
 * lib/settings-service.ts is all or nothing, so naming it early would reset
 * every user's settings on every load).
 */
export type AtlasFarPaper = 'bloom' | 'dusk';

export const ATLAS_FAR_PAPER: readonly { value: AtlasFarPaper; label: string }[] = [
  { value: 'bloom', label: ATLAS_COPY.farBloom },
  { value: 'dusk', label: ATLAS_COPY.farDusk },
];

export const DEFAULT_ATLAS_FAR_PAPER: AtlasFarPaper = 'bloom';

/** Raw localStorage key, a bare string like LAYOUT_STORAGE_KEY. */
export const ATLAS_FAR_PAPER_STORAGE_KEY = 'dsul-atlas-far-paper';

export function isAtlasFarPaper(v: unknown): v is AtlasFarPaper {
  return v === 'bloom' || v === 'dusk';
}
