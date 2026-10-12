// Prospect tracking for the Salon Rent Tracker
// Manages potential tenants interested in renting suites.
// NOT month-scoped — prospects persist globally until archived.

import { pushKey } from './cloud-sync'

export type ProspectStatus = 'new' | 'contacted' | 'toured' | 'approved' | 'signed' | 'archived'

export interface Prospect {
  id: string
  name: string
  phone: string
  email: string
  /** Which suite(s) they're interested in, free-text e.g. "114" or "any" */
  suiteInterest: string
  status: ProspectStatus
  /** Where the lead came from */
  source: 'website' | 'ebi' | 'walk-in' | 'referral' | 'other'
  notes: string
  /** ISO date when the prospect was added */
  createdAt: string
  /** ISO date of last status change */
  updatedAt: string
}

const STORAGE_KEY = 'salon-prospects'

export const PROSPECT_STATUSES: ProspectStatus[] = ['new', 'contacted', 'toured', 'approved', 'signed', 'archived']

export const STATUS_LABELS: Record<ProspectStatus, string> = {
  new: 'New Lead',
  contacted: 'Contacted',
  toured: 'Toured',
  approved: 'Approved',
  signed: 'Signed Lease',
  archived: 'Archived',
}

export const STATUS_COLORS: Record<ProspectStatus, string> = {
  new: 'bg-blue-100 text-blue-800 border-blue-200',
  contacted: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  toured: 'bg-purple-100 text-purple-800 border-purple-200',
  approved: 'bg-green-100 text-green-800 border-green-200',
  signed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  archived: 'bg-gray-100 text-gray-500 border-gray-200',
}

export const SOURCE_LABELS: Record<Prospect['source'], string> = {
  website: 'Website',
  ebi: 'Ebi (District Mgr)',
  'walk-in': 'Walk-In',
  referral: 'Referral',
  other: 'Other',
}

// ─── Persistence ─────────────────────────────────────────────────

export function loadProspects(): Prospect[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Prospect[]) : []
  } catch {
    return []
  }
}

export function saveProspects(prospects: Prospect[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prospects))
  } catch (err) {
    console.error('Failed to save prospects:', err)
  }
  pushKey(STORAGE_KEY, prospects)
}

// ─── Helpers ─────────────────────────────────────────────────────

export function newProspectId(): string {
  return `prospect-${Date.now()}-${Math.floor(Math.random() * 1000)}`
}

export function createProspect(data: Omit<Prospect, 'id' | 'createdAt' | 'updatedAt'>): Prospect {
  const now = new Date().toISOString()
  return { ...data, id: newProspectId(), createdAt: now, updatedAt: now }
}

/** Active prospects = everything except archived */
export function activeProspects(prospects: Prospect[]): Prospect[] {
  return prospects.filter(p => p.status !== 'archived')
}

/** Count by status for summary cards */
export function prospectCounts(prospects: Prospect[]): Record<ProspectStatus, number> {
  const counts: Record<ProspectStatus, number> = {
    new: 0, contacted: 0, toured: 0, approved: 0, signed: 0, archived: 0,
  }
  for (const p of prospects) counts[p.status]++
  return counts
}
