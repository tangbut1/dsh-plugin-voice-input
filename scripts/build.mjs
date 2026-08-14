/**
 * Build both halves of dsh-plugin-voice-input with esbuild:
 *  - lib/index.js  host half: ESM, node platform, sherpa-onnx-node external
 *                  (native addon must resolve from node_modules at runtime).
 *  - lib/client.js browser half: CJS closure-factory artifact consumed by the
 *                  web shell's window.__ModuleLoader__ (same banner/footer/
 *                  intro contract as the repo's tsdown client bundles); react
 *                  stays external because the shell seeds it in the module
 *                  table.
 */
import { build } from 'esbuild'

const PACKAGE_ID = 'dsh-plugin-voice-input'

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'lib/index.js',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['sherpa-onnx-node', 'node:*'],
  sourcemap: true,
  logLevel: 'info',
})

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  outfile: 'lib/client.js',
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110', 'firefox115', 'safari16', 'edge110'],
  external: ['react', 'react/jsx-runtime'],
  sourcemap: true,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n`,
  },
  footer: { js: 'return module.exports; } });\n' },
  logLevel: 'info',
})
