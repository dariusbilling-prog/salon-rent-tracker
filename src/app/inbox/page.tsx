'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
  Undo2,
} from 'lucide-react'

type Thread = {
  key: string
  sender: string
  tenantName: string | null
  suite: string | null
  replyTo: string | null
  firstWaitingAt: string
  messages: { id: string; body: string; receivedAt: string }[]
  draft: string | null
}
type Task = { id: string; task: string; who: string; suite: string | null; from: string; createdAt: string }
type Done = { id: string; who: string; suite: string | null; body: string; reply: string | null; handledAt: string | null }
type InboxData = { threads: Thread[]; tasks: Task[]; recentlyDone: Done[] }

const KEY_STORE = 'inbox-key' // deliberately not "salon-" so it never syncs to the cloud

function readKey(): string {
  try {
    return localStorage.getItem(KEY_STORE) || ''
  } catch {
    return ''
  }
}
function saveKey(k: string) {
  try {
    localStorage.setItem(KEY_STORE, k)
  } catch {
    /* private mode — the key just won't be remembered */
  }
}

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs}h`
  return `${Math.round(hrs / 24)}d`
}
function clock(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}
function smsHref(to: string, body: string): string {
  // iOS and macOS Messages both accept this form.
  return `sms:${to}&body=${encodeURIComponent(body)}`
}

export default function InboxPage() {
  const [key, setKey] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [data, setData] = useState<InboxData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [showDone, setShowDone] = useState(false)

  useEffect(() => {
    const k = readKey()
    setKey(k)
    setKeyInput(k)
  }, [])

  const api = useCallback(
    async (path: string, body?: unknown) => {
      const res = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-inbox-key': key, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      })
      const json = await res.json().catch(() => ({}))
      if (res.status === 401) throw new Error('Wrong inbox key.')
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`)
      return json
    },
    [key]
  )

  const load = useCallback(async () => {
    if (!key) return
    setLoading(true)
    try {
      setData(await api('/api/inbox'))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load inbox')
    } finally {
      setLoading(false)
    }
  }, [api, key])

  useEffect(() => {
    load()
    const t = setInterval(load, 60_000)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 2200)
  }

  if (!key) {
    return (
      <main className="min-h-screen bg-stone-50 flex items-center justify-center p-4">
        <form
          className="w-full max-w-sm bg-white border border-stone-200 rounded-xl p-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            saveKey(keyInput.trim())
            setKey(keyInput.trim())
          }}
        >
          <h1 className="text-lg font-semibold text-stone-900">Tenant Inbox</h1>
          <p className="text-sm text-stone-600">Enter your inbox key (the INBOX_SECRET from Vercel). This device will remember it.</p>
          <input
            className="w-full border border-stone-300 rounded-lg px-3 py-2 text-base"
            type="password"
            autoComplete="current-password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="Inbox key"
          />
          <button className="w-full bg-stone-900 text-white rounded-lg py-2 font-medium">Open inbox</button>
        </form>
      </main>
    )
  }

  const threads = data?.threads || []
  const tasks = data?.tasks || []

  return (
    <main className="min-h-screen bg-stone-50 pb-16">
      <header className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-stone-200">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <a href="/" className="text-stone-500 hover:text-stone-900" aria-label="Back to rent tracker">
            <ArrowLeft size={20} />
          </a>
          <div className="flex-1">
            <h1 className="text-base font-semibold text-stone-900 leading-tight">Tenant Inbox</h1>
            <p className="text-xs text-stone-500">
              {threads.length === 0 ? 'All caught up' : `${threads.length} waiting for a reply`}
              {tasks.length ? ` · ${tasks.length} task${tasks.length === 1 ? '' : 's'}` : ''}
            </p>
          </div>
          <button onClick={load} className="p-2 rounded-lg hover:bg-stone-100 text-stone-600" aria-label="Refresh">
            {loading ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
          </button>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 pt-4 space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg p-3 flex items-center justify-between gap-3">
            <span>{error}</span>
            {error.startsWith('Wrong') && (
              <button
                className="underline"
                onClick={() => {
                  saveKey('')
                  setKey('')
                }}
              >
                Change key
              </button>
            )}
          </div>
        )}

        {data && threads.length === 0 && (
          <div className="bg-white border border-stone-200 rounded-xl p-6 text-center text-stone-600">
            <CheckCircle2 className="mx-auto mb-2 text-emerald-600" size={28} />
            Nobody is waiting on you.
          </div>
        )}

        {threads.map((t) => (
          <ThreadCard key={t.key} thread={t} api={api} onChanged={load} flash={flash} />
        ))}

        {tasks.length > 0 && (
          <section className="bg-white border border-stone-200 rounded-xl">
            <h2 className="px-4 pt-3 pb-2 text-sm font-semibold text-stone-900 flex items-center gap-2">
              <ClipboardList size={16} /> To-do from texts
            </h2>
            <ul className="divide-y divide-stone-100">
              {tasks.map((task) => (
                <li key={task.id} className="px-4 py-3 flex items-start gap-3">
                  <button
                    className="mt-0.5 w-5 h-5 rounded border border-stone-400 flex items-center justify-center hover:bg-emerald-50"
                    aria-label="Mark task done"
                    onClick={async () => {
                      await api('/api/inbox/action', { action: 'taskdone', id: task.id })
                      flash('Task done')
                      load()
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-stone-900">{task.task}</div>
                    <div className="text-xs text-stone-500 truncate">
                      {task.who}
                      {task.suite ? ` · Suite ${task.suite}` : ''} · “{task.from}”
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data && data.recentlyDone.length > 0 && (
          <section>
            <button className="text-sm text-stone-500 underline" onClick={() => setShowDone((s) => !s)}>
              {showDone ? 'Hide' : 'Show'} recently handled ({data.recentlyDone.length})
            </button>
            {showDone && (
              <ul className="mt-2 space-y-2">
                {data.recentlyDone.map((d) => (
                  <li key={d.id} className="bg-white border border-stone-200 rounded-lg p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-stone-800">
                        {d.who}
                        {d.suite ? ` · ${d.suite}` : ''}
                      </span>
                      <button
                        className="text-xs text-stone-500 flex items-center gap-1 hover:text-stone-900"
                        onClick={async () => {
                          await api('/api/inbox/action', { action: 'reopen', ids: [d.id] })
                          load()
                        }}
                      >
                        <Undo2 size={12} /> Reopen
                      </button>
                    </div>
                    <p className="text-stone-600 mt-1">“{d.body}”</p>
                    {d.reply && <p className="text-stone-500 mt-1">↳ {d.reply}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-stone-900 text-white text-sm px-4 py-2 rounded-full shadow-lg">
          {toast}
        </div>
      )}
    </main>
  )
}

function ThreadCard({
  thread,
  api,
  onChanged,
  flash,
}: {
  thread: Thread
  api: (path: string, body?: unknown) => Promise<any>
  onChanged: () => void
  flash: (m: string) => void
}) {
  const ids = thread.messages.map((m) => m.id)
  const [draft, setDraft] = useState(thread.draft || '')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState<'' | 'draft' | 'done'>('')
  const [taskOpen, setTaskOpen] = useState(false)
  const [taskText, setTaskText] = useState('')
  const [err, setErr] = useState('')

  const title = thread.tenantName || thread.sender
  const waiting = ago(thread.firstWaitingAt)
  const hours = (Date.now() - new Date(thread.firstWaitingAt).getTime()) / 3600000
  const badge = hours >= 24 ? 'bg-red-100 text-red-800' : hours >= 4 ? 'bg-amber-100 text-amber-800' : 'bg-stone-100 text-stone-700'

  const writeDraft = async () => {
    setBusy('draft')
    setErr('')
    try {
      const res = await api('/api/inbox/draft', { ids, instructions })
      setDraft(res.draft || '')
      setInstructions('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not write a draft')
    } finally {
      setBusy('')
    }
  }

  const markDone = async (reply?: string) => {
    setBusy('done')
    try {
      await api('/api/inbox/action', { action: 'done', ids, reply })
      onChanged()
    } finally {
      setBusy('')
    }
  }

  return (
    <article className="bg-white border border-stone-200 rounded-xl overflow-hidden">
      <div className="px-4 pt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-stone-900 truncate">{title}</h2>
          <p className="text-xs text-stone-500">
            {thread.suite ? `Suite ${thread.suite}` : thread.tenantName ? '' : 'Not matched to a tenant'}
          </p>
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${badge}`}>waiting {waiting}</span>
      </div>

      <ul className="px-4 pt-2 space-y-1.5">
        {thread.messages.map((m) => (
          <li key={m.id} className="bg-stone-100 rounded-2xl rounded-tl-sm px-3 py-2 text-sm text-stone-900 w-fit max-w-full">
            <p className="whitespace-pre-wrap break-words">{m.body}</p>
            <p className="text-[11px] text-stone-500 mt-0.5">{clock(m.receivedAt)}</p>
          </li>
        ))}
      </ul>

      <div className="p-4 space-y-2">
        {draft ? (
          <textarea
            className="w-full border border-stone-300 rounded-lg px-3 py-2 text-base leading-snug min-h-[96px]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => api('/api/inbox/action', { action: 'draft', ids, text: draft }).catch(() => {})}
          />
        ) : null}

        <div className="flex gap-2">
          <input
            className="flex-1 min-w-0 border border-stone-300 rounded-lg px-3 py-2 text-sm"
            placeholder={draft ? 'Change it… e.g. "say no politely"' : 'Optional: what to say, e.g. "approve it"'}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') writeDraft()
            }}
          />
          <button
            onClick={writeDraft}
            disabled={busy !== ''}
            className="shrink-0 flex items-center gap-1.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg px-3"
          >
            {busy === 'draft' ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {draft ? 'Rewrite' : 'Draft reply'}
          </button>
        </div>
        {err && <p className="text-sm text-red-700">{err}</p>}

        <div className="flex flex-wrap gap-2 pt-1">
          {draft && thread.replyTo && (
            <a
              href={smsHref(thread.replyTo, draft)}
              onClick={() => markDone(draft)}
              className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg px-3 py-2"
            >
              <Send size={15} /> Reply in Messages
            </a>
          )}
          {draft && (
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(draft)
                  flash('Copied — paste it in Messages')
                } catch {
                  flash('Copy failed — select the text instead')
                }
              }}
              className="flex items-center gap-1.5 border border-stone-300 hover:bg-stone-50 text-stone-800 text-sm rounded-lg px-3 py-2"
            >
              <Copy size={15} /> Copy
            </button>
          )}
          <button
            onClick={() => markDone(draft || undefined)}
            disabled={busy !== ''}
            className="flex items-center gap-1.5 border border-stone-300 hover:bg-stone-50 text-stone-800 text-sm rounded-lg px-3 py-2"
          >
            <Check size={15} /> Mark done
          </button>
          <button
            onClick={() => setTaskOpen((o) => !o)}
            className="flex items-center gap-1.5 border border-stone-300 hover:bg-stone-50 text-stone-800 text-sm rounded-lg px-3 py-2"
          >
            <ClipboardList size={15} /> Make task
          </button>
        </div>

        {!thread.replyTo && draft && (
          <p className="text-xs text-stone-500 flex items-center gap-1">
            <MessageSquare size={12} /> No phone number on file for this sender — use Copy, then paste in Messages.
          </p>
        )}

        {taskOpen && (
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault()
              if (!taskText.trim()) return
              await api('/api/inbox/action', { action: 'task', id: ids[ids.length - 1], text: taskText })
              setTaskText('')
              setTaskOpen(false)
              flash('Added to your to-do list')
              onChanged()
            }}
          >
            <input
              autoFocus
              className="flex-1 min-w-0 border border-stone-300 rounded-lg px-3 py-2 text-sm"
              placeholder="e.g. Measure window for decal"
              value={taskText}
              onChange={(e) => setTaskText(e.target.value)}
            />
            <button className="bg-stone-900 text-white text-sm rounded-lg px-3">Add</button>
          </form>
        )}
      </div>
    </article>
  )
}
