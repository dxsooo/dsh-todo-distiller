// Host half of the page: HTTP routes under /todo-distiller. Each dropped
// document becomes a queued run processed in today's Session (src/runner.ts).
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-storage-domain'
import Schema from '@deepseek-ai/schemastery'
import { defaultWorkspaceDir, Runner } from './runner.ts'
import { STORE } from './store.ts'
import type { ItemRecord, RunRecord } from './store.ts'

export const name = 'dsh-todo-distiller-app'
export const inject = ['webServer', 'agents', 'agentDefaultModel', 'tools', 'systemPrompt', 'subprocess', 'storageDomain', 'workspaceRegistry']

export interface Config {
  /** Reminders list that receives the items; created when missing. */
  list: string
  /** Deadline for one Reminders write, including the first-run macOS permission prompt. */
  timeoutMs: number
  /** Largest accepted document body in bytes. */
  maxBytes: number
  /** Directory of the dedicated Workspace; empty means `$DSH_HOME/todo-distiller/workspace`. */
  workspaceDir: string
  /** Number of most recent runs the page lists. */
  pageSize: number
}

export const Config: Schema<Config> = Schema.object({
  list: Schema.string().default('DSH 助理'),
  timeoutMs: Schema.number().min(1000).default(120000),
  maxBytes: Schema.number().min(1024).default(2 * 1024 * 1024),
  workspaceDir: Schema.string().default(''),
  pageSize: Schema.number().min(1).default(50),
})

const ROUTE = '/todo-distiller'

export interface RunView extends RunRecord { items: ItemRecord[] }

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > maxBytes) throw Object.assign(new Error(`文档超过 ${maxBytes} 字节`), { status: 413 })
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function apply(ctx: Context, config: Config) {
  const store = await ctx.storageDomain.open(STORE)
  const runner = new Runner(ctx, store, {
    reminders: { list: config.list, timeoutMs: config.timeoutMs },
    workspaceDir: config.workspaceDir === '' ? defaultWorkspaceDir() : config.workspaceDir,
    workspaceTitle: '待办助理',
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
    const items = new Map<string, ItemRecord[]>()
    for (const [, item] of store.table('items').entries()) {
      if (!wanted.has(item.runId)) continue
      const list = items.get(item.runId) ?? []
      list.push(item)
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
          return json(res, 200, { ok: true, platform: process.platform, model: ctx.agentDefaultModel.currentSelection() ?? null })
        }
        if (req.method === 'GET' && path === 'runs') return json(res, 200, { runs: listRuns() })
        if (req.method === 'POST' && path === 'runs') {
          const docName = decodeURIComponent(String(req.headers['x-todo-distiller-name'] ?? '未命名'))
          const text = await readBody(req, config.maxBytes)
          if (text.trim() === '') return json(res, 400, { error: '文档为空' })
          const run = await runner.submit(docName, text)
          return json(res, 202, { run: { ...run, items: [] } })
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
