import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { distill, validate } from '../src/distill.ts'
import type { Candidate, DistillInput } from '../src/distill.ts'
import { formatIso, parseInstant, weekdayName } from '../src/time.ts'

const TZ = 'Asia/Shanghai'
// 2025-06-03 is a Tuesday.
const NOW = parseInstant('2025-06-03T10:00:00', TZ)!

function input(items: Candidate[], extra: Partial<DistillInput> = {}): DistillInput {
  return { items, sourceType: 'meeting', timeZone: TZ, reminderLeadMinutes: 15, ...extra }
}

describe('time helpers', () => {
  it('reads offset-less text in the given zone and keeps explicit offsets', () => {
    assert.equal(formatIso(parseInstant('2025-06-05T23:59:59', TZ)!, TZ), '2025-06-05T23:59:59+08:00')
    assert.equal(formatIso(parseInstant('2025-06-05T15:59:59Z', TZ)!, TZ), '2025-06-05T23:59:59+08:00')
    assert.equal(formatIso(parseInstant('2025-06-05T23:59:59+0800', TZ)!, 'America/New_York'), '2025-06-05T11:59:59-04:00')
  })

  it('rejects date-only and malformed text', () => {
    assert.equal(parseInstant('2025-06-05', TZ), null)
    assert.equal(parseInstant('周五', TZ), null)
    assert.equal(parseInstant('2025-13-05T10:00:00', TZ), null)
  })

  it('names the weekday', () => {
    assert.equal(weekdayName(parseInstant('2025-06-05T23:59:59', TZ)!, TZ), '周四')
  })
})

describe('validate', () => {
  it('reports malformed times, wrong fields, ordering, and duplicate keys', () => {
    const v = validate(input([
      { kind: 'todo', title: 'a', key: 'k', dueAt: '周五前' },
      { kind: 'todo', title: ' ', key: 'k', startAt: '2025-06-05T10:00:00' },
      { kind: 'schedule', title: 'c', startAt: '2025-06-05T10:00:00', endAt: '2025-06-05T09:00:00' },
      { kind: 'schedule', title: 'd', dueAt: '2025-06-05T10:00:00' },
    ]))
    assert.equal(v.length, 6)
    assert.ok(v.some(x => x.includes('items[0].dueAt')))
    assert.ok(v.some(x => x.includes('not unique')))
    assert.ok(v.some(x => x.includes('endAt must be later')))
  })

  it('accepts a clean input', () => {
    assert.deepEqual(validate(input([{ kind: 'todo', title: 'a', dueAt: '2025-06-05T23:59:59+08:00' }])), [])
  })
})

describe('distill: Chinese samples', () => {
  it('meeting minutes with todos and relative times', () => {
    const out = distill(input([
      { kind: 'todo', key: 'a', title: '提交预算表', assignee: '张伟', timeText: '本周五前', dueAt: '2025-06-06T23:59:59+08:00', timeAssumption: '周五前包含周五,按周五23:59:59', sourceQuote: '张伟本周五前提交预算表' },
      { kind: 'todo', key: 'b', title: '评审预算', timeText: '下周一下午2点', dueAt: '2025-06-09T14:00:00+08:00', related: [{ key: 'a', relation: '前置任务' }] },
      { kind: 'schedule', title: '项目周会', timeText: '下周三上午10点', startAt: '2025-06-11T10:00:00+08:00', endAt: '2025-06-11T11:30:00+08:00', location: '3号会议室' },
      { kind: 'todo', title: '联系供应商', timeText: '尽快' },
    ], { sourceName: '项目周会' }), NOW)

    assert.equal(out.todos[0]!.dueAt, '2025-06-06T23:59:59+08:00')
    assert.equal(out.todos[0]!.dueWeekday, '周五')
    assert.equal(out.todos[0]!.timeAssumption, '周五前包含周五,按周五23:59:59')
    assert.deepEqual(out.todos[1]!.related, [{ id: 't1', relation: '前置任务' }])
    assert.equal(out.schedules[0]!.startWeekday, '周三')
    assert.equal(out.schedules[0]!.endAt, '2025-06-11T11:30:00+08:00')
    assert.equal(out.todos[2]!.dueAt, null)
    assert.equal(out.unresolved.length, 1)
    assert.equal(out.unresolved[0]!.itemId, 't3')
    // An end-of-day deadline reminds at 09:00 that day; timed items remind 15 minutes ahead.
    const remindAts = out.suggestedReminders.map(r => `${r.targetId}@${r.remindAt}`)
    assert.deepEqual(remindAts, ['t1@2025-06-06T09:00:00+08:00', 't2@2025-06-09T13:45:00+08:00', 's1@2025-06-11T09:45:00+08:00'])
  })

  it('WeChat message with a todo and a deadline', () => {
    const out = distill(input([
      { kind: 'todo', title: '把合同盖章寄给客户', timeText: '周五下午5点前', dueAt: '2025-06-06T17:00:00+08:00', priority: 'high', sourceQuote: '合同周五下午5点前务必寄出' },
    ], { sourceType: 'im', sourceName: '客户群', sourceRef: 'msg-123' }), NOW)
    assert.equal(out.todos[0]!.dueAt, '2025-06-06T17:00:00+08:00')
    assert.equal(out.todos[0]!.dueWeekday, '周五')
    assert.deepEqual(out.todos[0]!.source, { type: 'im', name: '客户群', ref: 'msg-123' })
    assert.equal(out.suggestedReminders[0]!.remindAt, '2025-06-06T16:45:00+08:00')
    assert.equal(out.unresolved.length, 0)
  })

  it('document outline with milestones; a schedule without a time is unresolved', () => {
    const out = distill(input([
      { kind: 'todo', key: 'm1', title: '需求冻结', timeText: '6月20日', dueAt: '2025-06-20T23:59:59+08:00' },
      { kind: 'todo', key: 'm2', title: '联调完成', timeText: '7月15日前', dueAt: '2025-07-15T23:59:59+08:00', related: [{ key: 'm1' }] },
      { kind: 'schedule', title: '上线评审', timeText: '8月1日' },
    ], { sourceType: 'document', sourceName: '项目计划.pptx' }), NOW)
    assert.equal(out.todos.length, 2)
    assert.equal(out.schedules.length, 0)
    assert.equal(out.unresolved[0]!.title, '上线评审')
    assert.equal(out.unresolved[0]!.itemId, null)
  })

  it('computes end from duration, skips past reminders, and warns', () => {
    const out = distill(input([
      { kind: 'schedule', title: '电话会', startAt: '2025-06-04T15:00:00+08:00', durationMinutes: 30, related: [{ key: 'nope' }] },
      { kind: 'todo', title: '回电话', dueAt: '2025-06-03T09:00:00+08:00' },
    ]), NOW)
    assert.equal(out.schedules[0]!.endAt, '2025-06-04T15:30:00+08:00')
    assert.equal(out.suggestedReminders.length, 1)
    assert.ok(out.meta.warnings.some(w => w.includes('nope')))
    assert.ok(out.meta.warnings.some(w => w.includes('截止时间早于捕获时间')))
    assert.ok(out.meta.warnings.some(w => w.includes('提醒')))
  })
})
