// Month-based data management for the rent tracker
// Handles: week generation, smart merge from CSV, localStorage persistence

import { Tenant, TenantWeekEntry, PaymentType } from '@/types'
import { generateWeekEntries, weekDueForTenant } from './tenant-data'
import { getFridaysInMonth } from './utils'
import { CSVMatch } from './csv-parser'
import { pushKey } from './cloud-sync'

// Tracks the origin of a payment so we know whether to preserve it on re-upload
export type PaymentSource = 'csv' | 'manual' | 'zelle-gmail' | 'none'

// Extended entry with source tracking for smart merge
export interface MonthTenantEntry extends TenantWeekEntry {
  paymentSource?: PaymentSource
}

// Data for a full month: Fridays -> entries per tenant per week
export interface MonthData {
  monthKey: string // YYYY-MM
  weeks: Record<string, MonthTenantEntry[]> // keyed by Friday ISO date
  lastCSVUpload?: string // ISO timestamp
  lastGmailScan?: string
}

// Create a fresh month data structure with empty weeks
export function createEmptyMonth(monthKey: string, tenants: Tenant[]): MonthData {
  const fridays = getFridaysInMonth(monthKey)
  const weeks: Record<string, MonthTenantEntry[]> = {}
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  for (let wi = 0; wi < fridays.length; wi++) {
    const friday = fridays[wi]
    const [fy, fm, fd] = friday.split('-').map(Number)
    const fridayDate = new Date(fy, fm - 1, fd)
    fridayDate.setHours(0, 0, 0, 0)
    const isPastDue = today > fridayDate

    weeks[friday] = generateWeekEntries(tenants, wi, fridays.length).map(e => ({
      ...e,
      paymentSource: 'none' as PaymentSource,
      // Auto-mark as late if the Friday has already passed
      status: (isPastDue && e.status === 'unpaid' && !e.isVacant) ? 'late' : e.status,
    }))
  }

  return { monthKey, weeks }
}

/**
 * Recompute `amountDue` for every entry from the current tenant records, without
 * touching anything that was actually paid.
 *
 * Needed because `amountDue` is frozen into each week when the month is first
 * created. If a tenant's rent changes — most importantly when a monthly tenant
 * gets a real `monthlyRent` instead of an inferred weekly figure — already-built
 * months keep billing the old number forever. Statuses are re-derived so a week
 * that is now fully covered stops showing as partial (and vice versa).
 */
export function recalcMonthDues(data: MonthData, tenants: Tenant[]): MonthData {
  const fridays = Object.keys(data.weeks).sort()
  const weeks: Record<string, MonthTenantEntry[]> = {}

  for (let wi = 0; wi < fridays.length; wi++) {
    const friday = fridays[wi]
    weeks[friday] = data.weeks[friday].map(entry => {
      const tenant = tenants.find(t => t.id === entry.tenant.id) || entry.tenant
      if (entry.isVacant) return { ...entry, tenant }

      const amountDue = weekDueForTenant(tenant, wi, fridays.length)
      if (amountDue === entry.amountDue && tenant === entry.tenant) return entry

      // Only re-derive the statuses that are purely a function of money.
      // Manual states (free_week, comped_week, biweekly_off, monthly_pending)
      // are deliberate choices and must survive a rent change.
      let status = entry.status
      if (status === 'paid' || status === 'partial') {
        status = entry.amountPaid >= amountDue ? 'paid' : 'partial'
      }

      return { ...entry, tenant, amountDue, status }
    })
  }

  return { ...data, weeks }
}

