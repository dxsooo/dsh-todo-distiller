// Pure normalization of model-proposed candidates into todos, schedules,
// reminder suggestions, and unresolved items. No I/O, no clock access.
import { itemIdOf } from './item-id.ts'
import { civilOf, formatIso, parseInstant, weekdayName, zonedToInstant } from './time.ts'

export type SourceType = 'im' | 'phone' | 'meeting' | 'document'
export type Priority = 'high' | 'normal' | 'low'
export type Status = 'open' | 'done'

/** A link to another item: `key` of an item in this call, or `itemId` of an item recorded earlier. Exactly one is set. */
export interface CandidateRelation { key?: string, itemId?: string, relation?: string }

/** One item the model extracted from the source text. */
export interface Candidate {
  kind: 'todo' | 'schedule'
  title: string
  description?: string
  assignee?: string
  location?: string
  priority?: Priority
  status?: Status
  /** Time expression exactly as written in the source, e.g. `下周三下午3点`. */
  timeText?: string
  /** The model's reading of `timeText` when it had to assume something. */
  timeAssumption?: string
  /** Todo deadline, ISO 8601. */
  dueAt?: string
  /** Schedule start, ISO 8601. */
  startAt?: string
  /** Schedule end, ISO 8601. */
  endAt?: string
  durationMinutes?: number
  key?: string
  related?: CandidateRelation[]
  sourceQuote?: string
  notes?: string
}

export interface DistillInput {
  items: Candidate[]
  sourceType: SourceType
  sourceName?: string
  sourceRef?: string
  timeZone: string
  reminderLeadMinutes: number
  /** Whether a recorded item id exists; when absent, `itemId` relations are ignored with a warning. */
  isKnownItem?: (id: string) => boolean
}

export interface Source { type: SourceType, name: string | null, ref: string | null }
/** `scope: 'batch'` — `id` is t1/s1 in this result; `'store'` — `id` is a recorded item id. */
export interface Relation { id: string, scope: 'batch' | 'store', relation: string | null }

export interface TodoOut {
  id: string
  /** Stable id across runs and days; use it in a later `related.itemId`. */
  itemId: string
  title: string
  description: string | null
  assignee: string | null
  priority: Priority | null
  status: Status
  dueAt: string | null
  dueWeekday: string | null
  dueText: string | null
  timeAssumption: string | null
  source: Source
  sourceQuote: string | null
  related: Relation[]
  notes: string | null
}

export interface ScheduleOut {
  id: string
  /** Stable id across runs and days; use it in a later `related.itemId`. */
  itemId: string
  title: string
  description: string | null
  assignee: string | null
  location: string | null
  priority: Priority | null
  status: Status
  startAt: string
  startWeekday: string
  endAt: string | null
  startText: string | null
  timeAssumption: string | null
  source: Source
  sourceQuote: string | null
  related: Relation[]
  notes: string | null
}

export interface ReminderOut {
  id: string
  targetId: string
  remindAt: string
  reason: 'before-start' | 'due'
}

export interface UnresolvedOut {
  kind: 'todo' | 'schedule'
  key: string | null
  title: string
  timeText: string | null
  reason: string
  /** Id of the todo kept in `todos` without a due time; null when the item was not emitted. */
  itemId: string | null
}

export interface DistillOutput {
  todos: TodoOut[]
  schedules: ScheduleOut[]
  suggestedReminders: ReminderOut[]
  unresolved: UnresolvedOut[]
  meta: { capturedAt: string, timeZone: string, warnings: string[] }
}

/** Local reminder hour for deadlines stated as an end of day (23:59). */
const END_OF_DAY_REMINDER_HOUR = 9

const orNull = <T>(v: T | undefined): T | null => v ?? null

/**
 * Check a tool input the type system cannot express.
 * @param input - candidate input.
 * @returns violations; empty means valid.
 */
export function validate(input: DistillInput): string[] {
  const out: string[] = []
  const { timeZone } = input
  if (input.reminderLeadMinutes < 0) out.push('reminderLeadMinutes must be >= 0')
  const seen = new Set<string>()
  input.items.forEach((item, i) => {
    const at = `items[${i}]`
    if (item.title.trim() === '') out.push(`${at}.title must not be empty`)
    if (item.durationMinutes !== undefined && item.durationMinutes <= 0) out.push(`${at}.durationMinutes must be positive`)
    if (item.key !== undefined) {
      if (seen.has(item.key)) out.push(`${at}.key "${item.key}" is not unique`)
      seen.add(item.key)
    }
    ;(item.related ?? []).forEach((r, j) => {
      if ((r.key === undefined) === (r.itemId === undefined)) out.push(`${at}.related[${j}] must set exactly one of key or itemId`)
    })
    for (const field of ['dueAt', 'startAt', 'endAt'] as const) {
      const v = item[field]
      if (v !== undefined && parseInstant(v, timeZone) === null) {
        out.push(`${at}.${field} "${v}" is not an ISO 8601 date-time like 2025-06-05T23:59:59+08:00`)
      }
    }
    if (item.kind === 'todo' && (item.startAt !== undefined || item.endAt !== undefined)) out.push(`${at}: a todo uses dueAt, not startAt/endAt`)
    if (item.kind === 'schedule' && item.dueAt !== undefined) out.push(`${at}: a schedule uses startAt/endAt, not dueAt`)
    if (item.startAt !== undefined && item.endAt !== undefined) {
      const s = parseInstant(item.startAt, timeZone)!
      const e = parseInstant(item.endAt, timeZone)!
      if (e <= s) out.push(`${at}.endAt must be later than startAt`)
    }
  })
  return out
}

