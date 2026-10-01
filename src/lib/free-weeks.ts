// Free Week Tracking for the Salon Rent Tracker
// Each tenant gets 1 free week per 52-week lease period.
// Darius can manually set each tenant's balance.
// The system also scans historical month data for free_week statuses.

import { pushKey } from './cloud-sync'

const STORAGE_KEY = 'salon-free-weeks'

/** One record per tenant tracking their free week entitlement */
export interface FreeWeekRecord {
  tenantId: string
  /** How many total free weeks this tenant is entitled to (cumulative across leases) */
  totalEntitled: number
  /** Free weeks used — each entry is { monthKey, friday } */
  used: FreeWeekUsage[]
  /** Optional notes, e.g. "renewed lease Oct 2025" */
  notes?: string
  /** When the record was last updated */
  updatedAt: string
}

export interface FreeWeekUsage {
  monthKey: string  // e.g. "2026-09"
  friday: string    // e.g. "2026-09-25"
  /** When this usage was recorded */
  recordedAt: string
}

export type FreeWeekLedger = Record<string, FreeWeekRecord> // keyed by tenantId

// ─── Persistence ─────────────────────────────────────────────────

export function loadFreeWeekLedger(): FreeWeekLedger {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveFreeWeekLedger(ledger: FreeWeekLedger): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ledger))
    pushKey(STORAGE_KEY, ledger)
  } catch (err) {
    console.error('Failed to save free week ledger:', err)
  }
}

// ─── Queries ─────────────────────────────────────────────────────

/** How many free weeks this tenant has remaining */
export function freeWeeksRemaining(ledger: FreeWeekLedger, tenantId: string): number {
  const rec = ledger[tenantId]
  if (!rec) return 0
  return Math.max(0, rec.totalEntitled - rec.used.length)
}

/** How many free weeks this tenant has used */
export function freeWeeksUsed(ledger: FreeWeekLedger, tenantId: string): number {
  const rec = ledger[tenantId]
  return rec ? rec.used.length : 0
}

/** How many total free weeks this tenant is entitled to */
export function freeWeeksEntitled(ledger: FreeWeekLedger, tenantId: string): number {
  const rec = ledger[tenantId]
  return rec ? rec.totalEntitled : 0
}

/** Check if a specific week is already recorded as used */
export function isWeekUsed(ledger: FreeWeekLedger, tenantId: string, friday: string): boolean {
  const rec = ledger[tenantId]
  if (!rec) return false
  return rec.used.some(u => u.friday === friday)
}

// ─── Mutations ───────────────────────────────────────────────────

/** Set a tenant's total entitlement (e.g. add 1 when they renew a lease) */
export function setEntitlement(
  ledger: FreeWeekLedger,
  tenantId: string,
  totalEntitled: number,
  notes?: string
): FreeWeekLedger {
  const existing = ledger[tenantId]
  const updated: FreeWeekRecord = {
    tenantId,
    totalEntitled,
    used: existing?.used || [],
    notes: notes ?? existing?.notes,
    updatedAt: new Date().toISOString(),
  }
  return { ...ledger, [tenantId]: updated }
}

/** Add 1 to a tenant's entitlement (lease renewal) */
export function addEntitlement(ledger: FreeWeekLedger, tenantId: string): FreeWeekLedger {
  const current = freeWeeksEntitled(ledger, tenantId)
  return setEntitlement(ledger, tenantId, current + 1)
}

/** Record a free week usage for a tenant */
export function recordFreeWeekUsage(
  ledger: FreeWeekLedger,
  tenantId: string,
  monthKey: string,
  friday: string,
): FreeWeekLedger {
  // Don't double-record
  if (isWeekUsed(ledger, tenantId, friday)) return ledger

  const existing = ledger[tenantId] || {
    tenantId,
    totalEntitled: 0,
    used: [],
    updatedAt: new Date().toISOString(),
  }

  const usage: FreeWeekUsage = {
    monthKey,
    friday,
    recordedAt: new Date().toISOString(),
  }

  return {
    ...ledger,
    [tenantId]: {
      ...existing,
      used: [...existing.used, usage],
      updatedAt: new Date().toISOString(),
    },
  }
}

/** Remove a free week usage (e.g. when status is changed away from free_week) */
export function removeFreeWeekUsage(
  ledger: FreeWeekLedger,
  tenantId: string,
  friday: string,
): FreeWeekLedger {
  const existing = ledger[tenantId]
  if (!existing) return ledger
  const filtered = existing.used.filter(u => u.friday !== friday)
  if (filtered.length === existing.used.length) return ledger // nothing to remove
  return {
    ...ledger,
    [tenantId]: {
      ...existing,
      used: filtered,
      updatedAt: new Date().toISOString(),
    },
  }
}

// ─── Backfill ────────────────────────────────────────────────────

/**
 * Scan all saved month data for free_week statuses and populate the ledger.
 * Only adds usages that aren't already recorded. Does NOT touch entitlements
 * (Darius sets those manually).
 */
export function backfillFromMonthData(
  ledger: FreeWeekLedger,
  listSavedMonths: () => string[],
  loadMonthData: (key: string) => { monthKey: string; weeks: Record<string, Array<{ tenant: { id: string }; status: string }>> } | null,
): FreeWeekLedger {
  let result = { ...ledger }

  for (const monthKey of listSavedMonths()) {
    const data = loadMonthData(monthKey)
    if (!data) continue

    for (const [friday, entries] of Object.entries(data.weeks)) {
      for (const entry of entries) {
        if (entry.status === 'free_week') {
          result = recordFreeWeekUsage(result, entry.tenant.id, monthKey, friday)
        }
      }
    }
  }

  return result
}
