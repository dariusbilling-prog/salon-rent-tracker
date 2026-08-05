// Seed data from the actual 3/13/26 weekly report
// This will be replaced by database reads once Supabase is connected

import { Tenant, TenantWeekEntry, WeekStatus } from '@/types'
import { monthlyWeekShare } from './utils'

export const TENANTS: Tenant[] = [
  { id: '1', name: 'Brenda Sanchez', suiteNumber: '101/102', weeklyRent: 425, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '2', name: 'Tammy', suiteNumber: '103', weeklyRent: 235, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '3', name: 'Ramie', suiteNumber: '104', weeklyRent: 220, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '4', name: 'Brenda Kiggans', suiteNumber: '105', weeklyRent: 245, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '5', name: 'Ashley/True', suiteNumber: '106/108', weeklyRent: 450, billingFrequency: 'monthly', isActive: true, notes: 'Pay once a month at end by check', phone: '' },
  { id: '6', name: 'GiGi', suiteNumber: '107', weeklyRent: 255, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '7', name: 'Jelissa', suiteNumber: '109', weeklyRent: 250, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '8', name: 'Stacie', suiteNumber: '110', weeklyRent: 220, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '9', name: 'Erica', suiteNumber: '111', weeklyRent: 225, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '10', name: 'Mike', suiteNumber: '112', weeklyRent: 200, billingFrequency: 'bi-weekly', isActive: true, phone: '' },
  { id: '11', name: 'Abigail', suiteNumber: '113', weeklyRent: 175, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '12', name: 'Brittany', suiteNumber: '114', weeklyRent: 200, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '13', name: 'Dani', suiteNumber: '115', weeklyRent: 200, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '14', name: 'Bianca', suiteNumber: '116', weeklyRent: 225, billingFrequency: 'weekly', isActive: true, notes: 'New Tenant - Fixing ACH Account', phone: '' },
  { id: '15', name: 'Sara', suiteNumber: '117', weeklyRent: 300, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '16', name: 'Meredith / Britani', suiteNumber: '118', weeklyRent: 310, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '17', name: 'Ciara', suiteNumber: '119', weeklyRent: 245, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '18', name: 'Lauren & Tonya', suiteNumber: '120/123', weeklyRent: 450, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '19', name: 'Donnie', suiteNumber: '121', weeklyRent: 285, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '20', name: 'Mallory', suiteNumber: '122', weeklyRent: 285, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '21', name: 'Vacant', suiteNumber: '124', weeklyRent: 265, billingFrequency: 'weekly', isActive: false },
  { id: '22', name: 'Marcy', suiteNumber: '125', weeklyRent: 265, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '23', name: 'Nancy', suiteNumber: '126', weeklyRent: 260, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '24', name: 'Courtney Martinez', suiteNumber: '127', weeklyRent: 350, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '25', name: 'Camille Ivy', suiteNumber: '128/129', weeklyRent: 350, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '26', name: 'Courtney', suiteNumber: '130', weeklyRent: 255, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '27', name: 'Stacey Armstrong', suiteNumber: '131', weeklyRent: 240, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '28', name: 'Kelley Winner', suiteNumber: '132', weeklyRent: 235, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '29', name: 'Kellli Tanner', suiteNumber: '133', weeklyRent: 235, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '30', name: 'Zedrick', suiteNumber: '134', weeklyRent: 250, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '31', name: 'Isabella, Leeah, Alyssa', suiteNumber: '135', weeklyRent: 450, billingFrequency: 'weekly', isActive: true, phone: '' },
  { id: '32', name: 'Stephany', suiteNumber: '136', weeklyRent: 265, billingFrequency: 'weekly', isActive: true, phone: '' },
]

/**
 * What one tenant owes for a single week of a month.
 *
 * Weekly and bi-weekly tenants owe `weeklyRent`. Monthly tenants owe an equal
 * share of `monthlyRent` — so a 5-Friday month costs them the same as a 4-Friday
 * one. Monthly tenants without a `monthlyRent` set fall back to `weeklyRent`,
 * which preserves the old (over-charging) behaviour until the amount is filled in.
 */
export function weekDueForTenant(tenant: Tenant, weekIndex = 0, weekCount = 1): number {
  if (
    tenant.billingFrequency === 'monthly' &&
    typeof tenant.monthlyRent === 'number' &&
    tenant.monthlyRent > 0
  ) {
    return monthlyWeekShare(tenant.monthlyRent, weekCount, weekIndex)
  }
  return tenant.weeklyRent
}

// Generate initial week entries from tenant data.
// `weekIndex` / `weekCount` position this week inside its month so monthly
// tenants can be billed a flat monthly amount rather than weeklyRent x weeks.
export function generateWeekEntries(
  tenants: Tenant[],
  weekIndex = 0,
  weekCount = 1
): TenantWeekEntry[] {
  return tenants.map(tenant => {
    const isVacant = !tenant.isActive
    let status: WeekStatus = 'unpaid'

    if (isVacant) {
      status = 'unpaid'
    } else if (tenant.billingFrequency === 'monthly') {
      status = 'monthly_pending'
    } else if (tenant.billingFrequency === 'bi-weekly') {
      // For demo, we'll show as unpaid — in production, the system checks
      // the alternating pattern based on lease start date
      status = 'unpaid'
    }

    return {
      tenant,
      status,
      amountDue: isVacant ? 0 : weekDueForTenant(tenant, weekIndex, weekCount),
      amountPaid: 0,
      payments: [],
      paymentType: undefined,
      confirmation: undefined,
      checkNumber: undefined,
      notes: tenant.notes || '',
      isVacant,
    }
  })
}
