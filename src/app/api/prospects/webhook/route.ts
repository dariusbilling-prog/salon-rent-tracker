// Webhook endpoint for receiving prospect form submissions from WordPress
// Gravity Forms Webhooks Add-On or any external source.
//
// POST /api/prospects/webhook
//   Body (JSON): Gravity Forms webhook payload or simple JSON
//   Header: x-webhook-secret (must match PROSPECT_WEBHOOK_SECRET env var)

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

interface Prospect {
  id: string
  name: string
  phone: string
  email: string
  suiteInterest: string
  status: 'new' | 'contacted' | 'toured' | 'approved' | 'signed' | 'archived'
  source: 'website' | 'ebi' | 'walk-in' | 'referral' | 'other'
  notes: string
  createdAt: string
  updatedAt: string
}

const STORAGE_KEY = 'salon-prospects'

function newProspectId(): string {
  return `prospect-${Date.now()}-${Math.floor(Math.random() * 1000)}`
}

// ─── Gravity Forms field mapping ────────────────────────────────
// Form ID 1 on salonboutique.com:
//   input_1.3 (field 1, sub .3)  → First Name
//   input_3                       → Phone
//   input_4                       → Email
//   input_6                       → Location (dropdown)
//   input_7                       → Message

function parseGravityFormsPayload(body: Record<string, unknown>): Omit<Prospect, 'id' | 'createdAt' | 'updatedAt'> | null {
  // Gravity Forms webhooks send field values keyed by field ID
  // Try both "1.3" and "1" for the name field
  const name = String(body['1.3'] || body['1'] || body['name'] || '').trim()
  const phone = String(body['3'] || body['phone'] || '').trim()
  const email = String(body['4'] || body['email'] || '').trim()
  const location = String(body['6'] || body['location'] || '').trim()
  const message = String(body['7'] || body['message'] || '').trim()

  // Need at least a name to create a prospect
  if (!name) return null

  // Build notes from location + message
  const notes = [
    location ? `Location interest: ${location}` : '',
    message ? message : '',
  ].filter(Boolean).join('\n')

  return {
    name,
    phone,
    email,
    suiteInterest: location || 'any',
    status: 'new',
    source: 'website',
    notes,
  }
}

// Also accept a simple JSON format for flexibility
function parseSimplePayload(body: Record<string, unknown>): Omit<Prospect, 'id' | 'createdAt' | 'updatedAt'> | null {
  const name = String(body.name || '').trim()
  if (!name) return null

  return {
    name,
    phone: String(body.phone || '').trim(),
    email: String(body.email || '').trim(),
    suiteInterest: String(body.suiteInterest || body.suite_interest || body.location || 'any').trim(),
    status: 'new',
    source: (body.source as Prospect['source']) || 'website',
    notes: String(body.notes || body.message || '').trim(),
  }
}

export async function POST(req: NextRequest) {
  // ── Auth check ──────────────────────────────────────────────
  const secret = process.env.PROSPECT_WEBHOOK_SECRET
  if (secret) {
    const provided = req.headers.get('x-webhook-secret') || req.nextUrl.searchParams.get('secret')
    if (provided !== secret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  try {
    const body = (await req.json()) as Record<string, unknown>

    // Try Gravity Forms format first, fall back to simple JSON
    const prospectData = parseGravityFormsPayload(body) || parseSimplePayload(body)

    if (!prospectData) {
      return NextResponse.json({ error: 'Missing required field: name' }, { status: 400 })
    }

    const now = new Date().toISOString()
    const newProspect: Prospect = {
      ...prospectData,
      id: newProspectId(),
      createdAt: now,
      updatedAt: now,
    }

    // Load existing prospects from the database
    let existing: Prospect[] = []
    try {
      const row = await prisma.appState.findUnique({ where: { key: STORAGE_KEY } })
      if (row?.json) {
        existing = (Array.isArray(row.json) ? row.json : []) as Prospect[]
      }
    } catch {
      // If key doesn't exist yet, start fresh
    }

    // Check for duplicate (same name + email within last 24 hours)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const isDuplicate = existing.some(
      p =>
        p.name.toLowerCase() === newProspect.name.toLowerCase() &&
        p.email.toLowerCase() === newProspect.email.toLowerCase() &&
        p.createdAt > oneDayAgo
    )

    if (isDuplicate) {
      return NextResponse.json({ ok: true, duplicate: true, message: 'Duplicate submission ignored' })
    }

    // Append and save
    const updated = [...existing, newProspect]
    await prisma.appState.upsert({
      where: { key: STORAGE_KEY },
      create: { key: STORAGE_KEY, json: updated as any },
      update: { json: updated as any },
    })

    return NextResponse.json({
      ok: true,
      prospect: { id: newProspect.id, name: newProspect.name },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'webhook processing failed'
    console.error('Prospect webhook error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// Allow GET for health check / testing
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: '/api/prospects/webhook',
    method: 'POST',
    fields: {
      gravityForms: '1.3=name, 3=phone, 4=email, 6=location, 7=message',
      simple: 'name, phone, email, suiteInterest, notes, source',
    },
  })
}
