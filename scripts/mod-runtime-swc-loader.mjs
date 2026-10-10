/**
 * The webpack loader scripts/build-mod-runtime.mjs compiles the mod worker's
 * TypeScript with: Next's own swc binding, so the build needs no bundler or
 * compiler of its own. If a Next upgrade moves `next/dist/build/swc`, the
 * build fails loudly; the fix then is an esbuild devDependency (which needs
 * Kirby's OK, as quickjs-emscripten did).
 *
 * An ES module rather than .cjs: the repo's lint config covers .mjs, and a
 * .cjs file falls outside the files its plugins are declared for.
 */
import { createRequire } from 'node:module';

const { loadBindings, transform } = createRequire(import.meta.url)('next/dist/build/swc');

let bindings = null;

export default function modRuntimeSwcLoader(source) {
  const callback = this.async();
  bindings ??= loadBindings();
  bindings
    .then(() =>
      transform(source, {
        filename: this.resourcePath,
        jsc: { parser: { syntax: 'typescript' }, target: 'es2020' },
        module: { type: 'es6' },
      })
    )
    .then((out) => callback(null, out.code), callback);
}
