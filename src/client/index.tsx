// Browser half: a sidebar entry and a page that runs every dropped document.
import { useCallback, useState } from 'react'
import type { DragEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'

const PANEL_ID = 'todo-distiller'
const API = 'todo-distiller/'
const TEXT_TYPES = /\.(md|markdown|txt)$/i

interface WriteItem { id: string, title: string, status: 'created' | 'exists' }
interface RunResult {
  sessionId: string
  tools: string[]
  writes: Array<{ result: { list: string, created: number, existing: number, items: WriteItem[] } }>
  batches: Array<{ result: { unresolved: Array<{ title: string, reason: string }> } }>
  summary: string | null
  usage: { inputTokens: number, outputTokens: number, requests: number }
  durationMs: number
}
interface Run { key: number, name: string, state: 'running' | 'done' | 'error', result?: RunResult, error?: string }

async function submit(name: string, text: string): Promise<RunResult> {
  const res = await fetch(`${API}run`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-todo-distiller-name': encodeURIComponent(name) },
    body: text,
  })
  const body = await res.json().catch(() => ({})) as { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body as RunResult
}

function Icon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5 6l1.2 1.2L8.5 5M5 10.2l1.2 1.2 2.3-2.2M10 6.3h1.5M10 10.5h1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RunCard({ run }: { run: Run }) {
  const created = run.result?.writes.reduce((n, w) => n + w.result.created, 0) ?? 0
  const existing = run.result?.writes.reduce((n, w) => n + w.result.existing, 0) ?? 0
  const unresolved = run.result?.batches.flatMap(b => b.result.unresolved) ?? []
  return (
    <li style={{ border: '1px solid color-mix(in srgb, currentColor 15%, transparent)', borderRadius: 10, padding: '12px 14px', listStyle: 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <strong style={{ fontWeight: 600 }}>{run.name}</strong>
        <span style={{ opacity: 0.7 }}>
          {run.state === 'running' ? '处理中…' : run.state === 'error' ? '失败' : `已写入 ${created} 项${existing > 0 ? `,${existing} 项已存在` : ''}`}
        </span>
      </div>
      {run.error !== undefined && <p role="alert" style={{ margin: '8px 0 0' }}>{run.error}</p>}
      {run.result !== undefined && (
        <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          {run.result.writes.flatMap(w => w.result.items).map(item => <div key={item.id}>{item.status === 'created' ? '✓' : '·'} {item.title}</div>)}
          {unresolved.map(u => <div key={u.title} style={{ opacity: 0.75 }}>? {u.title}:{u.reason}</div>)}
          <small style={{ opacity: 0.55 }}>
            {`${(run.result.durationMs / 1000).toFixed(1)}s · ${run.result.usage.requests} 次请求 · 输入 ${run.result.usage.inputTokens} / 输出 ${run.result.usage.outputTokens} tokens · ${run.result.sessionId}`}
          </small>
        </div>
      )}
    </li>
  )
}

let nextKey = 1

function Page() {
  const [runs, setRuns] = useState<Run[]>([])
  const [over, setOver] = useState(false)
  const update = useCallback((key: number, patch: Partial<Run>) => setRuns(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r))), [])

  const start = useCallback((name: string, text: string) => {
    const key = nextKey++
    setRuns(rs => [{ key, name, state: 'running' }, ...rs])
    submit(name, text).then(
      result => update(key, { state: 'done', result }),
      (error: unknown) => update(key, { state: 'error', error: error instanceof Error ? error.message : String(error) }),
    )
  }, [update])

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    for (const file of Array.from(e.dataTransfer.files)) {
      if (!TEXT_TYPES.test(file.name)) {
        const key = nextKey++
        setRuns(rs => [{ key, name: file.name, state: 'error', error: '暂只支持 .md、.txt 文件' }, ...rs])
        continue
      }
      void file.text().then(text => start(file.name, text))
    }
    const text = e.dataTransfer.getData('text/plain')
    if (e.dataTransfer.files.length === 0 && text.trim() !== '') start('粘贴的文字', text)
  }, [start])

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false) }}
      onDrop={onDrop}
      onPaste={(e) => { const text = e.clipboardData.getData('text/plain'); if (text.trim() !== '') start('粘贴的文字', text) }}
      tabIndex={0}
      aria-label="把会议记录拖到这里"
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
        <ul style={{ margin: 0, padding: 0, display: 'grid', gap: 12 }}>
          {runs.map(run => <RunCard key={run.key} run={run} />)}
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
