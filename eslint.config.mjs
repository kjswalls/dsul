import { defineConfig, globalIgnores } from 'eslint/config';
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

export default defineConfig([
  globalIgnores([
    'node_modules/**',
    '.next/**',
    'public/**',
    'packages/**/dist/**',
    'openclaw-plugin/**',
    'electron/**',
    'ios/**',
    'memory/**',
    'playwright-report/**',
    'test-results/**',
    'push-test.js',
    'lib/mods/sandbox/generated/**',
  ]),
  coreWebVitals,
  typescript,
  {
    rules: {
      // TODO(redesign P8): re-escalate to error. Legacy sync-setState-in-effect
      // patterns live in components scheduled for rewrite in phases 2-5.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
]);
