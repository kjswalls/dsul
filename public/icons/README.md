# dsul icons

The mark is **Aurora**: a 4×4 patch of the RelayField with the ripple's crest lit along the
diagonal, in the field's dark-mode relay colours pushed brighter
(`components/primitives/relay-field.tsx`, the `.dark` accents in `app/globals.css`), on a dark
ground with a band of lime-to-teal light behind the crest. There is one colour version, dark
in light and dark mode alike, plus mono layers for iOS tinted and Android themed icons. The 16 and 32px favicons are small dots with room between
them and no glow; at 16px it is the 3×3 middle of the crest.

Everything here is generated. Edit `scripts/app-icon/mark.mjs`, then run

```bash
node scripts/app-icon/build.mjs                  # this folder, public/favicon.ico, electron/build, ios/'s AppIcon set
node scripts/app-icon/build.mjs --native <dir>   # plus the macOS iconset, Android layers and SVG masters
```

The 1024px store masters are only written by `--native`: the service worker precaches all of
`public/`, so nothing the web app doesn't load lives here.

It renders in Chromium (the Playwright one; set `CHROMIUM_PATH` to use another), because the halos use
`mix-blend-mode: plus-lighter`, which librsvg, sharp and Figma ignore.

| File | Size | Used for |
|------|------|---------|
| `icon-16.png`, `icon-32.png` | 16, 32 | Browser tab (rounded dark tile) |
| `icon-180.png` | 180 | iOS home screen (apple-touch-icon), full-bleed square |
| `icon-192.png`, `icon-512.png` | 192, 512 | Manifest, `purpose: "any maskable"`: full-bleed square, dots inside the 80% safe circle |
| `../favicon.ico` | 16, 32, 48 | Anything that asks for `/favicon.ico` by name |

Referenced from `app/layout.tsx` (`metadata.icons`), `public/manifest.json`, `app/sw.ts`
(notification icon) and the onboarding tour. Do not pre-round the square ones: the OS applies
its own mask.
