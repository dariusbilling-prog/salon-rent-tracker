import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { buildThreads, checkKey, ensureTable, loadTenants } from '@/lib/inbox'

export const dynamic = 'force-dynamic'

/**
 * GET /api/inbox/summary -> plain text for the iPhone check-in notification.
 * Empty body when nothing is waiting, so the Shortcut can skip the alert.
 */
export async function GET(req: NextRequest) {
  const denied = checkKey(req)
  if (denied) return denied
  try {
    await ensureTable()
    const [open, tasks, tenants] = await Promise.all([
      prisma.inboxMessage.findMany({ where: { status: 'open' } }),
      prisma.inboxMessage.count({ where: { task: { not: null }, taskDone: false } }),
      loadTenants(),
    ])
    const threads = buildThreads(open, tenants)
    if (threads.length === 0) return new NextResponse('', { headers: { 'content-type': 'text/plain' } })

    const names = threads
      .slice(0, 4)
      .map((t) => (t.tenantName ? `${t.tenantName.split(/[\s,/&]+/)[0]}${t.suite ? ` (${t.suite})` : ''}` : t.sender))
    const more = threads.length > 4 ? ` +${threads.length - 4} more` : ''
    const who = threads.length === 1 ? 'tenant is' : 'tenants are'
    const taskLine = tasks ? ` · ${tasks} open task${tasks === 1 ? '' : 's'}` : ''
    const text = `${threads.length} ${who} waiting: ${names.join(', ')}${more}${taskLine}`
    return new NextResponse(text, { headers: { 'content-type': 'text/plain' } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'summary failed'
    return new NextResponse(`Inbox error: ${message}`, { status: 500 })
  }
}
