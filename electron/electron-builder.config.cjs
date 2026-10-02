'use strict';

// electron-builder's config, as JS rather than YAML because the macOS signing identity depends
// on whether a certificate was supplied. Used as `electron-builder --config
// electron-builder.config.cjs` by the npm scripts and .github/workflows/desktop-release.yml.
// See memory/plans/desktop-app.md, "Packaging and signing", for why each line is here.

// The release workflow exports CSC_LINK only when the secret is non-empty: an empty one counts
// as set and throws.
const signed = !!process.env.CSC_LINK;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  // Permanent once shipped: the macOS bundle id, the Windows AUMID and the NSIS GUID.
  appId: 'app.dsul.desktop',
  productName: 'dsul',

  directories: { output: 'release', buildResources: 'build' },
  // package.json goes in on its own. build/ is not packed except for the tray icons and the
  // run-time app icons (lib/app-icon.cjs), which the running app loads.
  files: ['main.cjs', 'preload.cjs', 'lib/**', 'offline.html', 'build/tray*', 'build/app-icon-*.png'],

  // From the first release. Cookie encryption is one-way: never turn it off once it has
  // shipped, or every user's cookie store (their session and the PKCE verifier) is unreadable.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },

  // Writes CFBundleURLTypes. It does nothing on Windows, where build/installer.nsh registers the
  // scheme instead.
  protocols: [{ name: 'dsul', schemes: ['dsul'] }],

  mac: {
    // arm64 only until an Intel Mac can test an x64 build.
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    category: 'public.app-category.productivity',
    icon: 'build/icon.png',
    // With no certificate there is no automatic ad-hoc signature, and an unsealed bundle is
    // "damaged" on Apple Silicon. '-' signs ad hoc; hardened runtime would then fail library
    // validation, so it comes on only with a real identity. Leave notarize unset: 26.x
    // notarizes on its own once it has signed and the APPLE_API_* variables are present.
    identity: signed ? undefined : '-',
    hardenedRuntime: signed,
    entitlements: signed ? 'build/entitlements.mac.plist' : undefined,
    entitlementsInherit: signed ? 'build/entitlements.mac.plist' : undefined,
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    // No version in the name, so releases/latest/download/dsul-setup.exe is a permanent link.
    artifactName: 'dsul-setup.${ext}',
    include: 'build/installer.nsh',
  },

  publish: [{ provider: 'github', owner: 'kjswalls', repo: 'dsul', releaseType: 'draft' }],
};
