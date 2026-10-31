import { ATLAS_COPY } from './atlas-copy';

/**
 * How Atlas's far zoom looks on a light theme (design PR3, D11). Bloom keeps
 * the paper and paints each cluster in a watercolour wash; Dusk drops the
 * board to slate while zoomed out, so the tiles glow as they do at night.
 *
 * Per account: `user_settings.atlas_far_paper` (migration 087) is the truth,
 * written by the Look record and applied by supabase-provider at sign-in.
 * look-store mirrors it to this device's localStorage
 * (`ATLAS_FAR_PAPER_STORAGE_KEY`) so the first paint is right before the row
 * loads. A null column means never chosen, and this device's pick stands.
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
