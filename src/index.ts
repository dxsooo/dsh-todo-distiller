// dsh-todo-distiller — turns candidates the model extracted from natural
// language (chat, call, meeting, document) into normalized todos, schedules,
// reminder suggestions, and unresolved items. The model understands the text;
// this tool owns the deterministic part (time-zone-aware time resolution,
// validation, reminders, relations), so the model never computes dates itself.
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { saveBatch } from './batches.ts'
import { distill, validate } from './distill.ts'
import type { DistillOutput } from './distill.ts'
import { isValidTimeZone, parseInstant } from './time.ts'

export const name = 'dsh-todo-distiller'
export const inject = ['tools']

const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const DEFAULT_REMINDER_LEAD_MINUTES = 15

const nullable = <const S extends ValueSchemaSpec>(s: S) => ({ oneOf: [s, { type: 'null' }] }) as const
const req = <const S extends ValueSchemaSpec>(s: S) => ({ ...s, required: true }) as S & { required: true }

const str = { type: 'string' } as const
const priority = { type: 'string', enum: ['high', 'normal', 'low'] } as const
const status = { type: 'string', enum: ['open', 'done'] } as const

const sourceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: req({ type: 'string', enum: ['im', 'phone', 'meeting', 'document'] }),
    name: req(nullable(str)),
    ref: req(nullable(str)),
  },
} as const

const relatedOut = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: { id: req(str), relation: req(nullable(str)) },
  },
} as const

const todoOut = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: req(str),
    title: req(str),
    description: req(nullable(str)),
    assignee: req(nullable(str)),
    priority: req(nullable(priority)),
    status: req(status),
    dueAt: req(nullable(str)),
    dueWeekday: req(nullable(str)),
    dueText: req(nullable(str)),
    timeAssumption: req(nullable(str)),
    source: req(sourceSchema),
    sourceQuote: req(nullable(str)),
    related: req(relatedOut),
    notes: req(nullable(str)),
  },
} as const

const scheduleOut = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: req(str),
    title: req(str),
    description: req(nullable(str)),
    assignee: req(nullable(str)),
    location: req(nullable(str)),
    priority: req(nullable(priority)),
    status: req(status),
    startAt: req(str),
    startWeekday: req(str),
    endAt: req(nullable(str)),
    startText: req(nullable(str)),
    timeAssumption: req(nullable(str)),
    source: req(sourceSchema),
    sourceQuote: req(nullable(str)),
    related: req(relatedOut),
    notes: req(nullable(str)),
  },
} as const

const reminderOut = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: req(str),
    targetId: req(str),
    remindAt: req(str),
    reason: req({ type: 'string', enum: ['before-start', 'due'] }),
  },
} as const

const unresolvedOut = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: req({ type: 'string', enum: ['todo', 'schedule'] }),
    key: req(nullable(str)),
    title: req(str),
    timeText: req(nullable(str)),
    reason: req(str),
    itemId: req(nullable(str)),
  },
} as const

export function apply(ctx: Context) {
  registerDistillTool(ctx)
}

/**
 * Register `dsh_todo_distiller` in the context's scope (an Agent scope keeps it private to that Agent).
 * @param ctx - registering context.
 * @param onResult - called with each successful result and its batch id.
 * @returns the registration disposer.
 */
