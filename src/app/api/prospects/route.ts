// GET /api/prospects — return all prospects from the database
// Used by the frontend to merge webhook-created prospects with localStorage

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

const STORAGE_KEY = 'salon-prospects'

export async function GET() {
  try {
    const row = await prisma.appState.findUnique({ where: { key: STORAGE_KEY } })
    const prospects = row?.json ?? []
    return NextResponse.json(prospects)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'read failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
