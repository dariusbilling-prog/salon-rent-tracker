// Payment allocation across weeks — and across month boundaries.
//
// WHY THIS EXISTS
// Rent is due every Friday, but tenants routinely pay a week or two behind and
// deposits get made mid-week. A deposit taken on Wednesday 8/5 is usually paying
// for the Friday 7/31 week — which lives in the *previous* month's data file. The
// original apply logic could only see the month currently on screen, so those
// payments silently landed on the wrong week, or on a week that was already paid
// and overwrote it.
//
// Everything here is pure: it takes a "book" of months, returns a new book. The
// caller decides what to persist.

import { Tenant, PaymentType, WeekStatus } from '@/types'
import { MonthData, MonthTenantEntry, createEmptyMonth, loadMonthData } from './month-data'
import { isNearSuite } from './utils'

export interface WeekRef {
  monthKey: string
  friday: string
}

/** A set of months keyed by "YYYY-MM", the working set for one allocation. */
export type MonthBook = Record<string, MonthData>

/** Statuses that mean "no money is expected this week" — never auto-target these. */
const NON_BILLABLE: WeekStatus[] = ['free_week', 'comped_week', 'biweekly_off']

/** "2026-07-31" -> "2026-07" */
export function monthKeyOf(friday: string): string {
  return friday.slice(0, 7)
}

/** Shift a "YYYY-MM" key by N months. */
export function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * The months a deposit could plausibly touch: a couple back (tenants run behind)
 * and one forward (some pay ahead, and overflow rolls into next month).
 */
export function allocationMonthKeys(monthKey: string, back = 2, forward = 1): string[] {
  const keys: string[] = []
  for (let i = -back; i <= forward; i++) keys.push(shiftMonthKey(monthKey, i))
  return keys
}

/**
 * Assemble the working set. `current` is passed in explicitly because it lives in
 * React state and may hold edits that have not been written to storage yet —
 * reading it back from localStorage would lose them.
 */
export function loadBook(monthKeys: string[], tenants: Tenant[], current: MonthData): MonthBook {
  const book: MonthBook = {}
  for (const key of monthKeys) {
    if (key === current.monthKey) {
      book[key] = current
      continue
    }
    book[key] = loadMonthData(key) || createEmptyMonth(key, tenants)
  }
  return book
}

/** What is still owed on one week. Never negative. */
export function owedOn(entry: MonthTenantEntry): number {
  if (entry.isVacant) return 0
  if (NON_BILLABLE.includes(entry.status)) return 0
  return Math.max(0, round2(entry.amountDue - entry.amountPaid))
}

/**
 * Every week in the book that still owes money for this tenant, oldest first.
 * This ordering is the whole point: money always fills the oldest debt before
 * touching a week further forward.
 */
export function openWeeksFor(book: MonthBook, tenantId: string): WeekRef[] {
  const refs: WeekRef[] = []
  for (const monthKey of Object.keys(book).sort()) {
    const weeks = book[monthKey].weeks
    for (const friday of Object.keys(weeks).sort()) {
      const entry = weeks[friday].find(e => e.tenant.id === tenantId)
      if (entry && owedOn(entry) > 0) refs.push({ monthKey, friday })
    }
  }
  return refs
}

/** Every week in the book for this tenant, oldest first — open or not. */
export function allWeeksFor(book: MonthBook, tenantId: string): WeekRef[] {
  const refs: WeekRef[] = []
  for (const monthKey of Object.keys(book).sort()) {
    const weeks = book[monthKey].weeks
    for (const friday of Object.keys(weeks).sort()) {
      if (weeks[friday].some(e => e.tenant.id === tenantId)) refs.push({ monthKey, friday })
    }
  }
  return refs
}

export interface AllocationPlan {
  /** Weeks the money reaches, oldest first. */
  weeks: WeekRef[]
  /** How much lands on each week, index-aligned with `weeks`. */
  amounts: number[]
  /** Money with nowhere to go — becomes tenant credit. */
  leftover: number
  /** True when the last week only gets a part of what it owes. */
  endsPartial: boolean
}