export function registerDistillTool(ctx: Context, onResult?: (batchId: string, result: DistillOutput) => void): () => void {
  return ctx.tools.register(defineTool({
    name: 'dsh_todo_distiller',
    description: [
      'Normalize todos and schedule events you extracted from text (chat, call, meeting notes, documents).',
      'You read the text, resolve every time expression to an absolute ISO 8601 time yourself (using capturedAt and the time zone as the base),',
      'and pass it as dueAt (todo) or startAt/endAt (schedule), keeping the original wording in timeText.',
      'If you had to assume something (e.g. a date-only deadline taken as 23:59:59), say so in timeAssumption.',
      'A schedule needs a time of day: if the source gives only a date, omit startAt and keep timeText; never invent a placeholder time.',
      'The tool validates times, returns the weekday for each so you can check your arithmetic, links related items, and suggests reminders.',
      'Omit dueAt/startAt only when the source gives no determinable time.',
    ].join(' '),
    parameters: {
      items: req({
        type: 'array',
        description: 'Candidates extracted from the source text, in source order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: req({ type: 'string', enum: ['todo', 'schedule'], description: 'todo: needs doing, optional deadline. schedule: happens at a specific time (meeting, call, appointment).' }),
            title: req({ type: 'string', description: 'Short action or event title.' }),
            description: { type: 'string' },
            assignee: { type: 'string', description: 'Responsible person, as written in the source.' },
            location: { type: 'string', description: 'Place or meeting link (schedule).' },
            priority,
            status: { ...status, description: 'done if the source says it is already finished. Default open.' },
            timeText: { type: 'string', description: 'Time expression exactly as written in the source, e.g. "下周三下午3点", "周五前".' },
            timeAssumption: { type: 'string', description: 'Your interpretation when you assumed something, e.g. "只说了日期,按当天23:59:59".' },
            dueAt: { type: 'string', description: 'Todo deadline, ISO 8601 with offset, e.g. 2025-06-05T23:59:59+08:00. A date-only deadline is the end of that day (23:59:59).' },
            startAt: { type: 'string', description: 'Schedule start, ISO 8601 with offset.' },
            endAt: { type: 'string', description: 'Schedule end, ISO 8601 with offset; must be later than startAt.' },
            durationMinutes: { type: 'integer', description: 'Schedule length in minutes; ignored when endAt is given.' },
            key: { type: 'string', description: 'Your label for this item, so other items can reference it in `related`.' },
            related: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: req({ type: 'string', description: 'The `key` of another item in this call.' }),
                  relation: { type: 'string', description: 'Business relation in your words, e.g. "前置任务", "同一项目".' },
                },
              },
            },
            sourceQuote: { type: 'string', description: 'Original sentence this item came from.' },
            notes: { type: 'string', description: 'Minutes or remarks. Normally empty at extraction time.' },
          },
        },
      }),
      sourceType: req({ type: 'string', enum: ['im', 'phone', 'meeting', 'document'] }),
      sourceName: { type: 'string', description: 'Chat/group name, meeting title, or document name.' },
      sourceRef: { type: 'string', description: 'Message id, timestamp, page, or link locating the source.' },
      capturedAt: { type: 'string', description: 'When the source text was produced, ISO 8601. Reminders earlier than this are dropped. Defaults to now.' },
      timeZone: { type: 'string', description: `IANA time zone. Defaults to ${DEFAULT_TIME_ZONE}.` },
      reminderLeadMinutes: { type: 'integer', description: `Minutes before a start/due time to remind. Defaults to ${DEFAULT_REMINDER_LEAD_MINUTES}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          todos: req({ type: 'array', items: todoOut }),
          schedules: req({ type: 'array', items: scheduleOut }),
          suggestedReminders: req({ type: 'array', items: reminderOut }),
          unresolved: req({ type: 'array', items: unresolvedOut }),
          meta: req({
            type: 'object',
            additionalProperties: false,
            properties: {
              batchId: req(str),
              capturedAt: req(str),
              timeZone: req(str),
              warnings: req({ type: 'array', items: str }),
            },
          }),
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const timeZone = args.timeZone ?? DEFAULT_TIME_ZONE
      if (!isValidTimeZone(timeZone)) throw new ToolArgsError([`timeZone: unknown IANA time zone "${timeZone}"`])
      const input = { ...args, timeZone, reminderLeadMinutes: args.reminderLeadMinutes ?? DEFAULT_REMINDER_LEAD_MINUTES }
      const violations = validate(input)
      let capturedMs = Date.now()
      if (args.capturedAt !== undefined) {
        const parsed = parseInstant(args.capturedAt, timeZone)
        if (parsed === null) violations.push(`capturedAt: not an ISO 8601 date-time: "${args.capturedAt}"`)
        else capturedMs = parsed
      }
      if (violations.length > 0) throw new ToolArgsError(violations)
      const result = distill(input, capturedMs)
      const batchId = saveBatch(result)
      onResult?.(batchId, result)
      return { ...result, meta: { ...result.meta, batchId } }
    },
  }))
}
