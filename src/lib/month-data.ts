// Month-based data management for the rent tracker
// Handles: week generation, smart merge from CSV, localStorage persistence

import { Tenant, TenantWeekEntry, PaymentType } from '@/types'
import { generateWeekEntries } from './tenant-data'
import { getFridaysInMonth } from './utils'
import { CSVMatch } from './csv-parser'

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

  for (const friday of fridays) {
    const [fy, fm, fd] = friday.split('-').map(Number)
    const fridayDate = new Date(fy, fm - 1, fd)
    fridayDate.setHours(0, 0, 0, 0)
    const isPastDue = today > fridayDate

    weeks[friday] = generateWeekEntries(tenants).map(e => ({
      ...e,
      paymentSource: 'none' as PaymentSource,
      // Auto-mark as late if the Friday has already passed
      status: (isPastDue && e.status === 'unpaid' && !e.isVacant) ? 'late' : e.status,
    }))
  }

  return { monthKey, weeks }
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
  for (const friday of fridays) {
    if (!weeks[friday]) {
      weeks[friday] = generateWeekEntries(tenants).map(e => ({
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

      entries[idx] = {
        ...existing,
        amountPaid: match.amount,
        paymentType: match.paymentType,
        status: match.amount >= existing.amountDue ? 'paid' : 'partial',
        confirmation:
          match.paymentType === 'ACH' || match.paymentType === 'Card' ? 'Card Processed' : undefined,
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
