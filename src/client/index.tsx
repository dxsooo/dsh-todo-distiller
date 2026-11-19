// Browser half: a sidebar entry and a page where every dropped document is
// queued immediately. Results come from the Host's durable run records.
import { useCallback, useEffect, useState } from 'react'
import type { DragEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

const PANEL_ID = 'todo-distiller'
const API = 'todo-distiller/'
const TEXT_TYPES = /\.(md|markdown|txt)$/i
const POLL_MS = 1500

interface Item {
  id: string
  kind: 'todo' | 'schedule'
  title: string
  at: string | null
  endAt: string | null
  assignee: string | null
  unresolved: string | null
  reminder: 'created' | 'exists' | null
}
interface Run {
  id: string
  name: string
  state: 'queued' | 'running' | 'done' | 'error'
  createdAt: string
  error: string | null
  summary: string | null
  usage: { inputTokens: number, cacheReadTokens: number, outputTokens: number, requests: number } | null
  created: number
  existing: number
  items: Item[]
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, init)
  const body = await res.json().catch(() => ({})) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
const when = (iso: string | null): string => (iso === null ? '' : timeFormat.format(new Date(iso)))

/** Sidebar entry icon: DSH's own checklist glyph at the size the sidebar asks for. */
function Icon({ size }: { size?: number }) {
  return <IconChecklistOutlineRegular size={size} />
}

const muted = { opacity: 0.6 }
const border = '1px solid color-mix(in srgb, currentColor 14%, transparent)'

function ItemRow({ item }: { item: Item }) {
  const mark = item.unresolved !== null ? '?' : item.reminder === 'created' ? '✓' : item.reminder === 'exists' ? '·' : '–'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '16px 1fr auto', gap: 8, alignItems: 'baseline' }}>
      <span aria-hidden="true" style={muted}>{mark}</span>
      <span>
        {item.title}
        {item.assignee !== null && <span style={muted}>{` · ${item.assignee}`}</span>}
        {item.unresolved !== null && <div style={{ ...muted, fontSize: 12 }}>{item.unresolved}</div>}
      </span>
      <span style={{ ...muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {item.kind === 'schedule' && item.at !== null ? `${when(item.at)}${item.endAt !== null ? ` – ${when(item.endAt).slice(-5)}` : ''}` : when(item.at)}
      </span>
    </div>
  )
}

function RunCard({ run }: { run: Run }) {
  const status = run.state === 'queued' ? '排队中' : run.state === 'running' ? '处理中…' : run.state === 'error' ? '失败'
    : run.items.length === 0 ? '没有事项' : `写入 ${run.created} 项${run.existing > 0 ? ` · 已存在 ${run.existing}` : ''}`
  return (
    <li style={{ border, borderRadius: 10, padding: '12px 14px', listStyle: 'none', display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <strong style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.name}</strong>
        <span style={{ ...muted, whiteSpace: 'nowrap' }}>{status}</span>
      </div>
      {run.error !== null && <p role="alert" style={{ margin: 0 }}>{run.error}</p>}
      {run.items.length > 0 && <div style={{ display: 'grid', gap: 6 }}>{run.items.map(item => <ItemRow key={item.id} item={item} />)}</div>}
      {run.usage !== null && (
        <small style={{ opacity: 0.45 }} title={run.summary ?? undefined}>
          {`${when(run.createdAt)} · ${run.usage.inputTokens + run.usage.cacheReadTokens + run.usage.outputTokens} tokens`}
        </small>
      )}
    </li>
  )
}

function Page() {
  const [runs, setRuns] = useState<Run[]>([])
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api<{ runs: Run[] }>('runs').then(body => { setRuns(body.runs); setError(null) }, (e: unknown) => setError(String(e)))
  }, [])

  useEffect(refresh, [refresh])
  const busy = runs.some(r => r.state === 'queued' || r.state === 'running')
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [busy, refresh])

  const start = useCallback((name: string, text: string) => {
    api<{ run: Run }>('runs', {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-todo-distiller-name': encodeURIComponent(name) },
      body: text,
    }).then(body => setRuns(rs => [body.run, ...rs]), (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const files = Array.from(e.dataTransfer.files)
    const rejected = files.filter(f => !TEXT_TYPES.test(f.name)).map(f => f.name)
    setError(rejected.length > 0 ? `暂只支持 .md、.txt:${rejected.join('、')}` : null)
    for (const file of files.filter(f => TEXT_TYPES.test(f.name))) void file.text().then(text => start(file.name, text))
    const text = e.dataTransfer.getData('text/plain')
    if (files.length === 0 && text.trim() !== '') start('粘贴的文字', text)
  }, [start])

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false) }}
      onDrop={onDrop}
      onPaste={(e) => { const text = e.clipboardData.getData('text/plain'); if (text.trim() !== '') start('粘贴的文字', text) }}
      tabIndex={0}
      aria-label="待办助理:把会议记录拖到这里"
      style={{ height: '100%', overflow: 'auto', padding: '32px 40px', boxSizing: 'border-box', outline: 'none' }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto', display: 'grid', gap: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>待办助理</h1>
        <div
          style={{
            border: `1.5px dashed color-mix(in srgb, currentColor ${over ? 60 : 25}%, transparent)`,
            borderRadius: 14,
            padding: '48px 16px',
            textAlign: 'center',
            opacity: over ? 1 : 0.75,
            transition: 'opacity 120ms, border-color 120ms',
          }}
        >
          拖入会议记录,或粘贴文字
        </div>
        {error !== null && <p role="alert" style={{ margin: 0 }}>{error}</p>}
        <ul style={{ margin: 0, padding: 0, display: 'grid', gap: 12 }}>
          {runs.map(run => <RunCard key={run.id} run={run} />)}
        </ul>
      </div>
    </div>
  )
}

interface SlotsContext extends Context {
  slots: {
    inject(name: string, register: () => () => void): void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
}

export const inject = ['slots']

export function apply(ctx: SlotsContext): void {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Page))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: '待办助理' }, Icon))
}
