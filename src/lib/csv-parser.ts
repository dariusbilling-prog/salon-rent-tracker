import Papa from 'papaparse'
import Fuse from 'fuse.js'
import { Tenant, Payment, PaymentType } from '@/types'

interface CSVRow {
  [key: string]: string
}

export interface CSVMatchResult {
  matched: Array<{
    csvRow: CSVRow
    tenant: Tenant
    amount: number
    paymentType: PaymentType
    confidence: number
    matchMethod: 'suite' | 'exact' | 'fuzzy'
    csvName: string
    csvUnit: string
  }>
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
  availableDueDates: string[]
}

// Map TenantCloud column names to our fields
// Actual TenantCloud headers: Transaction ID, Status, Date created, Due date,
// Date paid, Type, Transaction category, Currency, Total amount, Paid amount,
// Left amount, Method of payment, Payer/payee, Payer/payee email, Lease #,
// Property name, Unit #, Street address, City, State/Region, Zip, Country,
// Transaction details, Tags
const COLUMN_MAPPINGS: Record<string, string[]> = {
  tenantName: ['payer/payee', 'tenant name', 'tenant', 'name', 'resident', 'resident name', 'renter'],
  amount: ['paid amount', 'total amount', 'amount', 'payment amount', 'paid', 'total', 'rent paid'],
  paymentDate: ['date paid', 'date created', 'due date', 'date', 'payment date', 'paid date', 'transaction date'],
  dueDate: ['due date', 'due_date'],
  paymentType: ['method of payment', 'payment method', 'method', 'type', 'payment type'],
  status: ['status', 'payment status'],
  suiteNumber: ['unit #', 'unit', 'suite', 'suite number'],
  transactionCategory: ['transaction category', 'category'],
  type: ['type'],
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
// TenantCloud uses "122-2" but we use "122", "129" vs "128/129", etc.
function normalizeSuite(suite: string): string[] {
  const cleaned = suite.replace(/\s+/g, '').toLowerCase()

  // Generate possible matches
  const variants: string[] = [cleaned]

  // "122-2" → also try "122"
  if (cleaned.includes('-')) {
    variants.push(cleaned.split('-')[0])
  }

  // "129" → also try "128/129" format
  variants.push(cleaned)

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
export function extractDueDates(csvText: string): string[] {
  const parsed = Papa.parse<CSVRow>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  })

  const headers = parsed.meta.fields || []
  const dueDateCol = findColumn(headers, 'dueDate')
  if (!dueDateCol) return []

  const dates = new Set<string>()
  for (const row of parsed.data) {
    const d = row[dueDateCol]?.trim()
    if (d && d !== '-') dates.add(d)
  }

  // Sort dates chronologically
  return Array.from(dates).sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
}

