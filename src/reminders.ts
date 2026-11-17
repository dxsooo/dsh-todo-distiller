// Plugin: registers dsh_todo_distiller_to_reminders, which writes a batch
// produced by dsh_todo_distiller into the macOS Reminders app.
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { getBatch } from './batches.ts'
import { buildOsascriptArgv, isNotAuthorized, parseWriteResults } from './macos/reminders-script.ts'
import type { ReminderWriteResult } from './macos/reminders-script.ts'
import { toReminderWrites } from './publish.ts'

export const name = 'dsh-todo-distiller-reminders'
export const inject = ['tools', 'subprocess']

export interface Config {
  /** Reminders list that receives the items; created when missing. */
  list: string
  /** Deadline for the whole write, including the first-run macOS permission prompt. */
  timeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  list: Schema.string().default('DSH 助理'),
  timeoutMs: Schema.number().min(1000).default(120000),
})

const REMINDERS_ERROR_CODES = ['BATCH_NOT_FOUND', 'REMINDERS_NOT_AUTHORIZED', 'REMINDERS_TIMEOUT', 'REMINDERS_FAILED'] as const

export class RemindersError extends HarnessError {
  constructor(message: string, readonly reminderCode: typeof REMINDERS_ERROR_CODES[number]) {
    super(message, reminderCode)
    this.name = 'RemindersError'
  }
}

const str = { type: 'string' } as const
const req = <const S extends ValueSchemaSpec>(s: S) => ({ ...s, required: true }) as S & { required: true }

async function runOsascript(ctx: Context, argv: string[], timeoutMs: number, signal: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const spec: SubprocessSpawnSpec = {
    argv,
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } },
    graceMs: 2000,
    signal: AbortSignal.any([signal, timeout]),
  }
  const handle = ctx.subprocess.spawn(spec)
  const outcome = await handle.done
  if (timeout.aborted) {
    throw new RemindersError(`写入提醒事项超时(${timeoutMs} ms)。若 macOS 弹出了授权框,请点“好”后重试。`, 'REMINDERS_TIMEOUT')
  }
  signal.throwIfAborted()
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  if (outcome.exitCode !== 0) {
    if (isNotAuthorized(stderr)) {
      throw new RemindersError('没有控制“提醒事项”的权限。请在 系统设置 > 隐私与安全性 > 自动化 中,允许启动 DSH 的应用控制“提醒事项”,然后重试。', 'REMINDERS_NOT_AUTHORIZED')
    }
    throw new RemindersError(`osascript 失败(exit ${outcome.exitCode}): ${stderr.trim().slice(0, 500)}`, 'REMINDERS_FAILED')
  }
  return stdout
}

export function apply(ctx: Context, config: Config) {
  if (process.platform !== 'darwin') return
  ctx.tools.register(defineTool({
    name: 'dsh_todo_distiller_to_reminders',
    description: [
      'Write the todos and schedules of a batch returned by dsh_todo_distiller into the macOS Reminders app.',
      'Safe to call again for the same batch: items already written are reported as "exists" and not duplicated.',
    ].join(' '),
    parameters: {
      batchId: req({ type: 'string', description: 'meta.batchId from dsh_todo_distiller.' }),
      ids: { type: 'array', items: str, description: 'Only write these item ids (e.g. ["t1","s1"]). Default: all.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          list: req(str),
          created: req({ type: 'integer' }),
          existing: req({ type: 'integer' }),
          items: req({
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: req(str),
                title: req(str),
                status: req({ type: 'string', enum: ['created', 'exists'] }),
              },
            },
          }),
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const batch = getBatch(args.batchId)
      if (batch === undefined) {
        throw new RemindersError(`批次 ${args.batchId} 不存在或已失效(重启后会清空),请重新调用 dsh_todo_distiller。`, 'BATCH_NOT_FOUND')
      }
      const known = new Set([...batch.todos, ...batch.schedules].map(i => i.id))
      const unknown = (args.ids ?? []).filter(id => !known.has(id))
      if (unknown.length > 0) throw new ToolArgsError([`ids: unknown item id(s) ${unknown.join(', ')}`])

      const writes = toReminderWrites(batch, args.ids)
      if (writes.length === 0) return { list: config.list, created: 0, existing: 0, items: [] }

      const stdout = await runOsascript(ctx, buildOsascriptArgv(config.list, writes), config.timeoutMs, exec.signal)
      let results: ReminderWriteResult[]
      try {
        results = parseWriteResults(stdout)
      } catch {
        throw new RemindersError(`无法解析 osascript 输出: ${stdout.slice(0, 200)}`, 'REMINDERS_FAILED')
      }
      const statusOf = new Map(results.map(r => [r.marker, r.status]))
      const items = writes.map(w => ({ id: w.id, title: w.name, status: statusOf.get(w.marker) ?? 'exists' as const }))
      return {
        list: config.list,
        created: items.filter(i => i.status === 'created').length,
        existing: items.filter(i => i.status === 'exists').length,
        items,
      }
    },
  }))
}