/**
 * Work out where an amount should go WITHOUT changing anything.
 *
 * Walks the tenant's open weeks oldest-first, filling each one only up to what it
 * still owes. This is what lets a single $520 check cover two $260 weeks exactly,
 * and a $650 check cover one $350 week with $300 left over — no "weeks = amount /
 * weeklyRent" guesswork, which breaks the moment a week is partly paid or a
 * monthly tenant has uneven weekly shares.
 */
export function planAllocation(
  book: MonthBook,
  tenantId: string,
  amount: number,
  restrictTo?: WeekRef[]
): AllocationPlan {
  const open = restrictTo ?? openWeeksFor(book, tenantId)
  const weeks: WeekRef[] = []
  const amounts: number[] = []
  let remaining = round2(amount)
  let endsPartial = false

  for (const ref of open) {
    if (remaining <= 0.005) break
    const entry = entryAt(book, ref, tenantId)
    if (!entry) continue
    const owed = owedOn(entry)
    if (owed <= 0) continue

    const applied = Math.min(remaining, owed)
    weeks.push(ref)
    amounts.push(round2(applied))
    remaining = round2(remaining - applied)
    endsPartial = applied < owed - 0.005
  }

  return { weeks, amounts, leftover: Math.max(0, remaining), endsPartial }
}

export interface PaymentMeta {
  paymentType: PaymentType
  checkNumber?: string
  confirmation?: string
  notes?: string
  paymentDate?: string
}

export interface AllocationResult {
  book: MonthBook
  /** Months whose contents actually changed — only these need saving. */
  touched: string[]
  applied: number
  leftover: number
  lines: Array<WeekRef & { applied: number }>
}

/**
 * Apply an amount to a chosen list of weeks and return a new book.
 *
 * Two rules that the previous implementation got wrong:
 *  1. Money is ADDED to whatever the week already holds, never assigned over it.
 *     Two checks from the same tenant landing on the same week must sum.
 *  2. A week never takes more than it still owes; the surplus flows to the next
 *     selected week, and anything past the last one comes back as `leftover` for
 *     the caller to store as credit.
 */
export function applyPaymentAcross(
  book: MonthBook,
  targets: WeekRef[],
  tenantId: string,
  amount: number,
  meta: PaymentMeta,
  options?: { evenSplit?: boolean }
): AllocationResult {
  const next: MonthBook = { ...book }
  const touched = new Set<string>()
  const lines: Array<WeekRef & { applied: number }> = []
  let remaining = round2(amount)

  // For monthly tenants: divide payment evenly across selected weeks
  const perWeekShare = options?.evenSplit && targets.length > 0
    ? round2(amount / targets.length)
    : 0

  for (const ref of targets) {
    if (remaining <= 0.005) break
    const month = next[ref.monthKey]
    if (!month || !month.weeks[ref.friday]) continue

    const entries = [...month.weeks[ref.friday]]
    const idx = entries.findIndex(e => e.tenant.id === tenantId)
    if (idx === -1) continue

    const existing = entries[idx]
    const owed = owedOn(existing)
    // A week the user explicitly picked still accepts money even if it reads as
    // settled — but it will only take what it is short, so it can never be wiped.
    if (owed <= 0) continue

    const applied = options?.evenSplit
      ? round2(Math.min(remaining, perWeekShare))
      : round2(Math.min(remaining, owed))
    if (applied <= 0) continue
    remaining = round2(remaining - applied)

    const amountPaid = round2(existing.amountPaid + applied)
    // Monthly even-split: the flat payment covers the obligation even when
    // the per-week share is less than the listed weekly amountDue.
    const fullyPaid = options?.evenSplit
      ? true
      : amountPaid >= existing.amountDue - 0.005
    entries[idx] = {
      ...existing,
      amountPaid,
      status: fullyPaid ? 'paid' : 'partial',
      paymentType: meta.paymentType,
      confirmation: meta.confirmation ?? existing.confirmation,
      // Keep every check number that funded this week, so two checks on one week
      // remain traceable instead of the second erasing the first.
      checkNumber: joinCheckNumbers(existing.checkNumber, meta.checkNumber),
      notes: meta.notes ? mergeNotes(existing.notes, meta.notes) : existing.notes,
      payments: [
        ...(existing.payments || []),
        {
          id: `${ref.friday}-${tenantId}-${(existing.payments || []).length + 1}`,
          tenantId,
          rentWeekId: ref.friday,
          amount: applied,
          paymentDate: meta.paymentDate || ref.friday,
          source: 'manual',
          paymentType: meta.paymentType,
          checkNumber: meta.checkNumber,
          confirmation: meta.confirmation,
        },
      ],
      paymentSource: 'manual',
    }

    next[ref.monthKey] = { ...month, weeks: { ...month.weeks, [ref.friday]: entries } }
    touched.add(ref.monthKey)
    lines.push({ ...ref, applied })
  }

  return {
    book: next,
    touched: Array.from(touched),
    applied: round2(amount - remaining),
    leftover: Math.max(0, remaining),
    lines,
  }
}