// Smart merge: update ACH/Card (csv-sourced) entries from new CSV,
// but preserve anything entered manually (Zelle/Check/Cash/Notes)
export function mergeCSVIntoMonth(
  monthData: MonthData,
  matches: CSVMatch[],
  tenants: Tenant[]
): MonthData {
  const fridays = getFridaysInMonth(monthData.monthKey)
  const weeks = { ...monthData.weeks }

  // Ensure every Friday in month has an entry list
  for (let wi = 0; wi < fridays.length; wi++) {
    const friday = fridays[wi]
    if (!weeks[friday]) {
      weeks[friday] = generateWeekEntries(tenants, wi, fridays.length).map(e => ({
        ...e,
        paymentSource: 'none',
      }))
    }
  }

  // Group matches by the Friday week they belong to
  // Monthly payments apply to ALL weeks in that month
  const matchesByFriday: Record<string, CSVMatch[]> = {}
  for (const friday of fridays) {
    matchesByFriday[friday] = []
  }

  for (const match of matches) {
    if (match.isMonthlyPayment) {
      // Apply monthly payment to every Friday in the month
      for (const friday of fridays) {
        matchesByFriday[friday].push(match)
      }
    } else {
      // Weekly payment goes to its specific Friday
      if (matchesByFriday[match.dueDate]) {
        matchesByFriday[match.dueDate].push(match)
      }
    }
  }

  // Apply matches to each Friday's entries (smart merge)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  for (const friday of fridays) {
    const entries = weeks[friday]
    const weekMatches = matchesByFriday[friday]

    // Check if this Friday has already passed
    const [fy, fm, fd] = friday.split('-').map(Number)
    const fridayDate = new Date(fy, fm - 1, fd)
    fridayDate.setHours(0, 0, 0, 0)
    const isPastDue = today > fridayDate

    for (const match of weekMatches) {
      const idx = entries.findIndex(e => e.tenant.id === match.tenant.id)
      if (idx === -1) continue

      const existing = entries[idx]
      const prevSource = existing.paymentSource || 'none'

      // Smart merge rule:
      // - If prior source was 'manual' (Zelle/Check/Cash entered by hand), SKIP and preserve
      // - Otherwise (none or csv), apply the CSV update
      if (prevSource === 'manual' && existing.amountPaid > 0) {
        continue
      }

      const isPending = match.pendingAmount > 0
      entries[idx] = {
        ...existing,
        amountPaid: match.amount,
        paymentType: match.paymentType,
        status: match.amount >= existing.amountDue ? 'paid' : 'partial',
        // A pending ACH is money in flight, not money in the bank. Saying
        // "Card Processed" here would tell the accountant it cleared.
        confirmation: isPending
          ? 'ACH Pending'
          : match.paymentType === 'ACH' || match.paymentType === 'Card'
            ? 'Card Processed'
            : undefined,
        pendingAmount: isPending ? match.pendingAmount : undefined,
        paidDate: match.paidDate,
        paymentSource: 'csv',
      }
    }

    // After applying CSV matches, mark remaining unpaid entries as 'late' if past due
    if (isPastDue) {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].status === 'unpaid' && !entries[i].isVacant) {
          entries[i] = { ...entries[i], status: 'late' }
        }
      }
    }
  }

  return {
    ...monthData,
    weeks,
    lastCSVUpload: new Date().toISOString(),
  }
}

// Persist month data to localStorage
const STORAGE_PREFIX = 'salon-rent:'

export function saveMonthData(data: MonthData) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_PREFIX + data.monthKey, JSON.stringify(data))
  } catch (err) {
    console.error('Failed to save month data:', err)
  }
  pushKey(STORAGE_PREFIX + data.monthKey, data) // best-effort cloud mirror
}

export function loadMonthData(monthKey: string): MonthData | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + monthKey)
    if (!raw) return null
    return JSON.parse(raw) as MonthData
  } catch (err) {
    console.error('Failed to load month data:', err)
    return null
  }
}

export function listSavedMonths(): string[] {
  if (typeof window === 'undefined') return []
  const months: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith(STORAGE_PREFIX)) {
      months.push(key.slice(STORAGE_PREFIX.length))
    }
  }
  return months.sort()
}

// ---- Zelle (Gmail) integration ----

export interface ZelleMatch {
  payment: {
    senderName: string
    amount: number
    dateReceived: string
    assignedFriday: string
    memo?: string
    messageId: string
  }
  tenant: Tenant | null
  matchMethod: 'exact' | 'fuzzy' | 'none'
  confidence: number
}

