'use client'

import { useState, useMemo, useCallback, useRef } from 'react'
import {
  Upload, Plus, FileDown, ChevronLeft, ChevronRight,
  Check, AlertCircle, Clock, Gift, Heart, Calendar, Repeat
} from 'lucide-react'
import { TenantWeekEntry, WeekStatus, PaymentType, BillingFrequency } from '@/types'
import { TENANTS, generateWeekEntries } from '@/lib/tenant-data'
import { formatCurrency, getStatusLabel, getStatusColor, getCurrentRentWeek, cn } from '@/lib/utils'
import { generateWeeklyPDF } from '@/lib/pdf-generator'
import { parseAndMatchCSV, getCSVPreview, getCSVHeaders, extractDueDates, CSVMatchResult } from '@/lib/csv-parser'

const WEEK_STATUSES: WeekStatus[] = ['paid', 'partial', 'late', 'unpaid', 'free_week', 'comped_week']
const PAYMENT_TYPES: PaymentType[] = ['ACH', 'Zelle', 'Check', 'Cash', 'Money Order', 'Card']
const BILLING_FREQUENCIES: BillingFrequency[] = ['weekly', 'bi-weekly', 'monthly']

const FREQUENCY_LABELS: Record<BillingFrequency, string> = {
  'weekly': 'Weekly',
  'bi-weekly': 'Bi-Weekly',
  'monthly': 'Monthly',
}

