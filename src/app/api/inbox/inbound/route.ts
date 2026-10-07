import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { checkKey, ensureTable, loadTenants, matchTenant, newInboxId, phoneDigits } from '@/lib/inbox'

export const dynamic = 'force-dynamic'

/**
 * POST /api/inbox/inbound  { sender, body, phone? }
 * Called by the iPhone Shortcuts automation for every incoming tenant text.
 * Accepts JSON or form fields, since Shortcuts can send either.
 */
export async function POST(req: NextRequest) {
  const denied = checkKey(req)
  if (denied) return denied

  let input: Record<string, unknown> = {}
  const type = req.headers.get('content-type') || ''
  try {
    if (type.includes('application/json')) {
      input = (await req.json()) as Record<string, unknown>
    } else {
      const form = await req.formData()
      form.forEach((v, k) => (input[k] = typeof v === 'string' ? v : ''))
    }
  } catch {
    return NextResponse.json({ error: 'could not read body' }, { status: 400 })
  }

  const sender = String(input.sender ?? '').trim() || 'Unknown'
  const body = String(input.body ?? input.content ?? input.message ?? '').trim()
  const rawPhone = String(input.phone ?? '').trim()
  if (!body) return NextResponse.json({ ok: true, skipped: 'empty message' })

  try {
    await ensureTable()
    const tenants = await loadTenants()
    const phone = phoneDigits(rawPhone) || phoneDigits(sender)
    const tenant = matchTenant(sender, phone, tenants)

    // The Shortcut can fire twice for the same text; ignore exact repeats within 2 minutes.
    const recent = await prisma.inboxMessage.findFirst({
      where: { sender, body, receivedAt: { gte: new Date(Date.now() - 2 * 60 * 1000) } },
    })
    if (recent) return NextResponse.json({ ok: true, duplicate: true })

    const saved = await prisma.inboxMessage.create({
      data: {
        id: newInboxId(),
        sender,
        phone: phone ? `+1${phone}` : null,
        body: body.slice(0, 4000),
        tenantId: tenant?.id ?? null,
        tenantName: tenant?.name ?? null,
        suite: tenant?.suiteNumber ? String(tenant.suiteNumber) : null,
      },
    })
    return NextResponse.json({ ok: true, id: saved.id, matched: tenant?.name ?? null })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'save failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
