import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { checkKey, ensureTable, loadTenants, matchTenant } from '@/lib/inbox'

export const dynamic = 'force-dynamic'

/**
 * POST /api/inbox/action
 *   { action: 'done',     ids: string[], reply?: string }  — handled (reply = what was sent)
 *   { action: 'reopen',   ids: string[] }
 *   { action: 'draft',    ids: string[], text: string }    — save an edited draft
 *   { action: 'task',     id: string,    text: string }    — add to the to-do list
 *   { action: 'taskdone', id: string }
 *   { action: 'rematch' }                                  — re-run tenant matching on open messages
 */
export async function POST(req: NextRequest) {
  const denied = checkKey(req)
  if (denied) return denied
  const { action, ids, id, text, reply } = (await req.json().catch(() => ({}))) as {
    action?: string
    ids?: string[]
    id?: string
    text?: string
    reply?: string
  }
  try {
    await ensureTable()
    switch (action) {
      case 'done':
        await prisma.inboxMessage.updateMany({
          where: { id: { in: ids || [] } },
          data: { status: 'done', handledAt: new Date(), reply: reply ?? null },
        })
        break
      case 'reopen':
        await prisma.inboxMessage.updateMany({
          where: { id: { in: ids || [] } },
          data: { status: 'open', handledAt: null },
        })
        break
      case 'draft': {
        const last = (ids || [])[ids!.length - 1]
        if (last) await prisma.inboxMessage.update({ where: { id: last }, data: { draft: text ?? '' } })
        break
      }
      case 'task':
        if (!id || !text?.trim()) return NextResponse.json({ error: 'id and text required' }, { status: 400 })
        await prisma.inboxMessage.update({ where: { id }, data: { task: text.trim(), taskDone: false } })
        break
      case 'taskdone':
        if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
        await prisma.inboxMessage.update({ where: { id }, data: { taskDone: true } })
        break
      case 'rematch': {
        const [open, tenants] = await Promise.all([
          prisma.inboxMessage.findMany({ where: { status: 'open' } }),
          loadTenants(),
        ])
        for (const m of open) {
          const t = matchTenant(m.sender, m.phone, tenants)
          await prisma.inboxMessage.update({
            where: { id: m.id },
            data: {
              tenantId: t?.id ?? null,
              tenantName: t?.name ?? null,
              suite: t?.suiteNumber ? String(t.suiteNumber) : null,
            },
          })
        }
        return NextResponse.json({ ok: true, rematched: open.length })
      }
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'update failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
