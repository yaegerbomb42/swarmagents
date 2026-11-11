// Bundles src/swarmagents-bridge.ts (and the slice of the Omnexx runtime it uses) into one
// self-contained ESM file, dist/bridge.mjs, that the web control plane loads at runtime.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

/**
 * Heavy tooling the bridge's code paths never call (the lint gate, the TS compiler, the TUI).
 * Each is replaced by a stub that throws if used, so the bundle loads with no node_modules.
 */
const STUBBED = /^(eslint|typescript|web-tree-sitter|ink|react)$/;
const stubUnused = {
  name: 'stub-unused',
  setup(b) {
    b.onResolve({ filter: STUBBED }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      contents: `const fail = () => { throw new Error('${'$'}{JSON.stringify(a.path)} is not bundled into the Omnexx bridge'); };
const stub = new Proxy(function () {}, { get: (_t, k) => (k === '__esModule' ? true : k === 'then' ? undefined : stub), apply: fail, construct: fail });
export default stub; export const ESLint = stub;`,
      loader: 'js',
    }));
  },
};

mkdirSync('dist', { recursive: true });
const result = await build({
  entryPoints: ['src/swarmagents-bridge.ts'],
  outfile: 'dist/bridge.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minify: false,
  external: ['node:sqlite'],
  plugins: [stubUnused],
  // Lets bundled CommonJS deps call require() inside an ES module.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  metafile: true,
  logLevel: 'warning',
});
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`bridge bundle: dist/bridge.mjs (${(bytes / 1024).toFixed(0)} KiB, ${Object.keys(result.metafile.inputs).length} inputs)`);