// Match a Zelle sender name to a tenant using name similarity
// (Zelle names might differ slightly from tenant names)
function matchZelleSenderToTenant(
  senderName: string,
  tenants: Tenant[]
): { tenant: Tenant | null; method: 'exact' | 'fuzzy' | 'none'; confidence: number } {
  const activeTenants = tenants.filter(t => t.isActive)
  const normalized = senderName.toLowerCase().trim()

  // Exact match
  for (const tenant of activeTenants) {
    const tenantLower = tenant.name.toLowerCase()
    if (tenantLower === normalized || normalized.includes(tenantLower) || tenantLower.includes(normalized)) {
      return { tenant, method: 'exact', confidence: 1.0 }
    }
  }

  // First-name / last-name partial match
  const senderParts = normalized.split(/\s+/)
  const senderFirst = senderParts[0]
  const senderLast = senderParts[senderParts.length - 1]

  let best: { tenant: Tenant; score: number } | null = null

  for (const tenant of activeTenants) {
    const tenantParts = tenant.name.toLowerCase().split(/[\s,/&]+/)
    let score = 0
    for (const senderPart of [senderFirst, senderLast]) {
      if (!senderPart || senderPart.length < 3) continue
      for (const tenantPart of tenantParts) {
        if (tenantPart.length < 3) continue
        if (tenantPart === senderPart) {
          score += 0.5
        } else if (tenantPart.startsWith(senderPart) || senderPart.startsWith(tenantPart)) {
          score += 0.3
        }
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { tenant, score }
    }
  }

  if (best && best.score >= 0.5) {
    return { tenant: best.tenant, method: 'fuzzy', confidence: Math.min(best.score, 0.95) }
  }

  return { tenant: null, method: 'none', confidence: 0 }
}

export function matchZellePayments(
  payments: Array<{
    senderName: string
    amount: number
    dateReceived: string
    assignedFriday: string
    memo?: string
    messageId: string
  }>,
  tenants: Tenant[]
): ZelleMatch[] {
  return payments.map(payment => {
    const { tenant, method, confidence } = matchZelleSenderToTenant(payment.senderName, tenants)
    return { payment, tenant, matchMethod: method, confidence }
  })
}

// Apply approved Zelle matches to a month's data
export function applyZelleMatchesToMonth(
  monthData: MonthData,
  matches: ZelleMatch[]
): MonthData {
  const fridays = getFridaysInMonth(monthData.monthKey)
  const weeks = { ...monthData.weeks }

  for (const match of matches) {
    if (!match.tenant) continue
    const friday = match.payment.assignedFriday

    // Only apply if the Friday belongs to this month
    if (!fridays.includes(friday)) continue
    if (!weeks[friday]) continue

    const entries = [...weeks[friday]]
    const idx = entries.findIndex(e => e.tenant.id === match.tenant!.id)
    if (idx === -1) continue

    const existing = entries[idx]

    // If there's already a manual or CSV entry with a higher-or-equal amount, skip
    // Otherwise update. Zelle takes precedence over unpaid/empty.
    if (existing.amountPaid > 0 && existing.paymentSource !== 'zelle-gmail' && existing.paymentSource !== 'none') {
      // Already has a different source payment — skip to avoid overwriting
      continue
    }

    entries[idx] = {
      ...existing,
      amountPaid: match.payment.amount,
      paymentType: 'Zelle',
      status: match.payment.amount >= existing.amountDue ? 'paid' : 'partial',
      confirmation: 'Cash',
      paymentSource: 'zelle-gmail',
      notes: existing.notes || (match.payment.memo ? `Zelle memo: ${match.payment.memo}` : existing.notes),
    }

    weeks[friday] = entries
  }

  return {
    ...monthData,
    weeks,
    lastGmailScan: new Date().toISOString(),
  }
}

// Monthly summary stats
export interface MonthlySummary {
  totalExpected: number
  totalCollected: number
  outstanding: number
  collectionRate: number
  weekCount: number
  paymentMethodBreakdown: Record<PaymentType, { count: number; total: number }>
  chronicLate: Array<{ tenant: Tenant; weeksLate: number }>
  repeatUnpaid: Array<{ tenant: Tenant; weeksUnpaid: number }>
  freeWeeksUsed: number
  compedWeeksGiven: number
  weekBreakdown: Array<{
    friday: string
    expected: number
    collected: number
    rate: number
  }>
}

export function calculateMonthlySummary(data: MonthData): MonthlySummary {
  const fridays = Object.keys(data.weeks).sort()
  const paymentMethodBreakdown: Record<string, { count: number; total: number }> = {}
  const lateCountByTenant = new Map<string, { tenant: Tenant; weeks: number }>()
  const unpaidCountByTenant = new Map<string, { tenant: Tenant; weeks: number }>()
  let freeWeeksUsed = 0
  let compedWeeksGiven = 0
  let totalExpected = 0
  let totalCollected = 0

  const weekBreakdown = fridays.map(friday => {
    const entries = data.weeks[friday]
    let weekExpected = 0
    let weekCollected = 0

    for (const entry of entries) {
      if (entry.isVacant) continue

      // Expected excludes free_week, comped_week, biweekly_off, monthly_pending (already counted if paid)
      if (!['free_week', 'comped_week', 'biweekly_off'].includes(entry.status)) {
        weekExpected += entry.amountDue
      }

      weekCollected += entry.amountPaid

      // Count late/unpaid
      if (entry.status === 'late') {
        const prev = lateCountByTenant.get(entry.tenant.id)
        lateCountByTenant.set(entry.tenant.id, { tenant: entry.tenant, weeks: (prev?.weeks || 0) + 1 })
      }
      if (entry.status === 'unpaid') {
        const prev = unpaidCountByTenant.get(entry.tenant.id)
        unpaidCountByTenant.set(entry.tenant.id, { tenant: entry.tenant, weeks: (prev?.weeks || 0) + 1 })
      }

      // Free/comped counts
      if (entry.status === 'free_week') freeWeeksUsed += 1
      if (entry.status === 'comped_week') compedWeeksGiven += 1

      // Payment method breakdown
      if (entry.amountPaid > 0 && entry.paymentType) {
        const key = entry.paymentType
        if (!paymentMethodBreakdown[key]) {
          paymentMethodBreakdown[key] = { count: 0, total: 0 }
        }
        paymentMethodBreakdown[key].count += 1
        paymentMethodBreakdown[key].total += entry.amountPaid
      }
    }

    totalExpected += weekExpected
    totalCollected += weekCollected

    return {
      friday,
      expected: weekExpected,
      collected: weekCollected,
      rate: weekExpected > 0 ? (weekCollected / weekExpected) * 100 : 0,
    }
  })

  const chronicLate = Array.from(lateCountByTenant.values())
    .filter(x => x.weeks >= 1)
    .sort((a, b) => b.weeks - a.weeks)
    .map(x => ({ tenant: x.tenant, weeksLate: x.weeks }))

  const repeatUnpaid = Array.from(unpaidCountByTenant.values())
    .filter(x => x.weeks >= 1)
    .sort((a, b) => b.weeks - a.weeks)
    .map(x => ({ tenant: x.tenant, weeksUnpaid: x.weeks }))

  return {
    totalExpected,
    totalCollected,
    outstanding: totalExpected - totalCollected,
    collectionRate: totalExpected > 0 ? (totalCollected / totalExpected) * 100 : 0,
    weekCount: fridays.length,
    paymentMethodBreakdown: paymentMethodBreakdown as Record<PaymentType, { count: number; total: number }>,
    chronicLate,
    repeatUnpaid,
    freeWeeksUsed,
    compedWeeksGiven,
    weekBreakdown,
  }
}

// ---------------------------------------------------------------------------
// Roster reconciliation
// ---------------------------------------------------------------------------

/** Sort suites the way the table reads them: 101/102, 103, 104 ... 128/129, 130. */
function bySuite(a: MonthTenantEntry, b: MonthTenantEntry): number {
  const num = (s: string) => parseInt(s.replace(/[^0-9]/g, '').slice(0, 3), 10) || 0
  const d = num(a.tenant.suiteNumber) - num(b.tenant.suiteNumber)
  return d !== 0 ? d : a.tenant.suiteNumber.localeCompare(b.tenant.suiteNumber)
}

/**
 * Make one month's rows match the current tenant roster.
 *
 * Months freeze their roster at the moment they are created, so moving a tenant
 * into a suite only ever affected the month you happened to be looking at. A
 * tenant who moved into a vacant suite in June still showed as "Vacant" in every
 * month already on disk, which left their earlier payments with nowhere to land.
 *
 * Rules, in order of precedence:
 *  1. **Money is never destroyed.** An entry carrying a payment is preserved even
 *     if that tenant has since left the roster — that is real history.
 *  2. A roster tenant missing from a week gets added, *unless* another entry for
 *     the same suite already holds a payment for that week. That stops a fresh
 *     "Vacant" placeholder appearing next to the moved-out tenant who actually
 *     paid, which would read as the suite being double-counted.
 *  3. Existing rows keep their payments and adopt the current tenant record, so a
 *     rename or rent change flows through without touching amounts.
 */
export function reconcileMonthRoster(data: MonthData, roster: Tenant[]): MonthData {
  const fridays = Object.keys(data.weeks).sort()
  const weeks: Record<string, MonthTenantEntry[]> = {}

  for (let wi = 0; wi < fridays.length; wi++) {
    const friday = fridays[wi]
    const existing = data.weeks[friday] || []
    const byId = new Map(existing.map(e => [e.tenant.id, e]))
    const out: MonthTenantEntry[] = []

    for (const tenant of roster) {
      const prior = byId.get(tenant.id)
      if (prior) {
        out.push({
          ...prior,
          tenant,
          isVacant: !tenant.isActive,
          amountDue: tenant.isActive ? weekDueForTenant(tenant, wi, fridays.length) : 0,
        })
        continue
      }

      // Rule 2 — don't shoulder in beside a paid row for the same suite.
      const suiteAlreadyPaid = existing.some(
        e => e.tenant.suiteNumber === tenant.suiteNumber && e.amountPaid > 0
      )
      if (suiteAlreadyPaid) continue

      const [fresh] = generateWeekEntries([tenant], wi, fridays.length)
      out.push({ ...fresh, paymentSource: 'none' as PaymentSource })
    }

    // Rule 1 — carry forward anyone off-roster who still holds money.
    const rosterIds = new Set(roster.map(t => t.id))
    for (const e of existing) {
      if (!rosterIds.has(e.tenant.id) && e.amountPaid > 0) out.push(e)
    }

    weeks[friday] = out.sort(bySuite)
  }

  return { ...data, weeks }
}

/**
 * Push a roster change through every month already in storage.
 *
 * `skipMonthKey` is for the month held in React state — the caller updates that
 * one itself, and writing it here as well would race the component's own save.
 * Returns the months that actually changed, so the caller can report honestly.
 */
export function reconcileSavedMonths(roster: Tenant[], skipMonthKey?: string): string[] {
  const touched: string[] = []
  for (const key of listSavedMonths()) {
    if (key === skipMonthKey) continue
    const data = loadMonthData(key)
    if (!data) continue

    const next = reconcileMonthRoster(data, roster)
    const before = JSON.stringify(data.weeks)
    const after = JSON.stringify(next.weeks)
    if (before === after) continue

    saveMonthData(next)
    touched.push(key)
  }
  return touched
}

/**
 * Has this tenant any money recorded against them, in any stored month?
 *
 * The gate on deleting a tenant. Archiving is for people who really lived here;
 * deleting is only ever for a record created by mistake, and a record with
 * payments attached is by definition not a mistake.
 */
export function tenantHasPayments(tenantId: string, alsoCheck?: MonthData): boolean {
  const scan = (data: MonthData) =>
    Object.values(data.weeks).some(entries =>
      entries.some(e => e.tenant.id === tenantId && e.amountPaid > 0)
    )

  if (alsoCheck && scan(alsoCheck)) return true
  for (const key of listSavedMonths()) {
    const data = loadMonthData(key)
    if (data && scan(data)) return true
  }
  return false
}

/**
 * Strip a tenant's (payment-free) rows out of every stored month.
 * Refuses outright if any row holds money — belt and braces alongside
 * `tenantHasPayments`, because losing a payment to a roster tidy-up would be
 * far worse than leaving a stray row behind.
 */
export function purgeTenantFromSavedMonths(tenantId: string, skipMonthKey?: string): string[] {
  const touched: string[] = []
  for (const key of listSavedMonths()) {
    if (key === skipMonthKey) continue
    const data = loadMonthData(key)
    if (!data) continue

    let changed = false
    const weeks: Record<string, MonthTenantEntry[]> = {}
    for (const [friday, entries] of Object.entries(data.weeks)) {
      const kept = entries.filter(e => {
        if (e.tenant.id !== tenantId) return true
        if (e.amountPaid > 0) return true // never drop money
        changed = true
        return false
      })
      weeks[friday] = kept
    }

    if (!changed) continue
    saveMonthData({ ...data, weeks })
    touched.push(key)
  }
  return touched
}
