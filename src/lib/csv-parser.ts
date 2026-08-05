import Papa from 'papaparse'
import Fuse from 'fuse.js'
import { Tenant, PaymentType } from '@/types'

interface CSVRow {
  [key: string]: string
}

export interface CSVMatch {
  csvRow: CSVRow
  tenant: Tenant
  amount: number
  paymentType: PaymentType
  confidence: number
  matchMethod: 'suite' | 'exact' | 'fuzzy'
  csvName: string
  csvUnit: string
  dueDate: string // ISO format YYYY-MM-DD (the Friday this belongs to)
  isMonthlyPayment: boolean // true if this is a monthly recurring payment
  /** Raw TenantCloud statuses behind this match, e.g. ["Paid"] or ["Pending"]. */
  statuses: string[]
  /**
   * Portion of `amount` that TenantCloud has NOT settled yet.
   *
   * ACH shows as "Pending" for days after it is initiated. The money is real but
   * it is not in the bank, and a month-end report sent to an accountant has to
   * say so — otherwise a pending transfer is indistinguishable from cleared cash.
   */
  pendingAmount: number
  /** Latest "Date paid" seen, ISO. Used to tell on-time from late. */
  paidDate?: string
}

export interface CSVMatchResult {
  matched: CSVMatch[]
  unmatched: Array<{
    csvRow: CSVRow
    amount: number
    name: string
    unit: string
    suggestedTenant?: Tenant
    confidence?: number
  }>
  skipped: Array<{
    csvRow: CSVRow
    reason: string
  }>
  availableDueDates: string[] // ISO YYYY-MM-DD Fridays found in the CSV
  monthsDetected: string[] // YYYY-MM format
}

// Convert a date string to ISO YYYY-MM-DD
function toISODate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  } catch {
    return dateStr
  }
}

// Convert a date string to YYYY-MM month key
function toMonthKey(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  } catch {
    return dateStr
  }
}

// Map TenantCloud column names to our fields
const COLUMN_MAPPINGS: Record<string, string[]> = {
  tenantName: ['payer/payee', 'tenant name', 'tenant', 'name', 'resident', 'resident name', 'renter'],
  amount: ['paid amount', 'total amount', 'amount', 'payment amount', 'paid', 'total', 'rent paid'],
  paymentDate: ['date paid', 'date created', 'due date', 'date', 'payment date', 'paid date', 'transaction date'],
  datePaid: ['date paid', 'paid date', 'settled date'],
  dueDate: ['due date', 'due_date'],
  paymentType: ['method of payment', 'payment method', 'method', 'payment type'],
  status: ['status', 'payment status'],
  suiteNumber: ['unit #', 'unit', 'suite', 'suite number'],
  transactionCategory: ['transaction category', 'category'],
  transactionType: ['type'],
}

function findColumn(headers: string[], field: string): string | null {
  const possibleNames = COLUMN_MAPPINGS[field] || []
  const headerLower = headers.map(h => h.toLowerCase().trim())

  for (const name of possibleNames) {
    const idx = headerLower.indexOf(name)
    if (idx !== -1) return headers[idx]
  }
  return null
}

function normalizePaymentType(raw: string): PaymentType {
  const lower = raw.toLowerCase().trim()
  if (lower.includes('ach')) return 'ACH'
  if (lower.includes('credit') || lower.includes('card') || lower.includes('debit')) return 'Card'
  if (lower.includes('zelle')) return 'Zelle'
  if (lower.includes('check') || lower.includes('cheque')) return 'Check'
  if (lower.includes('cash')) return 'Cash'
  if (lower.includes('money order')) return 'Money Order'
  if (lower.includes('other')) return 'Cash' // "Other payment method" in TenantCloud often means Zelle/Cash
  return 'ACH' // default for TenantCloud
}

// Normalize suite numbers for comparison
function normalizeSuite(suite: string): string[] {
  const cleaned = suite.replace(/\s+/g, '').toLowerCase()
  const variants: string[] = [cleaned]

  // "122-2" → also try "122"
  if (cleaned.includes('-')) {
    variants.push(cleaned.split('-')[0])
  }

  return variants
}

function findTenantBySuite(suiteFromCSV: string, tenants: Tenant[]): Tenant | null {
  const csvVariants = normalizeSuite(suiteFromCSV)

  for (const tenant of tenants) {
    const tenantSuite = tenant.suiteNumber.toLowerCase().replace(/\s+/g, '')

    // Direct match
    if (csvVariants.includes(tenantSuite)) return tenant

    // Check if CSV suite is part of a combined suite (e.g., CSV "129" matches tenant "128/129")
    if (tenantSuite.includes('/')) {
      const parts = tenantSuite.split('/')
      for (const csvVar of csvVariants) {
        if (parts.includes(csvVar)) return tenant
      }
    }

    // Check if CSV suite "102" matches tenant "101/102"
    for (const csvVar of csvVariants) {
      if (tenantSuite.includes(csvVar)) return tenant
    }
  }

  return null
}

