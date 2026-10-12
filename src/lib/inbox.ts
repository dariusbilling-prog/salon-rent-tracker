// Tenant text inbox — server-side helpers.
//
// Texts reach us from an iPhone Shortcuts automation ("When I get a message
// from…" → POST /api/inbox/inbound). Nothing here depends on a Mac being awake.
//
// Every inbox route requires INBOX_SECRET, sent as the `x-inbox-key` header
// (or `?key=` for links). The rest of the app has no login, and these are
// tenants' private messages, so they are never served without it.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from './db'
import type { Tenant } from '@/types'

export type InboxRow = {
  id: string
  sender: string
  phone: string | null
  body: string
  receivedAt: Date
  tenantId: string | null
  tenantName: string | null
  suite: string | null
  status: string
  draft: string | null
  reply: string | null
  handledAt: Date | null
  task: string | null
  taskDone: boolean
}

/** Returns a 401 response when the request lacks the inbox key, else null. */
export function checkKey(req: NextRequest): NextResponse | null {
  const secret = process.env.INBOX_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'INBOX_SECRET is not set in Vercel environment variables.' },
      { status: 500 }
    )
  }
  const given = req.headers.get('x-inbox-key') || req.nextUrl.searchParams.get('key')
  if (given !== secret) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return null
}

let tableReady: Promise<void> | null = null

/**
 * Create the table on first use so deploying is enough — no `prisma db push`
 * step. Matches the InboxMessage model in prisma/schema.prisma.
 */
export function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "InboxMessage" (
          "id" TEXT NOT NULL,
          "sender" TEXT NOT NULL,
          "phone" TEXT,
          "body" TEXT NOT NULL,
          "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "tenantId" TEXT,
          "tenantName" TEXT,
          "suite" TEXT,
          "status" TEXT NOT NULL DEFAULT 'open',
          "draft" TEXT,
          "reply" TEXT,
          "handledAt" TIMESTAMP(3),
          "task" TEXT,
          "taskDone" BOOLEAN NOT NULL DEFAULT false,
          CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("id")
        )`)
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "InboxMessage_status_idx" ON "InboxMessage"("status")`
      )
    })().catch((err) => {
      tableReady = null // retry next request
      throw err
    })
  }
  return tableReady
}

export function newInboxId(): string {
  return `in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Last 10 digits, or null if the string is not a US-style phone number. */
export function phoneDigits(s: string | null | undefined): string | null {
  if (!s) return null
  const d = s.replace(/\D/g, '')
  if (d.length === 10) return d
  if (d.length === 11 && d.startsWith('1')) return d.slice(1)
  return null
}

export async function loadTenants(): Promise<Tenant[]> {
  const row = await prisma.appState.findUnique({ where: { key: 'salon-tenants' } })
  const list = row?.json
  return Array.isArray(list) ? (list as unknown as Tenant[]) : []
}

// Words in contact names that say nothing about who the person is.
const NOISE = new Set(['suite', 'suites', 'hair', 'stylist', 'salon', 'nails', 'lashes', 'brows', 'barber', 'the', 'and', 'iphone'])

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !NOISE.has(w))
}

/**
 * True when two names are a spelling slip apart: one letter for short names
 * (Kelli/Kellli, Leah/Leeah), two for names of six letters or more (Stacie/Stacey).
 */
function nearlySame(a: string, b: string): boolean {
  if (a === b) return true
  const shorter = Math.min(a.length, b.length)
  if (shorter < 4) return false
  const allowed = shorter >= 6 ? 2 : 1
  if (Math.abs(a.length - b.length) > allowed) return false
  // Levenshtein distance, small strings only.
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length] <= allowed
}

/**
 * Work out which tenant a text came from. The Shortcut usually sends the
 * contact name as saved on the phone ("Leah Suite 135"), sometimes a raw number.
 *
 * Phone contact names drift from the tracker — old suite numbers, different
 * spellings — so names decide and the suite number only breaks ties:
 *   exact name word +3, one-letter-off name word +2, suite number +1.
 * A sender with no name words at all (just "Suite 122") falls back to the suite.
 */
export function matchTenant(sender: string, phone: string | null, tenants: Tenant[]): Tenant | null {
  const active = tenants.filter((t) => t.isActive !== false && !t.isArchived)

  const digits = phoneDigits(phone) || phoneDigits(sender)
  if (digits) {
    const byPhone = active.find((t) => phoneDigits(t.phone) === digits)
    if (byPhone) return byPhone
  }

  const senderWords = words(sender)
  const senderSuites: string[] = phoneDigits(sender) ? [] : sender.match(/\b\d{3}\b/g) || []

  let best: Tenant | null = null
  let bestScore = 0
  let tie = false
  for (const t of active) {
    const nameWords = words(`${t.name} ${t.secondName || ''}`)
    const suites = String(t.suiteNumber).split(/[^0-9]+/).filter(Boolean)
    let score = 0
    for (const w of senderWords) {
      if (nameWords.includes(w)) score += 3
      else if (nameWords.some((n) => nearlySame(n, w))) score += 2
    }
    if (senderSuites.some((s) => suites.includes(s))) score += 1
    if (score > bestScore) {
      best = t
      bestScore = score
      tie = false
    } else if (score === bestScore && score > 0) {
      tie = true
    }
  }
  if (!best || tie) return null
  // A bare suite number only counts when the sender had no name to go on.
  if (bestScore < 2 && senderWords.length > 0) return null
  return best
}

/** Messages from the same person share a thread key. */
export function threadKeyOf(m: Pick<InboxRow, 'tenantId' | 'phone' | 'sender'>): string {
  if (m.tenantId) return `t:${m.tenantId}`
  const d = phoneDigits(m.phone) || phoneDigits(m.sender)
  if (d) return `p:${d}`
  return `s:${m.sender.trim().toLowerCase()}`
}

export type Thread = {
  key: string
  sender: string
  tenantName: string | null
  suite: string | null
  /** Number to put in the sms: link, if we know one. */
  replyTo: string | null
  firstWaitingAt: string
  messages: { id: string; body: string; receivedAt: string }[]
  draft: string | null
}

export function buildThreads(open: InboxRow[], tenants: Tenant[]): Thread[] {
  const byKey = new Map<string, InboxRow[]>()
  for (const m of open) {
    const k = threadKeyOf(m)
    byKey.set(k, [...(byKey.get(k) || []), m])
  }
  const threads: Thread[] = []
  byKey.forEach((rows, key) => {
    rows.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
    const latest = rows[rows.length - 1]
    const tenant = latest.tenantId ? tenants.find((t) => t.id === latest.tenantId) : undefined
    const num = phoneDigits(tenant?.phone) || phoneDigits(latest.phone) || phoneDigits(latest.sender)
    threads.push({
      key,
      sender: latest.sender,
      tenantName: latest.tenantName,
      suite: latest.suite,
      replyTo: num ? `+1${num}` : null,
      firstWaitingAt: rows[0].receivedAt.toISOString(),
      messages: rows.map((r) => ({ id: r.id, body: r.body, receivedAt: r.receivedAt.toISOString() })),
      draft: [...rows].reverse().find((r) => r.draft)?.draft ?? null,
    })
  })
  // Longest-waiting first.
  threads.sort((a, b) => a.firstWaitingAt.localeCompare(b.firstWaitingAt))
  return threads
}
