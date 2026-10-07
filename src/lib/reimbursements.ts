// Out-of-pocket reimbursements — items Darius paid for personally that the
// business account owes back. Stored per month alongside the rent data and
// mirrored to the cloud the same way as the maintenance log.

import { pushKey } from './cloud-sync'

export interface ReimbursementEntry {
  id: string
  /** ISO date of the purchase. */
  date: string
  /** What was bought. */
  name: string
  /** What it was used for. */
  purpose: string
  cost: number
  notes?: string
}

const PREFIX = 'salon-reimbursements:'

export function loadReimbursements(monthKey: string): ReimbursementEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(PREFIX + monthKey)
    return raw ? (JSON.parse(raw) as ReimbursementEntry[]) : []
  } catch {
    return []
  }
}

export function saveReimbursements(monthKey: string, entries: ReimbursementEntry[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(PREFIX + monthKey, JSON.stringify(entries))
  } catch (err) {
    console.error('Failed to save reimbursements:', err)
  }
  pushKey(PREFIX + monthKey, entries)
}

export function reimbursementsTotal(entries: ReimbursementEntry[]): number {
  return Math.round(entries.reduce((sum, e) => sum + (e.cost || 0), 0) * 100) / 100
}

export function newReimbursementId(): string {
  return `r-${Date.now()}-${Math.floor(Math.random() * 1000)}`
}
