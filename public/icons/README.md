# dsul icons

The mark is **Wave**: a 4×4 patch of the RelayField with the ripple's crest lit along the
diagonal, in the field's dark-mode relay colours (`components/primitives/relay-field.tsx`,
the `.dark` accents in `app/globals.css`). It has a dark version (glowing on navy) and a light
version (the same relays as ink on paper, no glow). At 16px it is the 3×3 middle of the crest.

Everything here is generated. Edit `scripts/app-icon/mark.mjs`, then run

```bash
node scripts/app-icon/build.mjs                  # this folder and public/favicon.ico
node scripts/app-icon/build.mjs --native <dir>   # plus iOS, macOS, Android and Windows files
```

The 1024px store masters are only written by `--native`: the service worker precaches all of
`public/`, so nothing the web app doesn't load lives here.

It renders in Chromium (the Playwright one), because the halos use
`mix-blend-mode: plus-lighter`, which librsvg, sharp and Figma ignore.

| File | Size | Used for |
|------|------|---------|
| `icon-16.png`, `icon-32.png` | 16, 32 | Browser tab, dark system theme (rounded dark tile) |
| `icon-16-light.png`, `icon-32-light.png` | 16, 32 | Browser tab, light system theme |
| `icon-180.png` | 180 | iOS home screen (apple-touch-icon), full-bleed square |
| `icon-192.png`, `icon-512.png` | 192, 512 | Manifest, `purpose: "any maskable"`: full-bleed square, dots inside the 80% safe circle |
| `../favicon.ico` | 16, 32, 48 | Anything that asks for `/favicon.ico` by name |

Referenced from `app/layout.tsx` (`metadata.icons`), `public/manifest.json`, `app/sw.ts`
(notification icon) and the onboarding tour. Do not pre-round the square ones: the OS applies
its own mask.
