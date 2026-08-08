// Maintenance log — the fourth section of the monthly P&L.
//
// Repairs are a real monthly cost and the report has always carried them, but
// nothing in the app recorded them, so they were retyped into a spreadsheet by
// hand every month. Stored per month alongside the rent data and mirrored to the
// cloud the same way.

import { pushKey } from './cloud-sync'

export interface MaintenanceEntry {
  id: string
  /** ISO date the work happened. */
  date: string
  company: string
  /** "Building" or a specific suite number. */
  location: string
  /** Plumbing, HVAC, Electrical, and so on. */
  activity: string
  cost: number
  /** Usually the invoice number. */
  notes: string
}

const PREFIX = 'salon-maintenance:'

export function loadMaintenance(monthKey: string): MaintenanceEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(PREFIX + monthKey)
    return raw ? (JSON.parse(raw) as MaintenanceEntry[]) : []
  } catch {
    return []
  }
}

export function saveMaintenance(monthKey: string, entries: MaintenanceEntry[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(PREFIX + monthKey, JSON.stringify(entries))
  } catch (err) {
    console.error('Failed to save maintenance log:', err)
  }
  pushKey(PREFIX + monthKey, entries)
}

export function maintenanceTotal(entries: MaintenanceEntry[]): number {
  return Math.round(entries.reduce((sum, e) => sum + (e.cost || 0), 0) * 100) / 100
}

export function newMaintenanceId(): string {
  return `m-${Date.now()}-${Math.floor(Math.random() * 1000)}`
}
