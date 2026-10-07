import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { buildThreads, checkKey, ensureTable, loadTenants } from '@/lib/inbox'

export const dynamic = 'force-dynamic'

// GET /api/inbox -> { threads, tasks, recentlyDone }
export async function GET(req: NextRequest) {
  const denied = checkKey(req)
  if (denied) return denied
  try {
    await ensureTable()
    const [open, tasks, done, tenants] = await Promise.all([
      prisma.inboxMessage.findMany({ where: { status: 'open' }, orderBy: { receivedAt: 'asc' } }),
      prisma.inboxMessage.findMany({
        where: { task: { not: null }, taskDone: false },
        orderBy: { receivedAt: 'asc' },
      }),
      prisma.inboxMessage.findMany({
        where: { status: 'done', handledAt: { gte: new Date(Date.now() - 2 * 24 * 3600 * 1000) } },
        orderBy: { handledAt: 'desc' },
        take: 15,
      }),
      loadTenants(),
    ])
    return NextResponse.json({
      threads: buildThreads(open, tenants),
      tasks: tasks.map((t) => ({
        id: t.id,
        task: t.task,
        who: t.tenantName || t.sender,
        suite: t.suite,
        from: t.body,
        createdAt: t.receivedAt.toISOString(),
      })),
      recentlyDone: done.map((d) => ({
        id: d.id,
        who: d.tenantName || d.sender,
        suite: d.suite,
        body: d.body,
        reply: d.reply,
        handledAt: d.handledAt?.toISOString() ?? null,
      })),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'load failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
