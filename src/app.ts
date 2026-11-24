// Host half of the page: HTTP routes under /todo-distiller. Each dropped
// document becomes a queued run processed in today's Session (src/runner.ts).
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-storage-domain'
import Schema from '@deepseek-ai/schemastery'
import { defaultWorkspaceDir, Runner } from './runner.ts'
import { STORE } from './store.ts'
import type { ItemRecord, RunRecord } from './store.ts'

export const name = 'dsh-todo-distiller-app'
export const inject = ['webServer', 'agents', 'agentDefaultModel', 'tools', 'systemPrompt', 'subprocess', 'storageDomain', 'workspaceRegistry', 'attachments', 'llm']

export interface Config {
  /** Reminders list that receives the items; created when missing. */
  list: string
  /** Deadline for one Reminders write, including the first-run macOS permission prompt. */
  timeoutMs: number
  /** Largest accepted text document body in bytes. */
  maxBytes: number
  /** Largest accepted image in bytes. */
  maxImageBytes: number
  /** Directory of the dedicated Workspace; empty means `$DSH_HOME/todo-distiller/workspace`. */
  workspaceDir: string
  /** Number of most recent runs the page lists. */
  pageSize: number
  /** Dated open items older than this many days are left out of the 已有事项 index. */
  indexLookbackDays: number
  /** Maximum number of items in the 已有事项 index given to each new daily Session. */
  indexLimit: number
  /** Write items to macOS Reminders; false keeps them only in the item store. */
  writeReminders: boolean
}

export const Config: Schema<Config> = Schema.object({
  list: Schema.string().default('DSH 助理'),
  timeoutMs: Schema.number().min(1000).default(120000),
  maxBytes: Schema.number().min(1024).default(2 * 1024 * 1024),
  maxImageBytes: Schema.number().min(1024).default(10 * 1024 * 1024),
  workspaceDir: Schema.string().default(''),
  pageSize: Schema.number().min(1).default(50),
  indexLookbackDays: Schema.number().min(0).default(30),
  indexLimit: Schema.number().min(0).default(100),
  writeReminders: Schema.boolean().default(true),
})

const ROUTE = '/todo-distiller'

export interface ItemView extends Omit<ItemRecord, 'related'> {
  related: Array<ItemRecord['related'][number] & { title: string | null, day: string | null }>
}
export interface RunView extends RunRecord { items: ItemView[] }

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const IMAGE_TYPES: Readonly<Record<string, ImageMediaType>> = {
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > maxBytes) throw Object.assign(new Error(`文档超过 ${maxBytes} 字节`), { status: 413 })
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

export async function apply(ctx: Context, config: Config) {
  const store = await ctx.storageDomain.open(STORE)
  const runner = new Runner(ctx, store, {
    reminders: { list: config.list, timeoutMs: config.timeoutMs },
    workspaceDir: config.workspaceDir === '' ? defaultWorkspaceDir() : config.workspaceDir,
    workspaceTitle: '待办助理',
    indexLookbackDays: config.indexLookbackDays,
    indexLimit: config.indexLimit,
    writeReminders: config.writeReminders,
  })
  ctx.effect(() => () => {
    void runner.dispose().finally(() => store.close())
  }, 'todo-distiller: runner')

  // Runs interrupted by a restart never finish; mark them so the page does not wait forever.
  for (const [id, run] of store.table('runs').entries()) {
    if (run.state === 'queued' || run.state === 'running') {
      await store.table('runs').put(id, { ...run, state: 'error', error: 'DSH 重启,处理中断,请重新拖入' })
    }
  }

  function listRuns(): RunView[] {
    const runs = [...store.table('runs').entries()].map(([, r]) => r)
      .sort((a, b) => b.createdMs - a.createdMs || b.createdAt.localeCompare(a.createdAt))
      .slice(0, config.pageSize)
    const wanted = new Set(runs.map(r => r.id))
    const table = store.table('items')
    const items = new Map<string, ItemView[]>()
    for (const [, item] of table.entries()) {
      if (!wanted.has(item.runId)) continue
      const list = items.get(item.runId) ?? []
      list.push({ ...item, related: item.related.map(r => ({ ...r, title: table.get(r.itemId)?.title ?? null, day: table.get(r.itemId)?.day ?? null })) })
      items.set(item.runId, list)
    }
    return runs.map(r => ({ ...r, items: items.get(r.id) ?? [] }))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      try {
        const path = new URL(req.url ?? '/', 'http://local').pathname.slice(ROUTE.length).replace(/^\/+/, '')
        if (req.method === 'GET' && path === 'ping') {
          return json(res, 200, { ok: true, platform: process.platform, writeReminders: process.platform === 'darwin' && config.writeReminders, model: ctx.agentDefaultModel.currentSelection() ?? null })
        }
        if (req.method === 'GET' && path === 'runs') return json(res, 200, { runs: listRuns() })
        if (req.method === 'POST' && path === 'runs') {
          const docName = decodeURIComponent(String(req.headers['x-todo-distiller-name'] ?? '未命名'))
          const contentType = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
          if (contentType.startsWith('image/')) {
            const mediaType = IMAGE_TYPES[contentType]
            if (mediaType === undefined) return json(res, 415, { error: `不支持的图片格式:${contentType}` })
            const data = await readBody(req, config.maxImageBytes)
            if (data.length === 0) return json(res, 400, { error: '文档为空' })
            const run = await runner.submit(docName, { kind: 'image', data, mediaType })
            return json(res, 202, { run: { ...run, items: [] } })
          }
          const text = (await readBody(req, config.maxBytes)).toString('utf8')
          if (text.trim() === '') return json(res, 400, { error: '文档为空' })
          const run = await runner.submit(docName, { kind: 'text', text })
          return json(res, 202, { run: { ...run, items: [] } })
        }
        const rewrite = /^runs\/([\w-]+)\/write$/.exec(path)
        if (req.method === 'POST' && rewrite !== null) {
          const run = await runner.rewrite(rewrite[1]!)
          return json(res, 200, { run: listRuns().find(r => r.id === run.id) ?? { ...run, items: [] } })
        }
        return json(res, 404, { error: 'not found' })
      } catch (error) {
        ctx.logger.warn('[todo-distiller] request failed: %s', error instanceof Error ? error.stack ?? error.message : String(error))
        if (!res.headersSent) json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) })
        else res.end()
      }
    },
  }), 'todo-distiller: routes')
}
