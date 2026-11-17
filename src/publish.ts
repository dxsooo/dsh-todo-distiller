// Pure mapping from a distilled batch to macOS Reminders fields.
import { createHash } from 'node:crypto'
import type { DistillOutput, Priority, ScheduleOut, TodoOut } from './distill.ts'
import type { ReminderWrite } from './macos/reminders-script.ts'

const MARKER_PREFIX = 'dsh-todo-distiller:'

const PRIORITY: Record<Priority, ReminderWrite['priority']> = { high: 1, normal: 5, low: 9 }

const label = (iso: string): string => iso.slice(0, 16).replace('T', ' ')

function marker(parts: ReadonlyArray<string | null>): string {
  const digest = createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 12)
  return `${MARKER_PREFIX}${digest}`
}

function sourceLine(item: TodoOut | ScheduleOut): string | null {
  const { name, ref } = item.source
  const text = [name, ref].filter((v): v is string => v !== null).join(' ')
  return text === '' ? null : `来源: ${text}`
}

function bodyOf(lines: ReadonlyArray<string | null>, mark: string): string {
  return [...lines.filter((l): l is string => l !== null && l !== ''), '', mark].join('\n')
}

/**
 * Map the todos and schedules of a batch to reminders.
 * @param batch - distilled batch.
 * @param ids - ids to include; all items when undefined.
 * @returns reminders in batch order (todos, then schedules), each with a stable idempotency marker.
 */
export function toReminderWrites(batch: DistillOutput, ids?: readonly string[]): Array<ReminderWrite & { id: string }> {
  const wanted = (id: string): boolean => ids === undefined || ids.includes(id)
  const alertOf = (id: string): string | null => batch.suggestedReminders.find(r => r.targetId === id)?.remindAt ?? null
  const out: Array<ReminderWrite & { id: string }> = []

  for (const t of batch.todos.filter(x => wanted(x.id))) {
    const mark = marker(['todo', t.title, t.dueAt, t.source.name, t.source.ref])
    out.push({
      id: t.id,
      marker: mark,
      name: t.title,
      body: bodyOf([
        t.description,
        t.assignee === null ? null : `负责人: ${t.assignee}`,
        t.dueText === null ? null : `原文时间: ${t.dueText}`,
        t.timeAssumption === null ? null : `时间说明: ${t.timeAssumption}`,
        sourceLine(t),
        t.sourceQuote === null ? null : `原文: ${t.sourceQuote}`,
        t.notes === null ? null : `纪要: ${t.notes}`,
      ], mark),
      priority: t.priority === null ? 0 : PRIORITY[t.priority],
      dueAt: t.dueAt,
      remindAt: alertOf(t.id),
      completed: t.status === 'done',
    })
  }

  for (const s of batch.schedules.filter(x => wanted(x.id))) {
    const mark = marker(['schedule', s.title, s.startAt, s.source.name, s.source.ref])
    out.push({
      id: s.id,
      marker: mark,
      name: s.title,
      body: bodyOf([
        s.description,
        `日程: ${label(s.startAt)}${s.endAt === null ? '' : ` 至 ${label(s.endAt)}`}`,
        s.location === null ? null : `地点: ${s.location}`,
        s.assignee === null ? null : `负责人: ${s.assignee}`,
        s.startText === null ? null : `原文时间: ${s.startText}`,
        s.timeAssumption === null ? null : `时间说明: ${s.timeAssumption}`,
        sourceLine(s),
        s.sourceQuote === null ? null : `原文: ${s.sourceQuote}`,
        s.notes === null ? null : `纪要: ${s.notes}`,
      ], mark),
      priority: s.priority === null ? 0 : PRIORITY[s.priority],
      dueAt: s.startAt,
      remindAt: alertOf(s.id),
      completed: s.status === 'done',
    })
  }
  return out
}
