// Runs dropped documents one at a time through a Session per local day.
// The Session lives in a dedicated Workspace, so it is an ordinary DSH Session:
// persisted, listed in the sidebar, and counted by DSH's token usage.
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'
import type { DistillOutput } from './distill.ts'
import { registerDistillTool } from './index.ts'
import { SYSTEM_PROMPT } from './prompt.ts'
import { registerRemindersTool } from './reminders.ts'
import type { Config as RemindersConfig, RemindersWriteResult } from './reminders.ts'
import { formatIso } from './time.ts'
import { itemsOf, STORE } from './store.ts'
import type { RunRecord } from './store.ts'

const TIME_ZONE = 'Asia/Shanghai'
const DISTILL_TOOL = 'dsh_todo_distiller'

interface Collector {
  batches: Array<{ batchId: string, result: DistillOutput }>
  writes: Array<{ batchId: string, result: RemindersWriteResult }>
}

interface SessionTitleService { rename(session: unknown, title: string): void }

export interface RunnerOptions {
  reminders: RemindersConfig
  /** Directory of the dedicated Workspace; created when missing. */
  workspaceDir: string
  workspaceTitle: string
}

/** Local calendar day `YYYY-MM-DD` in Asia/Shanghai. */
export function dayOf(ms: number): string {
  return formatIso(ms, TIME_ZONE).slice(0, 10)
}

/**
 * Default dedicated Workspace directory below DSH_HOME.
 * @returns absolute path.
 */
export function defaultWorkspaceDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'todo-distiller', 'workspace')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Serial document runner. Each run joins today's Session (creating or
 * resuming it), sends the document as one user message, waits for the Agent
 * to settle, and records the result.
 */
export class Runner {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly collectors = new WeakMap<Agent, Collector>()
  private tail: Promise<void> = Promise.resolve()

  private readonly ctx: Context
  private readonly store: Domain<typeof STORE>
  private readonly options: RunnerOptions

  constructor(ctx: Context, store: Domain<typeof STORE>, options: RunnerOptions) {
    this.ctx = ctx
    this.store = store
    this.options = options
  }

  /**
   * Queue one document.
   * @param name - file name shown to the model and the page.
   * @param text - document body.
   * @returns the queued run record.
   */
  async submit(name: string, text: string): Promise<RunRecord> {
    const now = Date.now()
    const run: RunRecord = {
      id: `r-${randomUUID().slice(0, 8)}`,
      day: dayOf(now),
      name,
      state: 'queued',
      createdAt: formatIso(now, TIME_ZONE),
      createdMs: now,
      finishedAt: null,
      sessionId: null,
      error: null,
      summary: null,
      usage: null,
      created: 0,
      existing: 0,
    }
    await this.store.table('runs').put(run.id, run)
    this.tail = this.tail.then(() => this.process(run.id, text, now)).catch((error: unknown) => {
      this.ctx.logger.warn('[todo-distiller] run bookkeeping failed: %s', errorText(error))
    })
    return run
  }

