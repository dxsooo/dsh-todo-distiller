import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { distill } from '../src/distill.ts'
import { itemsOf } from '../src/store.ts'
import { parseInstant } from '../src/time.ts'
import { dayOf } from '../src/runner.ts'

const TZ = 'Asia/Shanghai'
const NOW = parseInstant('2025-06-03T10:00:00', TZ)!

describe('itemsOf', () => {
  const result = distill({
    sourceType: 'meeting', sourceName: '周会.md', timeZone: TZ, reminderLeadMinutes: 15,
    items: [
      { kind: 'todo', title: '提交预算表', assignee: '张伟', timeText: '周五前', dueAt: '2025-06-06T23:59:59+08:00' },
      { kind: 'todo', title: '联系供应商', timeText: '尽快' },
      { kind: 'schedule', title: '周会', startAt: '2025-06-11T10:00:00+08:00', endAt: '2025-06-11T11:30:00+08:00' },
      { kind: 'schedule', title: '上线评审', timeText: '8月1日' },
    ],
  }, NOW)
  const writes = [{ batchId: 'b1', result: { list: 'L', created: 2, existing: 1, items: [
    { id: 't1', title: '提交预算表', status: 'created' as const },
    { id: 't2', title: '联系供应商', status: 'exists' as const },
    { id: 's1', title: '周会', status: 'created' as const },
  ] } }]
  const items = itemsOf({ id: 'r1', day: '2025-06-03' }, [{ batchId: 'b1', result }], writes, '2025-06-03T10:01:00+08:00')

  it('records todos, schedules and unemitted schedules', () => {
    assert.deepEqual(items.map(i => i.title), ['提交预算表', '联系供应商', '周会', '上线评审'])
    assert.equal(items[0]!.at, '2025-06-06T23:59:59+08:00')
    assert.equal(items[0]!.reminder, 'created')
    assert.equal(items[1]!.reminder, 'exists')
    assert.ok(items[1]!.unresolved !== null)
    assert.equal(items[2]!.endAt, '2025-06-11T11:30:00+08:00')
    assert.equal(items[3]!.reminder, null)
    assert.equal(items[3]!.id, 'r1:1')
  })

  it('uses the stable marker digest as the item id', () => {
    const again = itemsOf({ id: 'r2', day: '2025-06-04' }, [{ batchId: 'b2', result }], [], 'x')
    assert.equal(again[0]!.id, items[0]!.id)
    assert.match(items[0]!.id, /^[0-9a-f]{12}$/)
  })
})

describe('dayOf', () => {
  it('uses the Shanghai calendar day', () => {
    assert.equal(dayOf(Date.parse('2025-06-03T16:30:00Z')), '2025-06-04')
    assert.equal(dayOf(Date.parse('2025-06-03T15:59:00Z')), '2025-06-03')
  })
})
