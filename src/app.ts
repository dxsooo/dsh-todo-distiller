// Host half of the page: HTTP routes under /todo-distiller that run one
// Session per dropped document through the ordinary DSH Agent machinery.
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import Schema from '@deepseek-ai/schemastery'
import type { DistillOutput } from './distill.ts'
import { registerDistillTool } from './index.ts'
import { SYSTEM_PROMPT } from './prompt.ts'
import { registerRemindersTool } from './reminders.ts'
import type { RemindersWriteResult } from './reminders.ts'

export const name = 'dsh-todo-distiller-app'
export const inject = ['webServer', 'agents', 'agentDefaultModel', 'tools', 'systemPrompt', 'subprocess']

export interface Config {
  /** Reminders list that receives the items; created when missing. */
  list: string
  /** Deadline for one Reminders write, including the first-run macOS permission prompt. */
  timeoutMs: number
  /** Largest accepted document body in bytes. */
  maxBytes: number
}

export const Config: Schema<Config> = Schema.object({
  list: Schema.string().default('DSH 助理'),
  timeoutMs: Schema.number().min(1000).default(120000),
  maxBytes: Schema.number().min(1024).default(2 * 1024 * 1024),
})

const ROUTE = '/todo-distiller'

export interface RunResult {
  sessionId: string
  name: string
  tools: string[]
  batches: Array<{ batchId: string, result: DistillOutput }>
  writes: Array<{ batchId: string, result: RemindersWriteResult }>
  summary: string | null
  usage: { inputTokens: number, outputTokens: number, requests: number }
  durationMs: number
}

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

function lastAssistantText(events: readonly SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type !== 'assistant/message') continue
    const text = e.data.message.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim()
    if (text !== '') return text
  }
  return null
}

/** Probe: total the provider-reported usage of every assistant message. */
function sumUsage(events: readonly SessionEvent[]): { inputTokens: number, outputTokens: number, requests: number } {
  const out = { inputTokens: 0, outputTokens: 0, requests: 0 }
  for (const e of events) {
    if (e.type !== 'assistant/message' || e.data.usage === undefined) continue
    out.inputTokens += e.data.usage.inputTokens
    out.outputTokens += e.data.usage.outputTokens
    out.requests++
  }
  return out
}

export function apply(ctx: Context, config: Config) {
  async function run(text: string, docName: string): Promise<RunResult> {
    const started = Date.now()
    const selection = ctx.agentDefaultModel.currentSelection()
    const batches: RunResult['batches'] = []
    const writes: RunResult['writes'] = []
    const sessionId = `todo-distiller-${randomUUID()}` as SessionId
    const handle = await ctx.agents.create({
      sessionId,
      agentOptions: { ...selection },
      setup: async (agentCtx) => {
        agentCtx.effect(() => agentCtx.systemPrompt.section({
          name: PERSONA_PREFIX_SECTION,
          order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
          text: SYSTEM_PROMPT,
          complete: true,
        }), 'todo-distiller: system prompt')
        agentCtx.effect(() => registerDistillTool(agentCtx, (batchId, result) => batches.push({ batchId, result })), 'todo-distiller: distill tool')
        if (process.platform === 'darwin') {
          agentCtx.effect(() => registerRemindersTool(agentCtx, config, (batchId, result) => writes.push({ batchId, result })), 'todo-distiller: reminders tool')
        }
      },
    })
    try {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: `文件名: ${docName}\n\n${text}` }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      return {
        sessionId,
        name: docName,
        tools: ctx.tools.schemas(handle.agent).map(s => s.name),
        batches,
        writes,
        summary: lastAssistantText(handle.agent.session.snapshotEvents()),
        usage: sumUsage(handle.agent.session.snapshotEvents()),
        durationMs: Date.now() - started,
      }
    } finally {
      await handle.dispose()
    }
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
        if (req.method === 'POST' && path === 'run') {
          const docName = decodeURIComponent(String(req.headers['x-todo-distiller-name'] ?? '未命名'))
          const text = await readBody(req, config.maxBytes)
          if (text.trim() === '') return json(res, 400, { error: '文档为空' })
          return json(res, 200, await run(text, docName))
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
