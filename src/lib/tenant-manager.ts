// Tenant management: localStorage-backed CRUD for tenants + credit tracking
// Replaces static TENANTS array with a mutable, persistent tenant list

import { Tenant, PaymentType, BillingFrequency } from '@/types'
import { TENANTS as DEFAULT_TENANTS } from './tenant-data'
import { pushKey } from './cloud-sync'

const TENANTS_KEY = 'salon-tenants'
const CREDITS_KEY = 'salon-credits'

// ---- Tenant CRUD ----

export function loadTenants(): Tenant[] {
  if (typeof window === 'undefined') return DEFAULT_TENANTS
  try {
    const raw = localStorage.getItem(TENANTS_KEY)
    if (!raw) return DEFAULT_TENANTS
    const saved = JSON.parse(raw) as Tenant[]
    return saved.length > 0 ? saved : DEFAULT_TENANTS
  } catch {
    return DEFAULT_TENANTS
  }
}

export function saveTenants(tenants: Tenant[]) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(TENANTS_KEY, JSON.stringify(tenants))
  } catch (err) {
    console.error('Failed to save tenants:', err)
  }
  pushKey(TENANTS_KEY, tenants) // best-effort cloud mirror
}

let nextId = 100 // start high to avoid conflicts with seed data

function generateId(): string {
  nextId++
  return `t-${Date.now()}-${nextId}`
}

export interface TenantFormData {
  name: string
  secondName?: string
  suiteNumber: string
  weeklyRent: number
  billingFrequency: BillingFrequency
  defaultPayType?: PaymentType
  moveInDate: string
  phone?: string
  email?: string
  securityDeposit?: number
  leaseEnd?: string
  notes?: string
}

export function createTenant(tenants: Tenant[], data: TenantFormData): Tenant[] {
  const newTenant: Tenant = {
    id: generateId(),
    name: data.secondName ? `${data.name} & ${data.secondName}` : data.name,
    secondName: data.secondName || undefined,
    suiteNumber: data.suiteNumber,
    weeklyRent: data.weeklyRent,
    billingFrequency: data.billingFrequency,
    defaultPayType: data.defaultPayType,
    moveInDate: data.moveInDate,
    phone: data.phone || '',
    email: data.email || '',
    securityDeposit: data.securityDeposit,
    leaseEnd: data.leaseEnd,
    notes: data.notes || '',
    isActive: true,
    isArchived: false,
    credit: 0,
  }

  // Replace the vacant entry for this suite (if exists) or add new
  const updated = tenants.map(t => {
    if (t.suiteNumber === data.suiteNumber && !t.isActive && !t.isArchived) {
      return newTenant
    }
    return t
  })

  // If no vacant was replaced, append
  if (!updated.find(t => t.id === newTenant.id)) {
    updated.push(newTenant)
  }

  saveTenants(updated)
  return updated
}

export function updateTenant(tenants: Tenant[], tenantId: string, data: Partial<TenantFormData>): Tenant[] {
  const updated = tenants.map(t => {
    if (t.id !== tenantId) return t
    const name = data.secondName !== undefined
      ? (data.secondName ? `${data.name || t.name.split(' & ')[0]} & ${data.secondName}` : data.name || t.name)
      : data.name || t.name
    return {
      ...t,
      name,
      secondName: data.secondName ?? t.secondName,
      suiteNumber: data.suiteNumber ?? t.suiteNumber,
      weeklyRent: data.weeklyRent ?? t.weeklyRent,
      billingFrequency: data.billingFrequency ?? t.billingFrequency,
      defaultPayType: data.defaultPayType ?? t.defaultPayType,
      moveInDate: data.moveInDate ?? t.moveInDate,
      phone: data.phone ?? t.phone,
      email: data.email ?? t.email,
      securityDeposit: data.securityDeposit ?? t.securityDeposit,
      leaseEnd: data.leaseEnd ?? t.leaseEnd,
      notes: data.notes ?? t.notes,
    }
  })
  saveTenants(updated)
  return updated
}

export function archiveTenant(tenants: Tenant[], tenantId: string, lastDay: string): Tenant[] {
  const tenant = tenants.find(t => t.id === tenantId)
  if (!tenant) return tenants

  // Archive the tenant
  const archivedTenant: Tenant = {
    ...tenant,
    isActive: false,
    isArchived: true,
    movedOutDate: lastDay,
  }

  // Create a vacant placeholder for the suite
  const vacantPlaceholder: Tenant = {
    id: generateId(),
    name: 'Vacant',
    suiteNumber: tenant.suiteNumber,
    weeklyRent: tenant.weeklyRent,
    billingFrequency: 'weekly',
    isActive: false,
    isArchived: false,
    phone: '',
  }

  const updated = tenants.map(t => {
    if (t.id === tenantId) return archivedTenant
    return t
  })

  // Add vacant placeholder after the archived tenant
  const archIdx = updated.findIndex(t => t.id === tenantId)
  updated.splice(archIdx + 1, 0, vacantPlaceholder)

  saveTenants(updated)
  return updated
}

export function getActiveTenants(tenants: Tenant[]): Tenant[] {
  return tenants.filter(t => !t.isArchived)
}

export function getArchivedTenants(tenants: Tenant[]): Tenant[] {
  return tenants.filter(t => t.isArchived === true)
}

// ---- Credit Management ----

export function loadCredits(): Record<string, number> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(CREDITS_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, number>
  } catch {
    return {}
  }
}

export function saveCredits(credits: Record<string, number>) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(CREDITS_KEY, JSON.stringify(credits))
  } catch (err) {
    console.error('Failed to save credits:', err)
  }
  pushKey(CREDITS_KEY, credits) // best-effort cloud mirror
}

export function addCredit(credits: Record<string, number>, tenantId: string, amount: number): Record<string, number> {
  const updated = { ...credits }
  updated[tenantId] = (updated[tenantId] || 0) + amount
  // Round to avoid floating point issues
  updated[tenantId] = Math.round(updated[tenantId] * 100) / 100
  if (updated[tenantId] <= 0) delete updated[tenantId]
  saveCredits(updated)
  return updated
}

export function useCredit(credits: Record<string, number>, tenantId: string, amount: number): Record<string, number> {
  const updated = { ...credits }
  const current = updated[tenantId] || 0
  const used = Math.min(current, amount)
  updated[tenantId] = Math.round((current - used) * 100) / 100
  if (updated[tenantId] <= 0) delete updated[tenantId]
  saveCredits(updated)
  return updated
}

export function getTenantCredit(credits: Record<string, number>, tenantId: string): number {
  return credits[tenantId] || 0
}