// Extract unique due dates from CSV for the date picker
// Only includes weekly rent due dates (excludes monthly)
export function extractDueDates(csvText: string): string[] {
  const parsed = Papa.parse<CSVRow>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  })

  const headers = parsed.meta.fields || []
  const dueDateCol = findColumn(headers, 'dueDate')
  const txnTypeCol = findColumn(headers, 'transactionType')
  const categoryCol = findColumn(headers, 'transactionCategory')
  if (!dueDateCol) return []

  const dates = new Set<string>()
  for (const row of parsed.data) {
    const d = row[dueDateCol]?.trim()
    if (!d || d === '-') continue

    // Only include weekly rent due dates in the picker (not monthly or one-time)
    const txnType = txnTypeCol ? row[txnTypeCol]?.trim().toLowerCase() || '' : ''
    const category = categoryCol ? row[categoryCol]?.trim().toLowerCase() || '' : ''

    // Skip non-rent, monthly, and one-time entries in the date picker
    if (category && !category.includes('rent')) continue
    if (txnType.includes('monthly') || txnType.includes('one time')) continue

    dates.add(d)
  }

  return Array.from(dates).sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
}

export function parseAndMatchCSV(
  csvText: string,
  tenants: Tenant[],
  columnMap?: Record<string, string>
): CSVMatchResult {
  const parsed = Papa.parse<CSVRow>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  })

  if (parsed.errors.length > 0) {
    console.warn('CSV parse warnings:', parsed.errors)
  }

  const headers = parsed.meta.fields || []

  // Auto-detect columns
  const nameCol = columnMap?.tenantName || findColumn(headers, 'tenantName')
  const amountCol = columnMap?.amount || findColumn(headers, 'amount')
  const dueDateCol = columnMap?.dueDate || findColumn(headers, 'dueDate')
  const typeCol = columnMap?.paymentType || findColumn(headers, 'paymentType')
  const statusCol = columnMap?.status || findColumn(headers, 'status')
  const paidDateCol = findColumn(headers, 'datePaid')
  const suiteCol = columnMap?.suiteNumber || findColumn(headers, 'suiteNumber')
  const categoryCol = findColumn(headers, 'transactionCategory')
  const txnTypeCol = findColumn(headers, 'transactionType')

  if (!nameCol || !amountCol) {
    throw new Error(`Could not find required columns. Found headers: ${headers.join(', ')}. Need at least tenant name and amount.`)
  }

  // Get all available weekly due dates and months
  const availableDueDates = dueDateCol ? extractDueDates(csvText).map(toISODate) : []
  const monthsDetected = Array.from(new Set(availableDueDates.map(toMonthKey))).sort()

  // Set up fuzzy matching as fallback
  const activeTenants = tenants.filter(t => t.isActive)
  const fuse = new Fuse(activeTenants, {
    keys: ['name'],
    threshold: 0.4,
    includeScore: true,
  })

  const result: CSVMatchResult = { matched: [], unmatched: [], skipped: [], availableDueDates, monthsDetected }

  // Track amounts per (suite + dueDate) to combine split payments per week
  type SuitePaymentData = {
    tenant: Tenant
    totalAmount: number
    paymentType: PaymentType
    rows: CSVRow[]
    names: string[]
    matchMethod: 'suite' | 'exact' | 'fuzzy'
    dueDate: string // ISO format
    isMonthlyPayment: boolean
    statuses: string[]
    pendingAmount: number
    paidDate?: string
  }
  const suitePayments = new Map<string, SuitePaymentData>()

  for (const row of parsed.data) {
    const rawName = row[nameCol]?.trim()
    const rawAmount = row[amountCol]?.trim()
    const rawStatus = statusCol ? row[statusCol]?.trim() : ''
    const rawDueDate = dueDateCol ? row[dueDateCol]?.trim() : ''
    const rawSuite = suiteCol ? row[suiteCol]?.trim() : ''
    const rawCategory = categoryCol ? row[categoryCol]?.trim() : ''
    const rawTxnType = txnTypeCol ? row[txnTypeCol]?.trim() : ''

    // Check if this is a monthly recurring transaction
    const isMonthlyTxn = rawTxnType.toLowerCase().includes('monthly')

    if (!rawName || !rawAmount) {
      result.skipped.push({ csvRow: row, reason: 'Missing name or amount' })
      continue
    }

    // Skip non-rent transactions (like late fees, software expenses)
    if (rawCategory && !rawCategory.toLowerCase().includes('rent')) {
      result.skipped.push({ csvRow: row, reason: `Not rent: ${rawCategory}` })
      continue
    }

    // Skip voided transactions
    if (rawStatus && rawStatus.toLowerCase() === 'void') {
      result.skipped.push({ csvRow: row, reason: `Voided transaction` })
      continue
    }

    // Skip overdue/unpaid entries (no payment made)
    if (rawStatus && rawStatus.toLowerCase() === 'overdue') {
      result.skipped.push({ csvRow: row, reason: `Status: ${rawStatus}` })
      continue
    }

    // Skip failed/cancelled/refunded
    if (rawStatus && ['failed', 'cancelled', 'refunded'].some(s => rawStatus.toLowerCase().includes(s))) {
      result.skipped.push({ csvRow: row, reason: `Status: ${rawStatus}` })
      continue
    }

    // Include: Paid, Completed, Processed, Partial, Pending (with amount)
    // Pending in TenantCloud often means payment is processing but will go through

    const amount = parseFloat(rawAmount.replace(/[$,]/g, ''))
    if (isNaN(amount) || amount <= 0) {
      result.skipped.push({ csvRow: row, reason: 'Invalid or zero amount' })
      continue
    }

    const paymentType = typeCol ? normalizePaymentType(row[typeCol] || '') : 'ACH'
    const isoDate = toISODate(rawDueDate)

    // "Pending" is the one status we keep rather than collapse: the amount counts
    // as received for reconciliation, but must be reportable as not-yet-cleared.
    const isPendingRow = rawStatus.toLowerCase() === 'pending'
    const rawPaidDate = paidDateCol ? row[paidDateCol]?.trim() : ''
    const rowPaidDate = rawPaidDate && rawPaidDate !== '-' ? toISODate(rawPaidDate) : undefined

    // Helper to add/combine a match entry (keyed by tenant + dueDate)
    const addMatch = (tenant: Tenant, matchMethod: 'suite' | 'exact' | 'fuzzy') => {
      const key = `${tenant.id}:${isoDate}`
      if (suitePayments.has(key)) {
        const existing = suitePayments.get(key)!
        existing.totalAmount += amount
        existing.rows.push(row)
        if (isPendingRow) existing.pendingAmount += amount
        if (!existing.statuses.includes(rawStatus)) existing.statuses.push(rawStatus)
        // Suite 135 is split across three stylists; keep the latest settlement date.
        if (rowPaidDate && (!existing.paidDate || rowPaidDate > existing.paidDate)) {
          existing.paidDate = rowPaidDate
        }
        if (!existing.names.includes(rawName)) {
          existing.names.push(rawName)
        }
      } else {
        suitePayments.set(key, {
          tenant,
          totalAmount: amount,
          paymentType,
          rows: [row],
          names: [rawName],
          matchMethod,
          dueDate: isoDate,
          isMonthlyPayment: isMonthlyTxn,
          statuses: rawStatus ? [rawStatus] : [],
          pendingAmount: isPendingRow ? amount : 0,
          paidDate: rowPaidDate,
        })
      }
    }

    // === MATCHING WATERFALL ===

    // Step 1: Match by Suite Number (most reliable)
    if (rawSuite) {
      const suiteMatch = findTenantBySuite(rawSuite, activeTenants)
      if (suiteMatch) {
        addMatch(suiteMatch, 'suite')
        continue
      }
    }

    // Step 2: Exact name match
    const normalizedName = rawName.toLowerCase().replace(/\s+/g, ' ')
    const exactMatch = activeTenants.find(t =>
      t.name.toLowerCase().replace(/\s+/g, ' ') === normalizedName ||
      normalizedName.includes(t.name.toLowerCase())
    )

    if (exactMatch) {
      addMatch(exactMatch, 'exact')
      continue
    }

    // Step 3: Fuzzy name match
    const fuzzyResults = fuse.search(rawName)
    if (fuzzyResults.length > 0 && fuzzyResults[0].score !== undefined && fuzzyResults[0].score < 0.4) {
      const bestMatch = fuzzyResults[0]
      const confidence = 1 - (bestMatch.score || 0)

      if (confidence >= 0.7) {
        addMatch(bestMatch.item, 'fuzzy')
      } else {
        result.unmatched.push({
          csvRow: row,
          amount,
          name: rawName,
          unit: rawSuite,
          suggestedTenant: bestMatch.item,
          confidence,
        })
      }
    } else {
      result.unmatched.push({
        csvRow: row,
        amount,
        name: rawName,
        unit: rawSuite,
      })
    }
  }

  // Convert combined suite payments into matched results
  Array.from(suitePayments.values()).forEach((data) => {
    result.matched.push({
      csvRow: data.rows[0],
      tenant: data.tenant,
      amount: Math.round(data.totalAmount * 100) / 100,
      paymentType: data.paymentType,
      confidence: 1.0,
      matchMethod: data.matchMethod,
      csvName: data.names.join(', '),
      csvUnit: data.rows[0]?.[findColumn(parsed.meta.fields || [], 'suiteNumber') || ''] || '',
      dueDate: data.dueDate,
      isMonthlyPayment: data.isMonthlyPayment,
      statuses: data.statuses,
      pendingAmount: Math.round(data.pendingAmount * 100) / 100,
      paidDate: data.paidDate,
    })
  })

  return result
}

// Remove old isSameMonth helper if no longer needed elsewhere
export { toISODate, toMonthKey }

// Returns CSV headers for the column mapping UI
export function getCSVHeaders(csvText: string): string[] {
  const parsed = Papa.parse(csvText, {
    header: true,
    preview: 1,
  })
  return parsed.meta.fields || []
}

// Returns first N rows for preview
export function getCSVPreview(csvText: string, rows: number = 5): CSVRow[] {
  const parsed = Papa.parse<CSVRow>(csvText, {
    header: true,
    preview: rows,
    skipEmptyLines: true,
  })
  return parsed.data
}
