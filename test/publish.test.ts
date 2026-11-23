import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { distill } from '../src/distill.ts'
import { buildOsascriptArgv, isNotAuthorized } from '../src/macos/reminders-script.ts'
import { toReminderWrites } from '../src/publish.ts'
import { parseInstant } from '../src/time.ts'

const TZ = 'Asia/Shanghai'
const NOW = parseInstant('2025-06-03T10:00:00', TZ)!

const batch = distill({
  sourceType: 'meeting',
  sourceName: '项目周会',
  timeZone: TZ,
  reminderLeadMinutes: 15,
  items: [
    { kind: 'todo', title: '提交预算表', assignee: '张伟', priority: 'high', timeText: '本周五前', dueAt: '2025-06-06T23:59:59+08:00', sourceQuote: '张伟本周五前提交预算表' },
    { kind: 'todo', title: '联系供应商' },
    { kind: 'schedule', title: '项目周会', startAt: '2025-06-11T10:00:00+08:00', endAt: '2025-06-11T11:30:00+08:00', location: '3号会议室' },
  ],
}, NOW)

describe('toReminderWrites', () => {
  const writes = toReminderWrites(batch)

  it('maps todos then schedules with due dates, alerts and priority', () => {
    assert.deepEqual(writes.map(w => w.id), ['t1', 't2', 's1'])
    assert.equal(writes[0]!.dueAt, '2025-06-06T23:59:59+08:00')
    assert.equal(writes[0]!.remindAt, '2025-06-06T09:00:00+08:00')
    assert.equal(writes[0]!.priority, 1)
    assert.equal(writes[1]!.dueAt, null)
    assert.equal(writes[1]!.priority, 0)
    assert.equal(writes[2]!.dueAt, '2025-06-11T10:00:00+08:00')
    assert.equal(writes[2]!.remindAt, '2025-06-11T09:45:00+08:00')
  })

  it('puts details and the marker in the body', () => {
    const body = writes[0]!.body
    assert.ok(body.includes('负责人: 张伟'))
    assert.ok(body.includes('来源: 项目周会'))
    assert.ok(body.includes('原文: 张伟本周五前提交预算表'))
    assert.ok(body.endsWith(writes[0]!.marker))
    assert.ok(writes[2]!.body.includes('日程: 2025-06-11 10:00 至 2025-06-11 11:30'))
  })

  it('has stable, distinct markers', () => {
    assert.deepEqual(toReminderWrites(batch).map(w => w.marker), writes.map(w => w.marker))
    assert.equal(new Set(writes.map(w => w.marker)).size, 3)
  })

  it('filters by id', () => {
    assert.deepEqual(toReminderWrites(batch, ['s1']).map(w => w.id), ['s1'])
  })
})

describe('osascript bridge', () => {
  it('builds argv with the request as the last argument', () => {
    const argv = buildOsascriptArgv('DSH 助理', [])
    assert.deepEqual(argv.slice(0, 3), ['/usr/bin/osascript', '-l', 'JavaScript'])
    assert.deepEqual(JSON.parse(argv.at(-1)!), { list: 'DSH 助理', items: [] })
  })

  it('recognizes a missing Automation permission', () => {
    assert.equal(isNotAuthorized('execution error: Not authorized to send Apple events to Reminders. (-1743)'), true)
    assert.equal(isNotAuthorized('syntax error'), false)
  })
})

describe('recordToReminderWrite', () => {
  it('rebuilds the same marker, times and fields from a stored item', async () => {
    const { itemsOf } = await import('../src/store.ts')
    const { recordToReminderWrite, isWritable } = await import('../src/publish.ts')
    const items = itemsOf({ id: 'r1', day: '2025-06-03' }, [{ batchId: 'b', result: batch }], [], 'now')
    const writes = toReminderWrites(batch)
    const rebuilt = items.filter(isWritable).map(i => recordToReminderWrite(i, 15, () => undefined))
    assert.deepEqual(rebuilt.map(w => w.marker), writes.map(w => w.marker))
    assert.deepEqual(rebuilt.map(w => [w.dueAt, w.remindAt, w.priority]), writes.map(w => [w.dueAt, w.remindAt, w.priority]))
    assert.ok(rebuilt[0]!.body.includes('负责人: 张伟'))
    assert.ok(rebuilt[2]!.body.includes('日程: 2025-06-11 10:00 至 2025-06-11 11:30'))
  })
})