/**
 * Normalize candidates against a capture instant. Input must pass {@link validate}.
 * @param input - validated tool input.
 * @param capturedMs - capture instant (epoch ms).
 * @returns structured result with reminders and warnings.
 */
export function distill(input: DistillInput, capturedMs: number): DistillOutput {
  const { timeZone } = input
  const parse = (v: string): number => parseInstant(v, timeZone)!
  const source: Source = { type: input.sourceType, name: orNull(input.sourceName), ref: orNull(input.sourceRef) }
  const warnings: string[] = []
  const ids = new Map<string, string>()
  let todoCount = 0
  let scheduleCount = 0
  const idOf: string[] = input.items.map((item) => {
    const id = item.kind === 'todo' ? `t${++todoCount}` : `s${++scheduleCount}`
    if (item.key !== undefined) ids.set(item.key, id)
    return id
  })

  const relationsOf = (item: Candidate, selfId: string): Relation[] => {
    const out: Relation[] = []
    for (const r of item.related ?? []) {
      if (r.itemId !== undefined) {
        if (input.isKnownItem?.(r.itemId) === true) out.push({ id: r.itemId, scope: 'store', relation: orNull(r.relation) })
        else warnings.push(`${selfId}: 关联的已有事项 "${r.itemId}" 不存在，已忽略`)
        continue
      }
      const id = ids.get(r.key!)
      if (id === undefined) warnings.push(`${selfId}: 关联的 key "${r.key}" 不存在，已忽略`)
      else out.push({ id, scope: 'batch', relation: orNull(r.relation) })
    }
    return out
  }

  const todos: TodoOut[] = []
  const schedules: ScheduleOut[] = []
  const reminders: ReminderOut[] = []
  const unresolved: UnresolvedOut[] = []
  let skippedPast = 0

  const pushReminder = (targetId: string, at: number, reason: ReminderOut['reason']): void => {
    if (at < capturedMs) {
      skippedPast++
      return
    }
    reminders.push({ id: `r${reminders.length + 1}`, targetId, remindAt: formatIso(at, timeZone), reason })
  }

  const isEndOfDay = (ms: number): boolean => {
    const p = formatIso(ms, timeZone)
    return p.slice(11, 16) === '23:59'
  }

  input.items.forEach((item, index) => {
    const id = idOf[index]!
    const timeText = item.timeText?.trim() === '' ? undefined : item.timeText
    const base = { key: orNull(item.key), title: item.title, timeText: orNull(timeText) }
    const open = (item.status ?? 'open') === 'open'

    if (item.kind === 'todo') {
      const due = item.dueAt === undefined ? null : parse(item.dueAt)
      if (due === null && timeText !== undefined) {
        unresolved.push({ kind: 'todo', ...base, reason: '未能确定具体截止时间', itemId: id })
      }
      if (due !== null && due < capturedMs) warnings.push(`${id}: 截止时间早于捕获时间`)
      todos.push({
        id,
        itemId: itemIdOf('todo', item.title, due === null ? null : formatIso(due, timeZone), source.name, source.ref),
        title: item.title,
        description: orNull(item.description),
        assignee: orNull(item.assignee),
        priority: orNull(item.priority),
        status: item.status ?? 'open',
        dueAt: due === null ? null : formatIso(due, timeZone),
        dueWeekday: due === null ? null : weekdayName(due, timeZone),
        dueText: orNull(timeText),
        timeAssumption: orNull(item.timeAssumption),
        source,
        sourceQuote: orNull(item.sourceQuote),
        related: relationsOf(item, id),
        notes: orNull(item.notes),
      })
      if (due !== null && open) {
        const at = isEndOfDay(due)
          ? zonedToInstant(civilOf(due, timeZone), END_OF_DAY_REMINDER_HOUR, 0, 0, timeZone)
          : due - input.reminderLeadMinutes * 60000
        pushReminder(id, at, 'due')
      }
      return
    }

    if (item.startAt === undefined) {
      unresolved.push({ kind: 'schedule', ...base, reason: '日程缺少具体开始时间', itemId: null })
      return
    }
    const start = parse(item.startAt)
    if (start < capturedMs) warnings.push(`${id}: 开始时间早于捕获时间`)
    const endAt = item.endAt !== undefined
      ? parse(item.endAt)
      : item.durationMinutes !== undefined ? start + item.durationMinutes * 60000 : null
    schedules.push({
      id,
      itemId: itemIdOf('schedule', item.title, formatIso(start, timeZone), source.name, source.ref),
      title: item.title,
      description: orNull(item.description),
      assignee: orNull(item.assignee),
      location: orNull(item.location),
      priority: orNull(item.priority),
      status: item.status ?? 'open',
      startAt: formatIso(start, timeZone),
      startWeekday: weekdayName(start, timeZone),
      endAt: endAt === null ? null : formatIso(endAt, timeZone),
      startText: orNull(timeText),
      timeAssumption: orNull(item.timeAssumption),
      source,
      sourceQuote: orNull(item.sourceQuote),
      related: relationsOf(item, id),
      notes: orNull(item.notes),
    })
    if (open) pushReminder(id, start - input.reminderLeadMinutes * 60000, 'before-start')
  })

  if (skippedPast > 0) warnings.push(`${skippedPast} 条提醒时间早于捕获时间，已不生成`)
  return {
    todos,
    schedules,
    suggestedReminders: reminders,
    unresolved,
    meta: { capturedAt: formatIso(capturedMs, timeZone), timeZone, warnings },
  }
}