  /** Release live Agents this runner holds; their Sessions stay persisted. */
  async dispose(): Promise<void> {
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map(h => h.dispose()))
  }

  private async process(runId: string, text: string, receivedMs: number): Promise<void> {
    const runs = this.store.table('runs')
    const run = await runs.update(runId, r => ({ ...r, state: 'running' as const }))
    try {
      const agent = await this.agentFor(run.day)
      await runs.update(runId, r => ({ ...r, sessionId: agent.session.id }))
      const collector: Collector = { batches: [], writes: [] }
      this.collectors.set(agent, collector)
      const startSeq = agent.session.seq
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: `文件名: ${run.name}\n接收时间: ${formatIso(receivedMs, TIME_ZONE)}\n\n${text}` }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      this.collectors.delete(agent)
      const events = agent.session.snapshotEvents(startSeq)
      const failure = turnFailure(events)
      const now = formatIso(Date.now(), TIME_ZONE)
      const items = itemsOf(run, collector.batches, collector.writes, now)
      for (const item of items) await this.store.table('items').put(item.id, item)
      await runs.update(runId, r => ({
        ...r,
        state: failure === null ? 'done' as const : 'error' as const,
        error: failure,
        finishedAt: now,
        summary: lastAssistantText(events),
        usage: sumUsage(events),
        created: collector.writes.reduce((n, w) => n + w.result.created, 0),
        existing: collector.writes.reduce((n, w) => n + w.result.existing, 0),
      }))
    } catch (error) {
      this.ctx.logger.warn('[todo-distiller] run %s failed: %s', runId, error instanceof Error ? error.stack ?? error.message : String(error))
      await runs.update(runId, r => ({ ...r, state: 'error' as const, error: errorText(error), finishedAt: formatIso(Date.now(), TIME_ZONE) }))
    }
  }

  /** Today's Agent: live, resumed from disk, or newly created in the dedicated Workspace. */
  private async agentFor(day: string): Promise<Agent> {
    const days = this.store.table('days')
    const recorded = days.get(day)
    if (recorded !== undefined) {
      const id = recorded.sessionId as SessionId
      const live = this.ctx.agents.get(id)
      if (live !== undefined) {
        // A Session the user resumed from the sidebar has no setup of ours; start a fresh one.
        if (this.ctx.tools.schemas(live).some(s => s.name === DISTILL_TOOL)) return live
        this.ctx.logger.info('[todo-distiller] session %s is live without our tools; starting a new one', id)
      } else {
        try {
          const handle = await this.ctx.agents.resume({ resumeSessionId: id, setup: agentCtx => this.setup(agentCtx) })
          this.handles.set(day, handle)
          return handle.agent
        } catch (error) {
          this.ctx.logger.info('[todo-distiller] cannot resume %s (%s); starting a new one', id, errorText(error))
        }
      }
    }
    await mkdir(this.options.workspaceDir, { recursive: true })
    const workspace = await this.ctx.workspaceRegistry.create(this.options.workspaceDir, this.options.workspaceTitle)
    const sessionId = `todo-distiller-${day}-${randomUUID().slice(0, 4)}` as SessionId
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path },
      agentOptions: { ...this.ctx.agentDefaultModel.currentSelection() },
      setup: agentCtx => this.setup(agentCtx),
    })
    try {
      await workspace.attachSession(sessionId)
      const titles = this.ctx.get('sessionTitle' as never) as SessionTitleService | undefined
      titles?.rename(handle.agent.session, `待办助理 ${day}`)
    } catch (error) {
      await handle.dispose()
      throw error
    }
    this.handles.set(day, handle)
    await days.put(day, { day, sessionId })
    return handle.agent
  }

  /** Compose one Agent: our prompt, our two tools, and no global tools. */
  private setup(agentCtx: Context): void {
    const collect = (): Collector | undefined => {
      for (const agent of this.ctx.agents.list()) if (agent.ctx === agentCtx) return this.collectors.get(agent)
      return undefined
    }
    agentCtx.effect(() => agentCtx.systemPrompt.section({
      name: PERSONA_PREFIX_SECTION,
      order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: SYSTEM_PROMPT,
      complete: true,
    }), 'todo-distiller: system prompt')
    agentCtx.effect(() => agentCtx.systemPrompt.suppressRuntimeContext(), 'todo-distiller: no runtime context')
    agentCtx.effect(() => agentCtx.tools.restrict({ allow: [] }), 'todo-distiller: hide global tools')
    agentCtx.effect(() => registerDistillTool(agentCtx, (batchId, result) => collect()?.batches.push({ batchId, result })), 'todo-distiller: distill tool')
    if (process.platform === 'darwin') {
      agentCtx.effect(() => registerRemindersTool(agentCtx, this.options.reminders, (batchId, result) => collect()?.writes.push({ batchId, result })), 'todo-distiller: reminders tool')
    }
  }
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

function sumUsage(events: readonly SessionEvent[]): RunRecord['usage'] & {} {
  const out = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, requests: 0 }
  for (const e of events) {
    if (e.type !== 'assistant/message' || e.data.usage === undefined) continue
    out.inputTokens += e.data.usage.inputTokens
    out.cacheReadTokens += e.data.usage.cacheReadTokens ?? 0
    out.outputTokens += e.data.usage.outputTokens
    out.requests++
  }
  return out
}

function turnFailure(events: readonly SessionEvent[]): string | null {
  for (const e of events) {
    if (e.type !== 'turn/end') continue
    const reason = e.data.reason
    if (reason.kind === 'error') return reason.error.message
    if (reason.kind === 'aborted') return '处理被中断'
  }
  return null
}
