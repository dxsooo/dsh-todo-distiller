// Generate dev.patch.yml from cordis.patch.yml, replacing this package's plugin
// names with absolute source paths so `dsh web --patch` loads the .ts directly.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const dev = text
  .replace(/name: '@dxsooo\/dsh-todo-distiller\/reminders'$/gm, `name: '${join(root, 'src/reminders.ts')}'`)
  .replace(/name: '@dxsooo\/dsh-todo-distiller'$/gm, `name: '${join(root, 'src/index.ts')}'`)
writeFileSync(join(root, 'dev.patch.yml'), dev)
console.log(`wrote ${join(root, 'dev.patch.yml')}`)
