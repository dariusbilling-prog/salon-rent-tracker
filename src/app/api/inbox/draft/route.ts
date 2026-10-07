import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { checkKey, ensureTable, loadTenants, threadKeyOf } from '@/lib/inbox'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// House rules the drafts follow. Edit freely — plain English is fine.
const HOUSE_RULES = `
- You are writing a text message as Darius, the leasing manager of Salon Boutique (salon suites in Rockwall, TX).
- Tone: warm, friendly, short and plain — like a real text from a busy landlord. 1–3 sentences. No emojis unless the tenant used one. No sign-off, no "Best," no name at the end.
- Start with "Hi <first name>," when you know their name.
- Never promise money, refunds, discounts, repairs dates or anything Darius hasn't confirmed. If a decision or a fact is needed (a price, a date, a yes/no Darius hasn't given), write the reply with a clear placeholder in [brackets] for him to fill in, e.g. [time].
- Move-outs: Darius asks for 30 days' notice. Tenants must repaint their suite before moving out; Darius can supply the paint but charges for what they use.
- Payments go by Zelle to Rockwall Salon Boutique LLC (or the usual way the tenant pays). A payment screenshot just needs a quick thank-you.
- Free / vacation weeks: confirm the dates back to the tenant when approving.
- Repairs: thank them, say Darius will get it looked at, and ask for a photo if it would help.
- Leasing inquiries from non-tenants: friendly, invite them to tour, and leave [price] / [availability] placeholders.
`.trim()

/** POST /api/inbox/draft { ids: string[], instructions?: string } -> { draft } */
export async function POST(req: NextRequest) {
  const denied = checkKey(req)
  if (denied) return denied

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not set in Vercel environment variables.' },
      { status: 500 }
    )
  }

  const { ids, instructions } = (await req.json().catch(() => ({}))) as {
    ids?: string[]
    instructions?: string
  }
  if (!ids?.length) return NextResponse.json({ error: 'ids required' }, { status: 400 })

  try {
    await ensureTable()
    const waiting = await prisma.inboxMessage.findMany({
      where: { id: { in: ids } },
      orderBy: { receivedAt: 'asc' },
    })
    if (!waiting.length) return NextResponse.json({ error: 'messages not found' }, { status: 404 })
    const latest = waiting[waiting.length - 1]
    const key = threadKeyOf(latest)

    // A little earlier history from the same person, with the replies Darius sent.
    const earlier = (
      await prisma.inboxMessage.findMany({
        where: { status: 'done', receivedAt: { gte: new Date(Date.now() - 45 * 24 * 3600 * 1000) } },
        orderBy: { receivedAt: 'desc' },
        take: 200,
      })
    )
      .filter((m) => threadKeyOf(m) === key)
      .slice(0, 6)
      .reverse()

    const tenants = await loadTenants()
    const tenant = latest.tenantId ? tenants.find((t) => t.id === latest.tenantId) : undefined

    const who = tenant
      ? [
          `Tenant: ${tenant.name}${tenant.secondName ? ` / ${tenant.secondName}` : ''}`,
          `Suite: ${tenant.suiteNumber}`,
          `Rent: $${tenant.monthlyRent ?? tenant.weeklyRent} ${tenant.monthlyRent ? 'per month' : `per week (${tenant.billingFrequency})`}`,
          tenant.leaseEnd ? `Lease ends: ${tenant.leaseEnd}` : '',
          tenant.notes ? `Darius's notes on this tenant: ${tenant.notes}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : `Sender (not matched to a current tenant): ${latest.sender}`

    const history = earlier
      .map((m) => `THEM: ${m.body}${m.reply ? `\nDARIUS: ${m.reply}` : ''}`)
      .join('\n')
    const now = waiting.map((m) => `THEM (${m.receivedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC): ${m.body}`).join('\n')

    const prompt = [
      who,
      history ? `\nEarlier conversation:\n${history}` : '',
      `\nNew messages waiting for a reply:\n${now}`,
      `\nToday is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' })}.`,
      instructions?.trim() ? `\nDarius's instructions for this reply: ${instructions.trim()}` : '',
      `\nWrite Darius's reply. Output only the text message itself.`,
    ]
      .filter(Boolean)
      .join('\n')

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
        max_tokens: 400,
        system: HOUSE_RULES,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    const data = (await res.json().catch(() => null)) as
      | { content?: { type: string; text?: string }[]; error?: { message?: string } }
      | null
    if (!res.ok) {
      return NextResponse.json({ error: data?.error?.message || `AI request failed (${res.status})` }, { status: 502 })
    }
    const draft = (data?.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim()
      .replace(/^"|"$/g, '')

    await prisma.inboxMessage.update({ where: { id: latest.id }, data: { draft } })
    return NextResponse.json({ draft })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'draft failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
