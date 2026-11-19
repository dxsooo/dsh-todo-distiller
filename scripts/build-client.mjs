// Bundle src/client into dist/client.js in the DSH client-module format:
// window.__ModuleLoader__.load({ id, factory(require) }) where `require`
// resolves the host's platform modules (react, react/jsx-runtime, ...).
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// Mirrors PLATFORM_MODULES in DSH packages/client/web/src/platform.ts.
const PLATFORM_MODULES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives']

const result = await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  write: false,
  minify: false,
  legalComments: 'none',
})
const code = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${code}\nreturn module.exports}})\n`
writeFileSync(join(root, 'dist/client.js'), wrapped)
console.log(`wrote dist/client.js (${wrapped.length} bytes)`)
