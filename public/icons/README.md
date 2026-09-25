# dsul PWA icons

The mark is the lucide `Zap` glyph in `--lime-ink` on a `--lime-solid` ground.
It was the login wordmark's lockup until the wordmark became a lowercase "dsul"
with a lime dot after it (`components/primitives/wordmark.tsx`); the icons still
carry the Zap.

These are **maskable** (`purpose: "any maskable"` in `public/manifest.json`), so
the ground fills the whole square and the glyph sits inside the centre 80%; the
OS applies its own corner mask. Do not pre-round the corners.

| File | Size | Purpose |
|------|------|---------|
| `icon-16.png`  | 16×16   | Browser favicon (small) |
| `icon-32.png`  | 32×32   | Browser favicon |
| `icon-180.png` | 180×180 | iOS home screen (apple-touch-icon) ✅ required |
| `icon-192.png` | 192×192 | Android/Chrome home screen (manifest) ✅ required |
| `icon-512.png` | 512×512 | Android splash screen (manifest) ✅ required |
| `icon-1024.png`| 1024×1024 | Future App Store submission 📦 optional |

Referenced from `app/layout.tsx` (`metadata.icons`) and `public/manifest.json`.
Replacing them is a drop-in: keep the filenames and sizes.
