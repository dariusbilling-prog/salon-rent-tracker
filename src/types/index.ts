export type BillingFrequency = 'weekly' | 'bi-weekly' | 'monthly'

export type PaymentType = 'ACH' | 'Zelle' | 'Check' | 'Cash' | 'Money Order' | 'Card'

export type WeekStatus =
  | 'paid'
  | 'partial'
  | 'late'
  | 'unpaid'
  | 'free_week'
  | 'comped_week'
  | 'monthly_pending'
  | 'biweekly_off'

export type PaymentSource = 'tenantcloud' | 'zelle' | 'check' | 'cash' | 'manual'

export interface Tenant {
  id: string
  name: string
  secondName?: string
  suiteNumber: string
  weeklyRent: number
  /**
   * Flat amount charged per calendar month for tenants on `billingFrequency: 'monthly'`.
   * When set it is the source of truth for what the tenant owes that month, and it is
   * split across however many Fridays the month has (4 or 5). Leave undefined for
   * weekly/bi-weekly tenants, where `weeklyRent` is the source of truth.
   */
  monthlyRent?: number
  billingFrequency: BillingFrequency
  defaultPayType?: PaymentType
  phone?: string
  email?: string
  isActive: boolean
  isArchived?: boolean
  moveInDate?: string
  movedOutDate?: string
  leaseStart?: string
  leaseEnd?: string
  securityDeposit?: number
  notes?: string
  credit?: number
}

export interface Payment {
  id: string
  tenantId: string
  rentWeekId: string
  amount: number
  paymentDate: string
  source: PaymentSource
  paymentType: PaymentType
  checkNumber?: string
  notes?: string
  confirmation?: string
}

export interface TenantWeekEntry {
  tenant: Tenant
  status: WeekStatus
  amountDue: number
  amountPaid: number
  payments: Payment[]
  paymentType?: PaymentType
  confirmation?: string
  checkNumber?: string
  notes?: string
  isVacant?: boolean
  /**
   * Portion of `amountPaid` that has not cleared the bank yet (TenantCloud ACH
   * sitting in "Pending"). Counted as received for reconciliation, but excluded
   * from COLLECTED so a month-end report never overstates cash on hand.
   */
  pendingAmount?: number
  /** When the payment actually settled, ISO. Drives on-time vs late reporting. */
  paidDate?: string
}

export interface WeekSummary {
  weekStart: string
  weekEnd: string
  dueDate: string
  weekLabel: string
  totalDue: number
  totalPaid: number
  entries: TenantWeekEntry[]
}