export default function WeeklyReport() {
  const currentWeek = getCurrentRentWeek()
  const [weekLabel, setWeekLabel] = useState(currentWeek.weekLabel)
  const [entries, setEntries] = useState<TenantWeekEntry[]>(() => generateWeekEntries(TENANTS))
  const [editingCell, setEditingCell] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [showManualEntry, setShowManualEntry] = useState(false)
  const [importResult, setImportResult] = useState<CSVMatchResult | null>(null)
  const [csvText, setCsvText] = useState<string | null>(null)
  const [availableDueDates, setAvailableDueDates] = useState<string[]>([])
  const [showDatePicker, setShowDatePicker] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Update a single entry
  const updateEntry = useCallback((tenantId: string, updates: Partial<TenantWeekEntry>) => {
    setEntries(prev => prev.map(e => {
      if (e.tenant.id !== tenantId) return e
      const updated = { ...e, ...updates }

      // Auto-compute status from amount
      if ('amountPaid' in updates && updates.amountPaid !== undefined) {
        const paid = updates.amountPaid
        if (paid >= e.amountDue) {
          updated.status = 'paid'
        } else if (paid > 0) {
          updated.status = 'partial'
        }
      }

      // Clear payment info for special statuses
      if (updates.status === 'free_week' || updates.status === 'comped_week') {
        updated.amountPaid = 0
        updated.paymentType = undefined
        updated.checkNumber = undefined
        updated.confirmation = undefined
      }

      return updated
    }))
  }, [])

  // Update tenant billing frequency
  const updateFrequency = useCallback((tenantId: string, frequency: BillingFrequency) => {
    setEntries(prev => prev.map(e => {
      if (e.tenant.id !== tenantId) return e
      const updatedTenant = { ...e.tenant, billingFrequency: frequency }
      let status = e.status

      // If changing to monthly and currently unpaid, set to monthly_pending
      if (frequency === 'monthly' && e.status === 'unpaid') {
        status = 'monthly_pending'
      } else if (frequency === 'weekly' && e.status === 'monthly_pending') {
        status = 'unpaid'
      }

      return { ...e, tenant: updatedTenant, status }
    }))
  }, [])

  // Stats
  const stats = useMemo(() => {
    const active = entries.filter(e => !e.isVacant)
    const weeklyDue = active
      .filter(e => !['free_week', 'comped_week', 'monthly_pending', 'biweekly_off'].includes(e.status))
      .reduce((sum, e) => sum + e.amountDue, 0)
    const totalPaid = active.reduce((sum, e) => sum + e.amountPaid, 0)

    return {
      totalDue: weeklyDue,
      totalPaid,
      outstanding: weeklyDue - totalPaid,
      collectionRate: weeklyDue > 0 ? ((totalPaid / weeklyDue) * 100).toFixed(1) : '0.0',
      paid: active.filter(e => e.status === 'paid').length,
      late: active.filter(e => e.status === 'late').length,
      partial: active.filter(e => e.status === 'partial').length,
      unpaid: active.filter(e => e.status === 'unpaid').length,
      freeWeek: active.filter(e => e.status === 'free_week').length,
      compedWeek: active.filter(e => e.status === 'comped_week').length,
      monthlyPending: active.filter(e => e.status === 'monthly_pending').length,
      biweeklyOff: active.filter(e => e.status === 'biweekly_off').length,
      vacant: entries.filter(e => e.isVacant).length,
    }
  }, [entries])

  // Handle CSV file selection — Step 1: read file and show date picker
  const handleCSVFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      setCsvText(text)
      try {
        const dates = extractDueDates(text)
        setAvailableDueDates(dates)
        if (dates.length > 1) {
          // Multiple due dates found — show picker
          setShowDatePicker(true)
        } else {
          // Single date or no date column — import directly
          runCSVImport(text, dates[0] || undefined)
        }
      } catch (err) {
        alert('Error reading CSV: ' + (err as Error).message)
      }
    }
    reader.readAsText(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  // Handle CSV import — Step 2: run import with selected due date
  const runCSVImport = useCallback((text: string, selectedDueDate?: string) => {
    try {
      const result = parseAndMatchCSV(text, TENANTS, selectedDueDate)
      setImportResult(result)
      setShowDatePicker(false)
      setCsvText(null)

      // Auto-apply matched payments
      setEntries(prev => {
        const updated = [...prev]
        for (const match of result.matched) {
          const idx = updated.findIndex(e => e.tenant.id === match.tenant.id)
          if (idx !== -1) {
            updated[idx] = {
              ...updated[idx],
              amountPaid: match.amount,
              paymentType: match.paymentType,
              status: match.amount >= updated[idx].amountDue ? 'paid' : 'partial',
              confirmation: match.paymentType === 'ACH' || match.paymentType === 'Card' ? 'Card Processed' : undefined,
            }
          }
        }
        return updated
      })
    } catch (err) {
      alert('Error parsing CSV: ' + (err as Error).message)
    }
  }, [])

  // Generate PDF
  const handleExportPDF = useCallback(() => {
    const doc = generateWeeklyPDF({
      weekLabel,
      entries,
      totalDue: stats.totalDue,
      totalPaid: stats.totalPaid,
    })
    doc.save(`Salon_Boutique_Report_${currentWeek.weekStart}.pdf`)
  }, [weekLabel, entries, stats, currentWeek])

  // Manual entry quick-add
  const [manualForm, setManualForm] = useState({
    tenantId: '',
    amount: '',
    paymentType: 'Zelle' as PaymentType,
    checkNumber: '',
    notes: '',
  })

  const handleManualAdd = useCallback(() => {
    if (!manualForm.tenantId || !manualForm.amount) return

    const amount = parseFloat(manualForm.amount)
    if (isNaN(amount) || amount <= 0) return

    const confirmation =
      manualForm.paymentType === 'Zelle' || manualForm.paymentType === 'Cash' || manualForm.paymentType === 'Check' || manualForm.paymentType === 'Money Order'
        ? 'Cash'
        : 'Card Processed'

    updateEntry(manualForm.tenantId, {
      amountPaid: amount,
      paymentType: manualForm.paymentType,
      status: amount >= (entries.find(e => e.tenant.id === manualForm.tenantId)?.amountDue || 0) ? 'paid' : 'partial',
      checkNumber: manualForm.checkNumber || undefined,
      notes: manualForm.notes || undefined,
      confirmation,
    })

    setManualForm({ tenantId: '', amount: '', paymentType: 'Zelle', checkNumber: '', notes: '' })
    setShowManualEntry(false)
  }, [manualForm, entries, updateEntry])

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-30">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-gray-900 tracking-tight">Salon Boutique</h1>
            <p className="text-xs text-gray-500">Weekly Rent Report</p>
          </div>
          <div className="flex items-center gap-2">
            <button className="p-1.5 text-gray-400 hover:text-gray-600 rounded">
              <ChevronLeft size={18} />
            </button>
            <span className="text-sm font-semibold text-gray-800 bg-gray-100 px-3 py-1.5 rounded-lg">
              {weekLabel}
            </span>
            <button className="p-1.5 text-gray-400 hover:text-gray-600 rounded">
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx"
              onChange={handleCSVFileSelect}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 flex items-center gap-1.5"
            >
              <Upload size={14} /> Import CSV
            </button>
            <button
              onClick={() => setShowManualEntry(true)}
              className="px-3 py-1.5 bg-white text-gray-700 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center gap-1.5"
            >
              <Plus size={14} /> Manual Entry
            </button>
            <button
              onClick={handleExportPDF}
              className="px-3 py-1.5 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 flex items-center gap-1.5"
            >
              <FileDown size={14} /> Export PDF
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto px-4 py-4">
        {/* Stats Cards */}
        <div className="grid grid-cols-4 lg:grid-cols-9 gap-2 mb-4">
          <StatCard label="Paid" value={stats.paid} icon={<Check size={14} />} color="green" />
          <StatCard label="Late" value={stats.late} icon={<AlertCircle size={14} />} color="red" />
          <StatCard label="Partial" value={stats.partial} icon={<Clock size={14} />} color="yellow" />
          <StatCard label="Unpaid" value={stats.unpaid} icon={<AlertCircle size={14} />} color="gray" />
          <StatCard label="Free Week" value={stats.freeWeek} icon={<Gift size={14} />} color="indigo" />
          <StatCard label="Comped" value={stats.compedWeek} icon={<Heart size={14} />} color="pink" />
          <StatCard label="Monthly" value={stats.monthlyPending} icon={<Calendar size={14} />} color="purple" />
          <StatCard label="Bi-Weekly" value={stats.biweeklyOff} icon={<Repeat size={14} />} color="blue" />
          <StatCard label="Vacant" value={stats.vacant} icon={<AlertCircle size={14} />} color="stone" />
        </div>

        {/* Collection Summary */}
        <div className="bg-white rounded-lg border border-gray-200 p-3 mb-4 flex items-center gap-6">
          <SummaryItem label="Due" value={formatCurrency(stats.totalDue)} />
          <SummaryItem label="Collected" value={formatCurrency(stats.totalPaid)} valueColor="text-green-700" />
          <SummaryItem label="Outstanding" value={formatCurrency(stats.outstanding)} valueColor="text-red-600" />
          <SummaryItem label="Rate" value={`${stats.collectionRate}%`} />
          <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
            <div
              className="bg-green-500 h-full rounded-full transition-all duration-500"
              style={{ width: `${Math.min(parseFloat(stats.collectionRate), 100)}%` }}
            />
          </div>
        </div>

        {/* Import Results Banner */}
        {importResult && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 flex items-center justify-between">
            <div className="text-sm text-blue-800">
              <strong>CSV Import:</strong> {importResult.matched.length} matched
              {importResult.matched.some((m: any) => m.matchMethod === 'suite') &&
                ` (${importResult.matched.filter((m: any) => m.matchMethod === 'suite').length} by suite #)`
              },{' '}
              {importResult.unmatched.length} unmatched,{' '}
              {importResult.skipped.length} skipped
            </div>
            <button
              onClick={() => setImportResult(null)}
              className="text-blue-600 hover:text-blue-800 text-sm font-medium"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Main Table */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <Th className="w-16">Suite</Th>
                  <Th>Tenant Name</Th>
                  <Th className="w-24">Frequency</Th>
                  <Th className="w-24 text-right">Rent Due</Th>
                  <Th className="w-24 text-right">Rent Paid</Th>
                  <Th className="w-24">Pay Type</Th>
                  <Th className="w-28">Status</Th>
                  <Th className="w-20">Confirm</Th>
                  <Th className="w-14 text-center">Chk #</Th>
                  <Th>Notes</Th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <EntryRow
                    key={entry.tenant.id}
                    entry={entry}
                    onUpdate={updateEntry}
                    onFrequencyChange={updateFrequency}
                    isEditing={editingCell === entry.tenant.id}
                    onStartEdit={() => setEditingCell(entry.tenant.id)}
                    onStopEdit={() => setEditingCell(null)}
                  />
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 border-t-2 border-gray-300">
                  <td colSpan={3} className="px-3 py-2 text-sm font-bold text-gray-700 text-right">
                    Totals:
                  </td>
                  <td className="px-3 py-2 text-sm font-bold text-gray-900 text-right font-mono">
                    {formatCurrency(stats.totalDue)}
                  </td>
                  <td className="px-3 py-2 text-sm font-bold text-green-700 text-right font-mono">
                    {formatCurrency(stats.totalPaid)}
                  </td>
                  <td colSpan={5}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* Legend */}
        <div className="mt-3 bg-white rounded-lg border border-gray-200 p-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Billing Frequency</p>
          <div className="flex flex-wrap gap-4 text-xs text-gray-600">
            <span><strong className="text-gray-800">Weekly</strong> — Due every Friday</span>
            <span><strong className="text-blue-700">Bi-Weekly</strong> — Alternating Fridays, "Off Week" on skipped weeks</span>
            <span><strong className="text-purple-700">Monthly</strong> — Pays once/month (52-week annual split), shows "Monthly" until paid</span>
            <span><strong className="text-indigo-700">Free Week</strong> — Annual lease perk</span>
            <span><strong className="text-pink-700">Comped Week</strong> — Emergency/maintenance credit</span>
          </div>
        </div>
      </div>

      {/* Due Date Picker Modal */}
      {showDatePicker && csvText && (
        <Modal onClose={() => { setShowDatePicker(false); setCsvText(null) }} title="Select Rent Week">
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              This CSV contains payments for multiple due dates. Which Friday are you importing for?
            </p>
            <div className="space-y-2">
              {availableDueDates.map(date => (
                <button
                  key={date}
                  onClick={() => runCSVImport(csvText, date)}
                  className="w-full text-left px-4 py-3 border border-gray-200 rounded-lg hover:bg-blue-50 hover:border-blue-300 transition-colors flex items-center justify-between"
                >
                  <span className="text-sm font-medium text-gray-900">{date}</span>
                  <span className="text-xs text-gray-500">Select</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => runCSVImport(csvText, undefined)}
              className="w-full text-center px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
            >
              Import all dates
            </button>
          </div>
        </Modal>
      )}

      {/* Manual Entry Modal */}
      {showManualEntry && (
        <Modal onClose={() => setShowManualEntry(false)} title="Add Manual Payment">
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tenant</label>
              <select
                value={manualForm.tenantId}
                onChange={e => setManualForm(f => ({ ...f, tenantId: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">Select tenant...</option>
                {entries.filter(e => !e.isVacant).map(e => (
                  <option key={e.tenant.id} value={e.tenant.id}>
                    {e.tenant.suiteNumber} — {e.tenant.name} ({formatCurrency(e.tenant.weeklyRent)})
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount</label>
                <input
                  type="number"
                  step="0.01"
                  value={manualForm.amount}
                  onChange={e => setManualForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder="0.00"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payment Type</label>
                <select
                  value={manualForm.paymentType}
                  onChange={e => setManualForm(f => ({ ...f, paymentType: e.target.value as PaymentType }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {PAYMENT_TYPES.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            </div>
            {manualForm.paymentType === 'Check' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Check Number</label>
                <input
                  type="text"
                  value={manualForm.checkNumber}
                  onChange={e => setManualForm(f => ({ ...f, checkNumber: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
              <input
                type="text"
                value={manualForm.notes}
                onChange={e => setManualForm(f => ({ ...f, notes: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={handleManualAdd}
                disabled={!manualForm.tenantId || !manualForm.amount}
                className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Add Payment
              </button>
              <button
                onClick={() => setShowManualEntry(false)}
                className="px-4 py-2 text-gray-600 text-sm hover:text-gray-800"
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---- Sub-components ----

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={cn('px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider', className)}>
      {children}
    </th>
  )
}

function EntryRow({
  entry,
  onUpdate,
  onFrequencyChange,
  isEditing,
  onStartEdit,
  onStopEdit,
}: {
  entry: TenantWeekEntry
  onUpdate: (id: string, updates: Partial<TenantWeekEntry>) => void
  onFrequencyChange: (id: string, freq: BillingFrequency) => void
  isEditing: boolean
  onStartEdit: () => void
  onStopEdit: () => void
}) {
  const { tenant, status, isVacant } = entry
  const isSpecial = status === 'free_week' || status === 'comped_week'
  const isPending = status === 'monthly_pending' || status === 'biweekly_off'

  const rowBg = isVacant
    ? 'bg-gray-50/70'
    : status === 'late'
      ? 'bg-red-50/30'
      : isSpecial
        ? 'bg-indigo-50/20'
        : isPending
          ? 'bg-purple-50/10'
          : ''

  return (
    <tr className={cn('border-b border-gray-100 hover:bg-gray-50/50 transition-colors', rowBg)}>
      {/* Suite */}
      <td className="px-3 py-1.5 text-sm font-mono text-gray-500">{tenant.suiteNumber}</td>

      {/* Name + frequency badge */}
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className={cn('text-sm', isVacant ? 'text-gray-400 italic' : 'text-gray-900 font-medium')}>
            {isVacant ? 'Vacant' : tenant.name}
          </span>
          {!isVacant && tenant.billingFrequency !== 'weekly' && (
            <span className={cn(
              'text-[10px] font-semibold px-1.5 py-0.5 rounded border',
              tenant.billingFrequency === 'bi-weekly'
                ? 'bg-blue-50 text-blue-600 border-blue-200'
                : 'bg-purple-50 text-purple-600 border-purple-200'
            )}>
              {isPending
                ? status === 'monthly_pending' ? 'MONTHLY · Pending' : 'BI-WEEKLY · Off'
                : tenant.billingFrequency === 'bi-weekly' ? 'BI-WEEKLY' : 'MONTHLY'}
            </span>
          )}
        </div>
      </td>

      {/* Frequency dropdown */}
      <td className="px-3 py-1.5">
        {!isVacant && (
          <select
            value={tenant.billingFrequency}
            onChange={e => onFrequencyChange(tenant.id, e.target.value as BillingFrequency)}
            className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-400"
          >
            {BILLING_FREQUENCIES.map(f => (
              <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
            ))}
          </select>
        )}
      </td>

      {/* Rent Due */}
      <td className="px-3 py-1.5 text-sm text-right font-mono">
        {isVacant ? <span className="text-gray-300">—</span> : <span className="text-gray-700">{formatCurrency(entry.amountDue)}</span>}
      </td>

      {/* Rent Paid */}
      <td className="px-3 py-1.5 text-sm text-right font-mono">
        {isVacant ? (
          <span className="text-gray-300">—</span>
        ) : isSpecial || isPending ? (
          <span className="text-gray-400 text-xs italic">{isSpecial ? 'N/A' : '—'}</span>
        ) : isEditing ? (
          <input
            type="number"
            step="0.01"
            defaultValue={entry.amountPaid || ''}
            onBlur={e => {
              const val = parseFloat(e.target.value) || 0
              onUpdate(tenant.id, { amountPaid: val })
              onStopEdit()
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            autoFocus
            className="w-20 text-right text-sm border border-blue-300 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        ) : (
          <span
            className={cn('cursor-pointer hover:bg-blue-50 px-1 rounded', entry.amountPaid > 0 ? 'text-green-700' : 'text-gray-400')}
            onClick={onStartEdit}
          >
            {entry.amountPaid > 0 ? formatCurrency(entry.amountPaid) : '$0.00'}
          </span>
        )}
      </td>

      {/* Payment Type */}
      <td className="px-3 py-1.5">
        {!isVacant && !isSpecial && !isPending && (
          <select
            value={entry.paymentType || ''}
            onChange={e => onUpdate(tenant.id, { paymentType: e.target.value as PaymentType })}
            className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-400"
          >
            <option value="">Select</option>
            {PAYMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </td>

      {/* Status */}
      <td className="px-3 py-1.5">
        {isVacant ? (
          <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-gray-100 text-gray-400 border-gray-200">
            VACANT
          </span>
        ) : (
          <select
            value={status}
            onChange={e => onUpdate(tenant.id, { status: e.target.value as WeekStatus })}
            className={cn(
              'text-xs font-medium border rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400 cursor-pointer',
              getStatusColor(status)
            )}
          >
            {[...WEEK_STATUSES, 'monthly_pending' as WeekStatus, 'biweekly_off' as WeekStatus].map(s => (
              <option key={s} value={s}>{getStatusLabel(s)}</option>
            ))}
          </select>
        )}
      </td>

      {/* Confirmation */}
      <td className="px-3 py-1.5 text-[11px] text-gray-500">
        {!isVacant && entry.amountPaid > 0 && (entry.confirmation || '')}
      </td>

      {/* Check # */}
      <td className="px-3 py-1.5 text-xs font-mono text-gray-500 text-center">
        {entry.checkNumber || ''}
      </td>

      {/* Notes */}
      <td className="px-3 py-1.5">
        <input
          type="text"
          value={entry.notes || ''}
          onChange={e => onUpdate(tenant.id, { notes: e.target.value })}
          className="w-full text-xs border-0 border-b border-transparent hover:border-gray-200 focus:border-blue-300 bg-transparent px-1 py-0.5 focus:outline-none text-gray-600"
        />
      </td>
    </tr>
  )
}

function StatCard({ label, value, icon, color }: { label: string; value: number; icon: React.ReactNode; color: string }) {
  const colorMap: Record<string, string> = {
    green: 'bg-green-50 text-green-700 border-green-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    yellow: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    gray: 'bg-gray-100 text-gray-500 border-gray-200',
    indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    pink: 'bg-pink-50 text-pink-700 border-pink-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    stone: 'bg-stone-50 text-stone-500 border-stone-200',
  }
  return (
    <div className={cn('rounded-lg border px-2.5 py-1.5 flex items-center gap-2', colorMap[color])}>
      {icon}
      <div>
        <div className="text-lg font-bold leading-tight">{value}</div>
        <div className="text-[10px] font-medium uppercase tracking-wider opacity-75">{label}</div>
      </div>
    </div>
  )
}

function SummaryItem({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={cn('text-lg font-bold font-mono', valueColor || 'text-gray-900')}>{value}</div>
    </div>
  )
}

function Modal({ onClose, title, children }: { onClose: () => void; title: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 mb-3">{title}</h3>
        {children}
      </div>
    </div>
  )
}