export function parseAndMatchCSV(
  csvText: string,
  tenants: Tenant[],
  selectedDueDate?: string,
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
  const dateCol = columnMap?.paymentDate || findColumn(headers, 'paymentDate')
  const dueDateCol = columnMap?.dueDate || findColumn(headers, 'dueDate')
  const typeCol = columnMap?.paymentType || findColumn(headers, 'paymentType')
  const statusCol = columnMap?.status || findColumn(headers, 'status')
  const suiteCol = columnMap?.suiteNumber || findColumn(headers, 'suiteNumber')
  const categoryCol = findColumn(headers, 'transactionCategory')

  if (!nameCol || !amountCol) {
    throw new Error(`Could not find required columns. Found headers: ${headers.join(', ')}. Need at least tenant name and amount.`)
  }

  // Get all available due dates
  const availableDueDates = dueDateCol ? extractDueDates(csvText) : []

  // Set up fuzzy matching as fallback
  const activeTenants = tenants.filter(t => t.isActive)
  const fuse = new Fuse(activeTenants, {
    keys: ['name'],
    threshold: 0.4,
    includeScore: true,
  })

  const result: CSVMatchResult = { matched: [], unmatched: [], skipped: [], availableDueDates }

  // Track amounts per suite for combining split payments (like Suite 135)
  type SuitePaymentData = {
    tenant: Tenant
    totalAmount: number
    paymentType: PaymentType
    rows: CSVRow[]
    names: string[]
    matchMethod: 'suite' | 'exact' | 'fuzzy'
  }
  const suitePayments = new Map<string, SuitePaymentData>()

  for (const row of parsed.data) {
    const rawName = row[nameCol]?.trim()
    const rawAmount = row[amountCol]?.trim()
    const rawStatus = statusCol ? row[statusCol]?.trim() : ''
    const rawDueDate = dueDateCol ? row[dueDateCol]?.trim() : ''
    const rawSuite = suiteCol ? row[suiteCol]?.trim() : ''
    const rawCategory = categoryCol ? row[categoryCol]?.trim() : ''

    // Filter by selected due date if provided
    if (selectedDueDate && rawDueDate && rawDueDate !== selectedDueDate) {
      result.skipped.push({ csvRow: row, reason: `Different due date: ${rawDueDate}` })
      continue
    }

    if (!rawName || !rawAmount) {
      result.skipped.push({ csvRow: row, reason: 'Missing name or amount' })
      continue
    }

    // Skip non-rent transactions (like late fees)
    if (rawCategory && !rawCategory.toLowerCase().includes('rent')) {
      result.skipped.push({ csvRow: row, reason: `Not rent: ${rawCategory}` })
      continue
    }

    // Skip overdue/unpaid entries
    if (rawStatus && ['overdue'].some(s => rawStatus.toLowerCase().includes(s))) {
      result.skipped.push({ csvRow: row, reason: `Status: ${rawStatus}` })
      continue
    }

    // Skip if status indicates not completed
    if (rawStatus && !['paid', 'completed', 'processed', 'success', 'partial'].some(s => rawStatus.toLowerCase().includes(s))) {
      if (['pending', 'failed', 'cancelled', 'refunded'].some(s => rawStatus.toLowerCase().includes(s))) {
        result.skipped.push({ csvRow: row, reason: `Status: ${rawStatus}` })
        continue
      }
    }

    const amount = parseFloat(rawAmount.replace(/[$,]/g, ''))
    if (isNaN(amount) || amount <= 0) {
      result.skipped.push({ csvRow: row, reason: 'Invalid or zero amount' })
      continue
    }

    const paymentType = typeCol ? normalizePaymentType(row[typeCol] || '') : 'ACH'

    // === MATCHING WATERFALL ===

    // Step 1: Match by Suite Number (most reliable)
    if (rawSuite) {
      const suiteMatch = findTenantBySuite(rawSuite, activeTenants)
      if (suiteMatch) {
        // Combine payments for the same suite (handles Suite 135 split payments)
        const key = suiteMatch.id
        if (suitePayments.has(key)) {
          const existing = suitePayments.get(key)!
          existing.totalAmount += amount
          existing.rows.push(row)
          if (!existing.names.includes(rawName)) {
            existing.names.push(rawName)
          }
        } else {
          suitePayments.set(key, {
            tenant: suiteMatch,
            totalAmount: amount,
            paymentType,
            rows: [row],
            names: [rawName],
            matchMethod: 'suite',
          })
        }
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
      const key = exactMatch.id
      if (suitePayments.has(key)) {
        const existing = suitePayments.get(key)!
        existing.totalAmount += amount
        existing.rows.push(row)
      } else {
        suitePayments.set(key, {
          tenant: exactMatch,
          totalAmount: amount,
          paymentType,
          rows: [row],
          names: [rawName],
          matchMethod: 'exact',
        })
      }
      continue
    }

    // Step 3: Fuzzy name match
    const fuzzyResults = fuse.search(rawName)
    if (fuzzyResults.length > 0 && fuzzyResults[0].score !== undefined && fuzzyResults[0].score < 0.4) {
      const bestMatch = fuzzyResults[0]
      const confidence = 1 - (bestMatch.score || 0)

      if (confidence >= 0.7) {
        const key = bestMatch.item.id
        if (suitePayments.has(key)) {
          const existing = suitePayments.get(key)!
          existing.totalAmount += amount
          existing.rows.push(row)
        } else {
          suitePayments.set(key, {
            tenant: bestMatch.item,
            totalAmount: amount,
            paymentType,
            rows: [row],
            names: [rawName],
            matchMethod: 'fuzzy',
          })
        }
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
      csvRow: data.rows[0], // primary row
      tenant: data.tenant,
      amount: Math.round(data.totalAmount * 100) / 100, // fix floating point
      paymentType: data.paymentType,
      confidence: 1.0,
      matchMethod: data.matchMethod,
      csvName: data.names.join(', '),
      csvUnit: data.rows[0]?.[findColumn(parsed.meta.fields || [], 'suiteNumber') || ''] || '',
    })
  })

  return result
}

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
