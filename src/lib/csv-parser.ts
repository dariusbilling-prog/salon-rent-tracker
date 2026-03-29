import Papa from 'papaparse'
import Fuse from 'fuse.js'
import { Tenant, Payment, PaymentType } from '@/types'

interface CSVRow {
  [key: string]: string
}

interface CSVMatchResult {
  matched: Array<{
    csvRow: CSVRow
    tenant: Tenant
    amount: number
    paymentType: PaymentType
    confidence: number
    matchMethod: 'exact' | 'fuzzy'
  }>
  unmatched: Array<{
    csvRow: CSVRow
    amount: number
    name: string
    suggestedTenant?: Tenant
    confidence?: number
  }>
  skipped: Array<{
    csvRow: CSVRow
    reason: string
  }>
}

// Map common TenantCloud column names to our fields
// TenantCloud actual headers: Transaction ID, Status, Date created, Due date,
// Date paid, Type, Transaction category, Currency, Total amount, Paid amount,
// Left amount, Method of payment, Payer/payee, Payer/payee email, Lease #,
// Property name, Unit #, Street address, City, State/Region, Zip, Country,
// Transaction details, Tags
const COLUMN_MAPPINGS: Record<string, string[]> = {
  tenantName: ['payer/payee', 'tenant name', 'tenant', 'name', 'resident', 'resident name', 'renter'],
  amount: ['paid amount', 'total amount', 'amount', 'payment amount', 'paid', 'total', 'rent paid'],
  paymentDate: ['date paid', 'date created', 'due date', 'date', 'payment date', 'paid date', 'transaction date'],
  paymentType: ['method of payment', 'payment method', 'method', 'type', 'payment type'],
  status: ['status', 'payment status'],
  suiteNumber: ['unit #', 'unit', 'suite', 'suite number'],
  transactionId: ['transaction id', 'id', 'reference'],
  type: ['type', 'transaction category'],
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
  return 'ACH' // default for TenantCloud
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

  // Auto-detect or use provided column mapping
  const nameCol = columnMap?.tenantName || findColumn(headers, 'tenantName')
  const amountCol = columnMap?.amount || findColumn(headers, 'amount')
  const dateCol = columnMap?.paymentDate || findColumn(headers, 'paymentDate')
  const typeCol = columnMap?.paymentType || findColumn(headers, 'paymentType')
  const statusCol = columnMap?.status || findColumn(headers, 'status')

  if (!nameCol || !amountCol) {
    throw new Error(`Could not find required columns. Found headers: ${headers.join(', ')}. Need at least tenant name and amount.`)
  }

  // Set up fuzzy matching
  const activeTenants = tenants.filter(t => t.isActive)
  const fuse = new Fuse(activeTenants, {
    keys: ['name'],
    threshold: 0.4,
    includeScore: true,
  })

  const result: CSVMatchResult = { matched: [], unmatched: [], skipped: [] }

  for (const row of parsed.data) {
    const rawName = row[nameCol]?.trim()
    const rawAmount = row[amountCol]?.trim()
    const rawStatus = statusCol ? row[statusCol]?.trim() : ''

    if (!rawName || !rawAmount) {
      result.skipped.push({ csvRow: row, reason: 'Missing name or amount' })
      continue
    }

    // Skip if status indicates not completed
    if (rawStatus && !['completed', 'paid', 'processed', 'success'].some(s => rawStatus.toLowerCase().includes(s))) {
      if (['pending', 'failed', 'cancelled', 'refunded'].some(s => rawStatus.toLowerCase().includes(s))) {
        result.skipped.push({ csvRow: row, reason: `Status: ${rawStatus}` })
        continue
      }
    }

    const amount = parseFloat(rawAmount.replace(/[$,]/g, ''))
    if (isNaN(amount) || amount <= 0) {
      result.skipped.push({ csvRow: row, reason: 'Invalid amount' })
      continue
    }

    const paymentType = typeCol ? normalizePaymentType(row[typeCol] || '') : 'ACH'

    // Try exact match first (case-insensitive)
    const normalizedName = rawName.toLowerCase().replace(/\s+/g, ' ')
    const exactMatch = activeTenants.find(t =>
      t.name.toLowerCase().replace(/\s+/g, ' ') === normalizedName ||
      // Also try matching with suite number stripped (TenantCloud often includes it)
      normalizedName.includes(t.name.toLowerCase())
    )

    if (exactMatch) {
      result.matched.push({
        csvRow: row,
        tenant: exactMatch,
        amount,
        paymentType,
        confidence: 1.0,
        matchMethod: 'exact',
      })
      continue
    }

    // Try fuzzy match
    const fuzzyResults = fuse.search(rawName)
    if (fuzzyResults.length > 0 && fuzzyResults[0].score !== undefined && fuzzyResults[0].score < 0.4) {
      const bestMatch = fuzzyResults[0]
      const confidence = 1 - (bestMatch.score || 0)

      if (confidence >= 0.7) {
        result.matched.push({
          csvRow: row,
          tenant: bestMatch.item,
          amount,
          paymentType,
          confidence,
          matchMethod: 'fuzzy',
        })
      } else {
        result.unmatched.push({
          csvRow: row,
          amount,
          name: rawName,
          suggestedTenant: bestMatch.item,
          confidence,
        })
      }
    } else {
      result.unmatched.push({
        csvRow: row,
        amount,
        name: rawName,
      })
    }
  }

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