function entryAt(book: MonthBook, ref: WeekRef, tenantId: string): MonthTenantEntry | undefined {
  return book[ref.monthKey]?.weeks[ref.friday]?.find(e => e.tenant.id === tenantId)
}

function joinCheckNumbers(existing: string | undefined, incoming: string | undefined): string | undefined {
  if (!incoming) return existing
  if (!existing) return incoming
  const parts = existing.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.includes(incoming.trim())) return existing
  return [...parts, incoming.trim()].join(', ')
}

function mergeNotes(existing: string | undefined, incoming: string): string {
  if (!existing) return incoming
  if (existing.includes(incoming)) return existing
  return `${existing} · ${incoming}`
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------------
// Suite matching
// ---------------------------------------------------------------------------

/**
 * Find the tenant a scanned suite number refers to.
 *
 * Exact match wins. Only then do we fall back to the shared-suite forms like
 * "106/108", and only as whole segments — the old code used bare `includes()`,
 * so a stray "1" could match "101/102" and post a payment to the wrong person.
 */
export function matchTenantBySuite(tenants: Tenant[], suite: string): Tenant | undefined {
  const q = (suite || '').trim()
  if (!q) return undefined

  const exact = tenants.find(t => t.suiteNumber.trim() === q)
  if (exact) return exact

  const segMatch = tenants.find(t =>
    t.suiteNumber.split('/').map(x => x.trim()).includes(q)
  )
  if (segMatch) return segMatch

  return tenants.find(t => q.split('/').map(x => x.trim()).includes(t.suiteNumber.trim()))
}

/**
 * Suites the OCR may have misread, ranked by whether the money makes sense.
 *
 * Handwritten 6 and 8 (and 1/7, 3/5, 0/6) are routinely confused, and the vision
 * API reports those misreads as "high" confidence — it is confident about the
 * shape it saw, not about which suite you meant. The amount is the independent
 * check: a $520 cheque divides exactly into suite 126's $260/wk and into nothing
 * sensible for 128's $350/wk. Any near-miss suite that divides cleanly when the
 * scanned one does not is worth putting in front of the user.
 */
export function suiteAlternatives(
  tenants: Tenant[],
  suite: string,
  amount: number,
  matched?: Tenant
): Tenant[] {
  const q = (suite || '').trim()
  if (!q || amount <= 0) return []
  if (matched && dividesEvenly(amount, matched.weeklyRent)) return []

  return tenants
    .filter(t => t.id !== matched?.id)
    .filter(t => t.suiteNumber.split('/').some(seg => isNearSuite(seg.trim(), q)))
    .filter(t => dividesEvenly(amount, t.weeklyRent))
}

function dividesEvenly(amount: number, rate: number): boolean {
  if (rate <= 0) return false
  const weeks = amount / rate
  return Math.abs(weeks - Math.round(weeks)) < 0.005 && Math.round(weeks) >= 1
}
