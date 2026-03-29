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
  suiteNumber: string
  weeklyRent: number
  billingFrequency: BillingFrequency
  phone?: string
  email?: string
  isActive: boolean
  leaseStart?: string
  leaseEnd?: string
  notes?: string
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
