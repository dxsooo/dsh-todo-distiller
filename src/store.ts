// Durable record of runs (one per dropped document), the items they produced,
// and the Session that serves each day. Stored through DSH's `ctx.storageDomain`.
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { DistillOutput } from './distill.ts'
import type { RemindersWriteResult } from './reminders.ts'
import { toReminderWrites } from './publish.ts'

/** Provider-reported usage; `inputTokens` excludes cache reads. */
const usageSchema = z.object({ inputTokens: z.number(), cacheReadTokens: z.number().default(0), outputTokens: z.number(), requests: z.number() })

const runSchema = z.object({
  id: z.string(),
  day: z.string(),
  name: z.string(),
  state: z.enum(['queued', 'running', 'done', 'error']),
  createdAt: z.string(),
  /** Epoch ms of submission; orders runs submitted within the same second. */
  createdMs: z.number().default(0),
  finishedAt: z.string().nullable(),
  sessionId: z.string().nullable(),
  error: z.string().nullable(),
  summary: z.string().nullable(),
  usage: usageSchema.nullable(),
  created: z.number(),
  existing: z.number(),
})

const itemSchema = z.object({
  /** Stable id: the idempotency marker digest, or `<runId>:<n>` for an item that was not emitted. */
  id: z.string(),
  runId: z.string(),
  day: z.string(),
  kind: z.enum(['todo', 'schedule']),
  title: z.string(),
  /** Due (todo) or start (schedule), ISO 8601 with offset. */
  at: z.string().nullable(),
  endAt: z.string().nullable(),
  assignee: z.string().nullable(),
  location: z.string().nullable(),
  status: z.enum(['open', 'done']),
  timeText: z.string().nullable(),
  timeAssumption: z.string().nullable(),
  sourceName: z.string().nullable(),
  sourceQuote: z.string().nullable(),
  /** Why the time could not be resolved; null when resolved or none was given. */
  unresolved: z.string().nullable(),
  /** Outcome of the Reminders write; null when not written. */
  reminder: z.enum(['created', 'exists']).nullable(),
  createdAt: z.string(),
})

const daySchema = z.object({ day: z.string(), sessionId: z.string() })

export type RunRecord = z.infer<typeof runSchema>
export type ItemRecord = z.infer<typeof itemSchema>
export type DayRecord = z.infer<typeof daySchema>

export const STORE = defineDomain({
  name: 'todo_distiller',
  version: 1,
  tables: {
    runs: domainTable<string, RunRecord>(runSchema),
    items: domainTable<string, ItemRecord>(itemSchema),
    days: domainTable<string, DayRecord>(daySchema),
  },
})

/**
 * Project one run's distilled batches and Reminders writes into item records.
 * @param run - owning run.
 * @param batches - every successful dsh_todo_distiller result of the run.
 * @param writes - every successful Reminders write of the run.
 * @param now - ISO timestamp recorded on the items.
 * @returns item records; a later batch with the same item replaces the earlier one.
 */
export function itemsOf(
  run: Pick<RunRecord, 'id' | 'day'>,
  batches: ReadonlyArray<{ batchId: string, result: DistillOutput }>,
  writes: ReadonlyArray<{ batchId: string, result: RemindersWriteResult }>,
  now: string,
): ItemRecord[] {
  const out = new Map<string, ItemRecord>()
  let extra = 0
  for (const { batchId, result } of batches) {
    const statusOf = new Map<string, 'created' | 'exists'>()
    for (const w of writes) if (w.batchId === batchId) for (const i of w.result.items) statusOf.set(i.id, i.status)
    const markers = new Map(toReminderWrites(result).map(w => [w.id, w.marker.slice(w.marker.indexOf(':') + 1)]))
    const unresolvedOf = new Map(result.unresolved.filter(u => u.itemId !== null).map(u => [u.itemId!, u.reason]))
    for (const t of result.todos) {
      const id = markers.get(t.id)!
      out.set(id, {
        id, runId: run.id, day: run.day, kind: 'todo', title: t.title, at: t.dueAt, endAt: null,
        assignee: t.assignee, location: null, status: t.status, timeText: t.dueText, timeAssumption: t.timeAssumption,
        sourceName: t.source.name, sourceQuote: t.sourceQuote, unresolved: unresolvedOf.get(t.id) ?? null,
        reminder: statusOf.get(t.id) ?? null, createdAt: now,
      })
    }
    for (const s of result.schedules) {
      const id = markers.get(s.id)!
      out.set(id, {
        id, runId: run.id, day: run.day, kind: 'schedule', title: s.title, at: s.startAt, endAt: s.endAt,
        assignee: s.assignee, location: s.location, status: s.status, timeText: s.startText, timeAssumption: s.timeAssumption,
        sourceName: s.source.name, sourceQuote: s.sourceQuote, unresolved: null,
        reminder: statusOf.get(s.id) ?? null, createdAt: now,
      })
    }
    for (const u of result.unresolved.filter(u => u.itemId === null)) {
      const id = `${run.id}:${++extra}`
      out.set(id, {
        id, runId: run.id, day: run.day, kind: u.kind, title: u.title, at: null, endAt: null,
        assignee: null, location: null, status: 'open', timeText: u.timeText, timeAssumption: null,
        sourceName: result.todos[0]?.source.name ?? result.schedules[0]?.source.name ?? null, sourceQuote: null,
        unresolved: u.reason, reminder: null, createdAt: now,
      })
    }
  }
  return [...out.values()]
}
