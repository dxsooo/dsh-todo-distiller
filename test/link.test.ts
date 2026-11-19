import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { distill, validate } from '../src/distill.ts'
import type { DistillInput } from '../src/distill.ts'
import { itemIdOf } from '../src/item-id.ts'
import { toReminderWrites } from '../src/publish.ts'
import { itemsOf, openItems, renderIndex } from '../src/store.ts'
import type { ItemRecord } from '../src/store.ts'
import { parseInstant } from '../src/time.ts'

const TZ = 'Asia/Shanghai'
const NOW = parseInstant('2025-06-10T10:00:00', TZ)!
const OLD = 'abcdef012345'

const input = (extra: Partial<DistillInput> = {}): DistillInput => ({
  sourceType: 'meeting', sourceName: '周会2.md', timeZone: TZ, reminderLeadMinutes: 15,
  items: [
    { kind: 'todo', key: 'a', title: '评审预算', dueAt: '2025-06-12T14:00:00+08:00', related: [{ itemId: OLD, relation: '后续' }] },
    { kind: 'todo', title: '发会议纪要', related: [{ key: 'a' }, { itemId: 'unknown00000' }] },
  ],
  ...extra,
})

describe('item ids', () => {
  it('keeps the digest used by markers written before this change', () => {
    assert.equal(itemIdOf('todo', '提交预算表', '2025-06-06T23:59:59+08:00', '周会.md', null), 'a0c8007197f6')
  })

  it('returns the itemId on every item and uses it as the Reminders marker', () => {
    const out = distill(input({ isKnownItem: id => id === OLD }), NOW)
    const writes = toReminderWrites(out)
    assert.equal(writes[0]!.marker, `dsh-todo-distiller:${out.todos[0]!.itemId}`)
  })
})

describe('relations to recorded items', () => {
  it('requires exactly one of key or itemId', () => {
    const bad = validate({ ...input(), items: [{ kind: 'todo', title: 'x', related: [{ key: 'a', itemId: OLD }, {}] }] })
    assert.equal(bad.filter(v => v.includes('exactly one')).length, 2)
  })

  it('keeps known store ids, ignores unknown ones with a warning', () => {
    const out = distill(input({ isKnownItem: id => id === OLD }), NOW)
    assert.deepEqual(out.todos[0]!.related, [{ id: OLD, scope: 'store', relation: '后续' }])
    assert.deepEqual(out.todos[1]!.related, [{ id: 't1', scope: 'batch', relation: null }])
    assert.ok(out.meta.warnings.some(w => w.includes('unknown00000')))
  })

  it('records relations as stable ids and names them in the reminder note', () => {
    const out = distill(input({ isKnownItem: id => id === OLD }), NOW)
    const items = itemsOf({ id: 'r9', day: '2025-06-10' }, [{ batchId: 'b', result: out }], [], 'now')
    assert.deepEqual(items[0]!.related, [{ itemId: OLD, relation: '后续' }])
    assert.deepEqual(items[1]!.related, [{ itemId: out.todos[0]!.itemId, relation: null }])
    const writes = toReminderWrites(out, undefined, id => (id === OLD ? '提交预算表' : undefined))
    assert.ok(writes[0]!.body.includes('关联: 提交预算表(后续)'))
    assert.ok(writes[1]!.body.includes('关联: 评审预算'))
  })
})

describe('已有事项 index', () => {
  const base = { runId: 'r', day: '2025-06-03', endAt: null, location: null, timeText: null, timeAssumption: null, sourceQuote: null, unresolved: null, related: [], reminder: null } as const
  const rec = (id: string, over: Partial<ItemRecord>): ItemRecord => ({ ...base, id, kind: 'todo', title: id, at: null, assignee: null, status: 'open', sourceName: '周会.md', createdAt: '2025-06-03T10:00:00+08:00', ...over })
  const items = [
    rec('future', { at: '2025-06-20T23:59:59+08:00', assignee: '陈静' }),
    rec('undated', {}),
    rec('stale', { at: '2025-04-01T23:59:59+08:00' }),
    rec('done', { status: 'done' }),
    rec('mine', { runId: 'today' }),
  ]

  it('selects open, recent items outside the current Session', () => {
    const picked = openItems(items, NOW, 30, 10, i => i.runId === 'today')
    assert.deepEqual(picked.map(i => i.id), ['future', 'undated'])
    assert.deepEqual(openItems(items, NOW, 30, 1, () => false).map(i => i.id).length, 1)
  })

  it('renders one line per item with its id', () => {
    const text = renderIndex(openItems(items, NOW, 30, 10, i => i.runId === 'today'))
    assert.match(text, /^已有事项/)
    assert.ok(text.includes('[future] | 待办 | future | 截止 '))
    assert.ok(text.includes('陈静'))
    assert.ok(text.includes('[undated] | 待办 | undated | 无时间'))
    assert.equal(renderIndex([]), '')
  })
})
