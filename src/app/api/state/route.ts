import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/state  -> { [key]: value } for every stored blob
export async function GET() {
  try {
    const rows = await prisma.appState.findMany()
    const out: Record<string, unknown> = {}
    for (const r of rows) out[r.key] = r.json
    return NextResponse.json(out)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'read failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST /api/state  { key, value }  -> upsert one blob
export async function POST(req: NextRequest) {
  try {
    const { key, value } = (await req.json()) as { key?: string; value?: unknown }
    if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
    await prisma.appState.upsert({
      where: { key },
      create: { key, json: value as any },
      update: { json: value as any },
    })
    return NextResponse.json({ ok: true, key })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'write failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
