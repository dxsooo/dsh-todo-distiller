// Generate dev.patch.yml from cordis.patch.yml, replacing this package's name
// with the absolute source path so `dsh web --patch` loads the .ts directly.
// The browser half still loads the built dist/client.js (`pnpm build:client`).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const dev = text.replace(/name: '@dxsooo\/dsh-todo-distiller'$/gm, `name: '${join(root, 'src/app.ts')}'`)
writeFileSync(join(root, 'dev.patch.yml'), dev)
console.log(`wrote ${join(root, 'dev.patch.yml')}`)
