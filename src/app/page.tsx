'use client'

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import {
  Upload, Plus, FileDown, ChevronLeft, ChevronRight,
  Check, AlertCircle, Clock, Gift, Heart, Calendar, Repeat,
  MessageSquare, Phone, Send, Loader2, StickyNote, X, BarChart3,
  TrendingUp, CreditCard, RefreshCw, Mail, CheckCircle2, Camera, Image
} from 'lucide-react'
import { TenantWeekEntry, WeekStatus, PaymentType, BillingFrequency } from '@/types'
import { TENANTS } from '@/lib/tenant-data'
import {
  formatCurrency, getStatusLabel, getStatusColor, cn,
  getCurrentMonthKey, monthLabel, addMonths, fridayShortLabel, fridayFullLabel,
  getFridaysInMonth
} from '@/lib/utils'
import { generateWeeklyPDF } from '@/lib/pdf-generator'
import { parseAndMatchCSV, CSVMatchResult } from '@/lib/csv-parser'
import { buildReminderMessage, formatPhoneForSMS } from '@/lib/sms'
import {
  MonthData, MonthTenantEntry, createEmptyMonth, mergeCSVIntoMonth,
  saveMonthData, loadMonthData, calculateMonthlySummary,
  matchZellePayments, applyZelleMatchesToMonth, ZelleMatch
} from '@/lib/month-data'
import { CheckScanResult } from '@/lib/check-scanner'

const WEEK_STATUSES: WeekStatus[] = ['paid', 'partial', 'late', 'unpaid', 'free_week', 'comped_week']
const PAYMENT_TYPES: PaymentType[] = ['ACH', 'Zelle', 'Check', 'Cash', 'Money Order', 'Card']
const BILLING_FREQUENCIES: BillingFrequency[] = ['weekly', 'bi-weekly', 'monthly']

const FREQUENCY_LABELS: Record<BillingFrequency, string> = {
  'weekly': 'Weekly',
  'bi-weekly': 'Bi-Weekly',
  'monthly': 'Monthly',
}

type ActiveTab = string | 'monthly-summary'

export default function RentTracker() {
  const [monthKey, setMonthKey] = useState<string>(() => getCurrentMonthKey())
  const [monthData, setMonthData] = useState<MonthData>(() => createEmptyMonth(monthKey, TENANTS))
  const [activeTab, setActiveTab] = useState<ActiveTab>('')
  const [editingCell, setEditingCell] = useState<string | null>(null)
  const [showManualEntry, setShowManualEntry] = useState(false)
  const [importResult, setImportResult] = useState<CSVMatchResult | null>(null)
  const [showSMSPreview, setShowSMSPreview] = useState(false)
  const [smsLoading, setSmsLoading] = useState(false)
  const [smsResults, setSmsResults] = useState<Array<{ tenantName: string; suiteNumber: string; success: boolean; error?: string }> | null>(null)
  const [smsSentThisWeek, setSmsSentThisWeek] = useState<Set<string>>(new Set())

  // Gmail / Zelle state
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null)
  const [showZelleModal, setShowZelleModal] = useState(false)
  const [zelleLoading, setZelleLoading] = useState(false)
  const [zelleMatches, setZelleMatches] = useState<ZelleMatch[] | null>(null)
  const [zelleError, setZelleError] = useState<string | null>(null)

  // Check scanning state
  const [showCheckModal, setShowCheckModal] = useState(false)
  const [checkScanning, setCheckScanning] = useState(false)
  const [checkResults, setCheckResults] = useState<CheckScanResult[] | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  // Editable overrides for each scanned check (user corrections)
  const [checkEdits, setCheckEdits] = useState<Record<number, { suiteNumber?: string; amount?: string; checkNumber?: string; fridayKey?: string }>>({})

  const fileInputRef = useRef<HTMLInputElement>(null)
  const checkInputRef = useRef<HTMLInputElement>(null)

  // Load month data from localStorage when month changes
  useEffect(() => {
    const loaded = loadMonthData(monthKey)
    const data = loaded || createEmptyMonth(monthKey, TENANTS)
    setMonthData(data)

    // Default to first week tab
    const firstFriday = Object.keys(data.weeks).sort()[0]
    setActiveTab(firstFriday || '')
    setSmsSentThisWeek(new Set())
  }, [monthKey])

  // Auto-save to localStorage on any change
  useEffect(() => {
    if (monthData.monthKey === monthKey && Object.keys(monthData.weeks).length > 0) {
      saveMonthData(monthData)
    }
  }, [monthData, monthKey])

  // Check Gmail connection status on mount + after OAuth redirect
  useEffect(() => {
    fetch('/api/auth/google/status')
      .then(r => r.json())
      .then(d => setGmailConnected(!!d.connected))
      .catch(() => setGmailConnected(false))

    // Show success/error from OAuth redirect
    const url = new URL(window.location.href)
    const authStatus = url.searchParams.get('gmail_auth')
    if (authStatus === 'success') {
      setGmailConnected(true)
      // Clean the URL
      url.searchParams.delete('gmail_auth')
      window.history.replaceState({}, '', url.pathname)
    } else if (authStatus === 'error') {
      const reason = url.searchParams.get('reason') || 'unknown'
      setZelleError(`Gmail connection failed: ${reason}`)
      url.searchParams.delete('gmail_auth')
      url.searchParams.delete('reason')
      window.history.replaceState({}, '', url.pathname)
    }
  }, [])

  // Scan Gmail for Zelle payments covering the current month
  const handleScanZelle = useCallback(async () => {
    setZelleLoading(true)
    setZelleError(null)
    setZelleMatches(null)

    try {
      const fridays = getFridaysInMonth(monthKey)
      if (fridays.length === 0) {
        setZelleError('No Fridays found in selected month')
        setZelleLoading(false)
        return
      }

      // Scan from 6 days before the first Friday (to catch the Saturday prior)
      // through the last Friday of the month
      const firstFriday = new Date(fridays[0] + 'T00:00:00')
      const lastFriday = new Date(fridays[fridays.length - 1] + 'T00:00:00')
      const startDate = new Date(firstFriday)
      startDate.setDate(startDate.getDate() - 6)

      const toISO = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

      const response = await fetch('/api/zelle/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: toISO(startDate),
          endDate: toISO(lastFriday),
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        if (response.status === 401) {
          setZelleError('Gmail is not connected. Click "Connect Gmail" first.')
          setGmailConnected(false)
        } else {
          const debugStr = data.debug ? `\n\nDebug: ${JSON.stringify(data.debug)}` : ''
          setZelleError((data.error || 'Failed to scan Gmail') + debugStr)
        }
        setZelleLoading(false)
        return
      }

      // Show debug info if 0 results
      if (data.payments?.length === 0 && data.debug) {
        setZelleError(`Debug info: ${JSON.stringify(data.debug)}`)
      }

      // Match senders to tenants
      const matches = matchZellePayments(data.payments, TENANTS)
      setZelleMatches(matches)
    } catch (err) {
      setZelleError('Error scanning Gmail: ' + (err as Error).message)
    } finally {
      setZelleLoading(false)
    }
  }, [monthKey])

  // Apply approved Zelle matches to the month
  const handleApplyZelleMatches = useCallback(() => {
    if (!zelleMatches) return
    const approved = zelleMatches.filter(m => m.tenant !== null)
    setMonthData(prev => applyZelleMatchesToMonth(prev, approved))
    setZelleMatches(null)
    setShowZelleModal(false)
  }, [zelleMatches])

  // Manually assign a tenant to a Zelle payment that didn't auto-match
  const handleAssignZelleTenant = useCallback((messageId: string, tenantId: string) => {
    setZelleMatches(prev => {
      if (!prev) return prev
      return prev.map(m => {
        if (m.payment.messageId !== messageId) return m
        const tenant = TENANTS.find(t => t.id === tenantId) || null
        return { ...m, tenant, matchMethod: tenant ? 'exact' : 'none', confidence: tenant ? 1.0 : 0 }
      })
    })
  }, [])

  const handleDisconnectGmail = useCallback(async () => {
    await fetch('/api/auth/google/logout', { method: 'POST' })
    setGmailConnected(false)
  }, [])

  // ---- Check image scanning ----
  const handleCheckImageSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    setCheckScanning(true)
    setCheckError(null)
    setCheckResults(null)
    setCheckEdits({})
    setShowCheckModal(true)

    try {
      // Convert files to base64
      const images: Array<{ base64: string; mimeType: string; fileName: string }> = []

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result as string
            // Strip data:image/xxx;base64, prefix
            resolve(result.split(',')[1])
          }
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
        images.push({
          base64,
          mimeType: file.type || 'image/jpeg',
          fileName: file.name,
        })
      }

      const response = await fetch('/api/checks/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
      })

      const data = await response.json()

      if (!response.ok) {
        setCheckError(data.error || 'Failed to scan checks')
        setCheckScanning(false)
        return
      }

      setCheckResults(data.results)
    } catch (err) {
      setCheckError('Error scanning checks: ' + (err as Error).message)
    } finally {
      setCheckScanning(false)
      // Reset file input
      if (checkInputRef.current) checkInputRef.current.value = ''
    }
  }, [])

  // Apply scanned/edited check data to the month
  const handleApplyChecks = useCallback(() => {
    if (!checkResults) return
    const fridays = Object.keys(monthData.weeks).sort()

    setMonthData(prev => {
      const newWeeks = { ...prev.weeks }

      for (const result of checkResults) {
        const edits = checkEdits[result.imageIndex] || {}
        const suiteNum = edits.suiteNumber ?? result.scanned.suiteNumber
        const amountStr = edits.amount ?? (result.scanned.amount != null ? String(result.scanned.amount) : '')
        const checkNum = edits.checkNumber ?? result.scanned.checkNumber
        const fridayKey = edits.fridayKey || activeTab

        if (!suiteNum || !amountStr || fridayKey === 'monthly-summary') continue
        const amount = parseFloat(amountStr)
        if (isNaN(amount) || amount <= 0) continue

        // Find tenant by suite number
        const tenant = TENANTS.find(t =>
          t.suiteNumber === suiteNum ||
          t.suiteNumber.includes(suiteNum) ||
          suiteNum.includes(t.suiteNumber)
        )
        if (!tenant) continue

        // Apply to the selected week
        const targetFriday = fridayKey && fridays.includes(fridayKey) ? fridayKey : fridays[0]
        if (!newWeeks[targetFriday]) continue

        const entries = [...newWeeks[targetFriday]]
        const idx = entries.findIndex(e => e.tenant.id === tenant.id)
        if (idx === -1) continue

        entries[idx] = {
          ...entries[idx],
          amountPaid: amount,
          paymentType: 'Check',
          status: amount >= entries[idx].amountDue ? 'paid' : 'partial',
          checkNumber: checkNum || undefined,
          confirmation: 'Check',
          paymentSource: 'manual',
        }
        newWeeks[targetFriday] = entries
      }

      return { ...prev, weeks: newWeeks }
    })

    setShowCheckModal(false)
    setCheckResults(null)
    setCheckEdits({})
  }, [checkResults, checkEdits, monthData, activeTab])

  // Update an edit override for a scanned check
  const updateCheckEdit = useCallback((index: number, field: string, value: string) => {
    setCheckEdits(prev => ({
      ...prev,
      [index]: { ...prev[index], [field]: value },
    }))
  }, [])

  const currentWeekEntries: MonthTenantEntry[] = useMemo(() => {
    if (activeTab === 'monthly-summary' || !activeTab) return []
    const entries = monthData.weeks[activeTab] || []

    // Auto-mark unpaid entries as "late" if the current date is past the week's Friday
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const [y, m, d] = activeTab.split('-').map(Number)
    const friday = new Date(y, m - 1, d)
    friday.setHours(0, 0, 0, 0)

    if (today > friday) {
      return entries.map(e => {
        if (e.status === 'unpaid' && !e.isVacant) {
          return { ...e, status: 'late' as WeekStatus }
        }
        return e
      })
    }
    return entries
  }, [monthData, activeTab])

  // Update a single entry in the active week
  const updateEntry = useCallback((tenantId: string, updates: Partial<TenantWeekEntry>, markManual = false) => {
    if (activeTab === 'monthly-summary' || !activeTab) return
    setMonthData(prev => {
      const entries = prev.weeks[activeTab] || []
      const newEntries = entries.map(e => {
        if (e.tenant.id !== tenantId) return e
        const updated: MonthTenantEntry = { ...e, ...updates }

        if ('amountPaid' in updates && updates.amountPaid !== undefined) {
          const paid = updates.amountPaid
          if (paid >= e.amountDue) {
            updated.status = 'paid'
          } else if (paid > 0) {
            updated.status = 'partial'
          }
          if (markManual) {
            updated.paymentSource = 'manual'
          }
        }

        if (updates.status === 'free_week' || updates.status === 'comped_week') {
          updated.amountPaid = 0
          updated.paymentType = undefined
          updated.checkNumber = undefined
          updated.confirmation = undefined
        }

        return updated
      })
      return { ...prev, weeks: { ...prev.weeks, [activeTab]: newEntries } }
    })
  }, [activeTab])

  const updateFrequency = useCallback((tenantId: string, frequency: BillingFrequency) => {
    if (activeTab === 'monthly-summary' || !activeTab) return
    setMonthData(prev => {
      const entries = prev.weeks[activeTab] || []
      const newEntries = entries.map(e => {
        if (e.tenant.id !== tenantId) return e
        const updatedTenant = { ...e.tenant, billingFrequency: frequency }
        let status = e.status
        if (frequency === 'monthly' && e.status === 'unpaid') status = 'monthly_pending'
        else if (frequency === 'weekly' && e.status === 'monthly_pending') status = 'unpaid'
        return { ...e, tenant: updatedTenant, status }
      })
      return { ...prev, weeks: { ...prev.weeks, [activeTab]: newEntries } }
    })
  }, [activeTab])

  const updatePhone = useCallback((tenantId: string, phone: string) => {
    // Apply to ALL weeks in current month so phone is consistent
    setMonthData(prev => {
      const newWeeks: Record<string, MonthTenantEntry[]> = {}
      for (const [friday, entries] of Object.entries(prev.weeks)) {
        newWeeks[friday] = entries.map(e =>
          e.tenant.id === tenantId
            ? { ...e, tenant: { ...e.tenant, phone } }
            : e
        )
      }
      return { ...prev, weeks: newWeeks }
    })
  }, [])

  // Stats for the current week
  const stats = useMemo(() => {
    const entries = currentWeekEntries
    const active = entries.filter(e => !e.isVacant)
    const weeklyDue = active
      .filter(e => !['free_week', 'comped_week', 'biweekly_off'].includes(e.status))
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
  }, [currentWeekEntries])

  // CSV upload — parses whole month at once
  const handleCSVFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      try {
        const result = parseAndMatchCSV(text, TENANTS)
        setImportResult(result)

        // If the CSV contains months we don't have, still apply to current month's weeks
        // If it contains a different month, offer to switch? For now, apply to current month.
        setMonthData(prev => mergeCSVIntoMonth(prev, result.matched, TENANTS))
      } catch (err) {
        alert('Error parsing CSV: ' + (err as Error).message)
      }
    }
    reader.readAsText(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  // PDF export — uses current active week
  const handleExportPDF = useCallback(() => {
    if (activeTab === 'monthly-summary' || !activeTab) return
    const weekLabel = fridayFullLabel(activeTab)
    const doc = generateWeeklyPDF({
      weekLabel,
      entries: currentWeekEntries,
      totalDue: stats.totalDue,
      totalPaid: stats.totalPaid,
    })
    doc.save(`Salon_Boutique_${activeTab}.pdf`)
  }, [activeTab, currentWeekEntries, stats])

  // Manual entry
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
      ['Zelle', 'Cash', 'Check', 'Money Order'].includes(manualForm.paymentType) ? 'Cash' : 'Card Processed'

    const entry = currentWeekEntries.find(e => e.tenant.id === manualForm.tenantId)
    updateEntry(manualForm.tenantId, {
      amountPaid: amount,
      paymentType: manualForm.paymentType,
      status: amount >= (entry?.amountDue || 0) ? 'paid' : 'partial',
      checkNumber: manualForm.checkNumber || undefined,
      notes: manualForm.notes || undefined,
      confirmation,
    }, true) // markManual = true

    setManualForm({ tenantId: '', amount: '', paymentType: 'Zelle', checkNumber: '', notes: '' })
    setShowManualEntry(false)
  }, [manualForm, currentWeekEntries, updateEntry])

  // SMS reminders
  const getLateTenants = useCallback(() => {
    return currentWeekEntries.filter(e =>
      !e.isVacant &&
      (e.status === 'unpaid' || e.status === 'late') &&
      e.tenant.billingFrequency === 'weekly' &&
      e.tenant.phone &&
      e.tenant.phone.trim() !== '' &&
      formatPhoneForSMS(e.tenant.phone) !== null &&
      !smsSentThisWeek.has(e.tenant.id)
    )
  }, [currentWeekEntries, smsSentThisWeek])

  const handleSendReminders = useCallback(async () => {
    const lateTenants = getLateTenants()
    if (lateTenants.length === 0) return

    setSmsLoading(true)
    setSmsResults(null)

    try {
      const response = await fetch('/api/send-reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenants: lateTenants.map(e => ({
            tenantName: e.tenant.name,
            suiteNumber: e.tenant.suiteNumber,
            phone: e.tenant.phone,
          }))
        })
      })

      const data = await response.json()

      if (!response.ok) {
        alert(data.error || 'Failed to send reminders')
        setSmsLoading(false)
        return
      }

      setSmsResults(data.results)
      const sentIds = new Set(smsSentThisWeek)
      for (const result of data.results) {
        if (result.success) {
          const entry = lateTenants.find(e => e.tenant.suiteNumber === result.suiteNumber)
          if (entry) sentIds.add(entry.tenant.id)
        }
      }
      setSmsSentThisWeek(sentIds)
    } catch (err) {
      alert('Error sending reminders: ' + (err as Error).message)
    } finally {
      setSmsLoading(false)
    }
  }, [getLateTenants, smsSentThisWeek])

  const sortedFridays = useMemo(() => Object.keys(monthData.weeks).sort(), [monthData.weeks])
  const isMonthlySummaryTab = activeTab === 'monthly-summary'

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-30">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-gray-900 tracking-tight">Salon Boutique</h1>
            <p className="text-xs text-gray-500">Monthly Rent Tracker</p>
          </div>

          {/* Month selector */}
          <div className="flex items-center gap-2">
            <button onClick={() => setMonthKey(addMonths(monthKey, -1))} className="p-1.5 text-gray-400 hover:text-gray-600 rounded">
              <ChevronLeft size={18} />
            </button>
            <span className="text-sm font-semibold text-gray-800 bg-gray-100 px-3 py-1.5 rounded-lg">
              {monthLabel(monthKey)}
            </span>
            <button onClick={() => setMonthKey(addMonths(monthKey, 1))} className="p-1.5 text-gray-400 hover:text-gray-600 rounded">
              <ChevronRight size={18} />
            </button>
          </div>

          {/* Action buttons */}
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
              title="Upload monthly TenantCloud CSV — auto-distributes payments across weeks"
            >
              {monthData.lastCSVUpload ? <RefreshCw size={14} /> : <Upload size={14} />}
              {monthData.lastCSVUpload ? 'Refresh CSV' : 'Import CSV'}
            </button>

            {/* Gmail / Zelle button */}
            {gmailConnected ? (
              <button
                onClick={() => { setShowZelleModal(true); setZelleMatches(null); setZelleError(null) }}
                className="px-3 py-1.5 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 flex items-center gap-1.5"
                title="Scan Gmail for Chase Zelle notifications"
              >
                <Mail size={14} /> Scan Zelle
              </button>
            ) : (
              <a
                href="/api/auth/google"
                className="px-3 py-1.5 bg-white text-gray-700 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center gap-1.5"
                title="Connect your Gmail to scan for Chase Zelle notifications"
              >
                <Mail size={14} /> Connect Gmail
              </a>
            )}
            {/* Check scanning */}
            <input
              ref={checkInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleCheckImageSelect}
              className="hidden"
            />
            <button
              onClick={() => checkInputRef.current?.click()}
              className="px-3 py-1.5 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 flex items-center gap-1.5"
              title="Upload photos of check deposit slips to scan"
            >
              <Camera size={14} /> Scan Checks
            </button>
            {!isMonthlySummaryTab && (
              <>
                <button
                  onClick={() => setShowManualEntry(true)}
                  className="px-3 py-1.5 bg-white text-gray-700 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center gap-1.5"
                >
                  <Plus size={14} /> Manual
                </button>
                <button
                  onClick={() => setShowSMSPreview(true)}
                  className="px-3 py-1.5 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600 flex items-center gap-1.5"
                >
                  <MessageSquare size={14} /> Late Reminders
                </button>
                <button
                  onClick={handleExportPDF}
                  className="px-3 py-1.5 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 flex items-center gap-1.5"
                >
                  <FileDown size={14} /> PDF
                </button>
              </>
            )}
          </div>
        </div>

        {/* Week tabs */}
        <div className="max-w-[1400px] mx-auto px-4 border-t border-gray-100">
          <div className="flex items-center gap-1 overflow-x-auto">
            {sortedFridays.map((friday, idx) => (
              <button
                key={friday}
                onClick={() => setActiveTab(friday)}
                className={cn(
                  'px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                  activeTab === friday
                    ? 'border-blue-600 text-blue-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                )}
              >
                Week {idx + 1} <span className="text-xs text-gray-400 ml-1">{fridayShortLabel(friday)}</span>
              </button>
            ))}
            <button
              onClick={() => setActiveTab('monthly-summary')}
              className={cn(
                'px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 ml-2',
                activeTab === 'monthly-summary'
                  ? 'border-purple-600 text-purple-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              )}
            >
              <BarChart3 size={14} /> Monthly Summary
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto px-4 py-4">
        {isMonthlySummaryTab ? (
          <MonthlySummaryView monthData={monthData} />
        ) : (
          <>
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
                  <strong>CSV Applied:</strong> {importResult.matched.length} payments matched across{' '}
                  {new Set(importResult.matched.map(m => m.dueDate)).size} week(s)
                  {importResult.unmatched.length > 0 && <>, {importResult.unmatched.length} unmatched</>}
                </div>
                <button onClick={() => setImportResult(null)} className="text-blue-600 hover:text-blue-800 text-sm font-medium">Dismiss</button>
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
                      <Th className="w-20 text-center">Chk #</Th>
                      <Th className="w-28">Phone</Th>
                      <Th>Notes</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentWeekEntries.map(entry => (
                      <EntryRow
                        key={entry.tenant.id}
                        entry={entry}
                        onUpdate={updateEntry}
                        onFrequencyChange={updateFrequency}
                        onPhoneChange={updatePhone}
                        isEditing={editingCell === entry.tenant.id}
                        onStartEdit={() => setEditingCell(entry.tenant.id)}
                        onStopEdit={() => setEditingCell(null)}
                      />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-50 border-t-2 border-gray-300">
                      <td colSpan={3} className="px-3 py-2 text-sm font-bold text-gray-700 text-right">Totals:</td>
                      <td className="px-3 py-2 text-sm font-bold text-gray-900 text-right font-mono">{formatCurrency(stats.totalDue)}</td>
                      <td className="px-3 py-2 text-sm font-bold text-green-700 text-right font-mono">{formatCurrency(stats.totalPaid)}</td>
                      <td colSpan={6}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Manual Entry Modal */}
      {showManualEntry && (
        <Modal onClose={() => setShowManualEntry(false)} title={`Add Manual Payment — ${fridayFullLabel(activeTab as string)}`}>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tenant</label>
              <select
                value={manualForm.tenantId}
                onChange={e => setManualForm(f => ({ ...f, tenantId: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">Select tenant...</option>
                {currentWeekEntries.filter(e => !e.isVacant).map(e => (
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
                  type="number" step="0.01"
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
                  {PAYMENT_TYPES.map(t => (<option key={t} value={t}>{t}</option>))}
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
              <button onClick={() => setShowManualEntry(false)} className="px-4 py-2 text-gray-600 text-sm hover:text-gray-800">Cancel</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Zelle (Gmail) Scan Modal */}
      {showZelleModal && (
        <Modal
          onClose={() => { setShowZelleModal(false); setZelleMatches(null); setZelleError(null) }}
          title={`Import Zelle from Gmail — ${monthLabel(monthKey)}`}
        >
          <div className="space-y-4">
            {/* Gmail connection banner */}
            <div className="flex items-center justify-between bg-violet-50 border border-violet-200 rounded-lg px-3 py-2">
              <div className="flex items-center gap-2 text-sm text-violet-800">
                <CheckCircle2 size={14} className="text-violet-600" />
                Gmail connected
              </div>
              <button onClick={handleDisconnectGmail} className="text-xs text-violet-600 hover:text-violet-800 underline">
                Disconnect
              </button>
            </div>

            {zelleError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
                {zelleError}
              </div>
            )}

            {/* Initial state: scan button */}
            {!zelleMatches && (
              <div className="text-center py-6 space-y-3">
                <p className="text-sm text-gray-600">
                  Scan your Gmail for Chase Zelle notifications received during {monthLabel(monthKey)}. This will only read Chase Zelle emails.
                </p>
                <button
                  onClick={handleScanZelle}
                  disabled={zelleLoading}
                  className="px-5 py-2 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 disabled:opacity-50 flex items-center gap-2 mx-auto"
                >
                  {zelleLoading ? (<><Loader2 size={14} className="animate-spin" /> Scanning Gmail...</>) : (<><Mail size={14} /> Scan Now</>)}
                </button>
              </div>
            )}

            {/* Results */}
            {zelleMatches && (
              <div className="space-y-3">
                <div className="text-sm text-gray-700">
                  Found <strong>{zelleMatches.length}</strong> Zelle payment{zelleMatches.length !== 1 ? 's' : ''} in Gmail.
                  {zelleMatches.filter(m => m.tenant).length > 0 && (
                    <> <strong className="text-green-700">{zelleMatches.filter(m => m.tenant).length}</strong> auto-matched to tenants.</>
                  )}
                </div>

                <div className="max-h-80 overflow-y-auto space-y-2">
                  {zelleMatches.map((match, i) => {
                    const friday = match.payment.assignedFriday
                    const isUnmatched = !match.tenant
                    return (
                      <div
                        key={match.payment.messageId}
                        className={cn(
                          'border rounded-lg px-3 py-2 text-sm',
                          isUnmatched ? 'bg-yellow-50 border-yellow-200' : 'bg-green-50 border-green-200'
                        )}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="font-medium text-gray-900">
                            {match.payment.senderName} — {formatCurrency(match.payment.amount)}
                          </div>
                          <div className="text-xs text-gray-500">
                            {match.payment.dateReceived} → Week of {fridayShortLabel(friday)}
                          </div>
                        </div>
                        {match.payment.memo && (
                          <div className="text-xs text-gray-500 italic mb-1">Memo: {match.payment.memo}</div>
                        )}
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-600">Apply to:</span>
                          <select
                            value={match.tenant?.id || ''}
                            onChange={e => handleAssignZelleTenant(match.payment.messageId, e.target.value)}
                            className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 bg-white"
                          >
                            <option value="">— Skip this payment —</option>
                            {TENANTS.filter(t => t.isActive).map(t => (
                              <option key={t.id} value={t.id}>
                                {t.suiteNumber} — {t.name}
                              </option>
                            ))}
                          </select>
                          {match.matchMethod === 'fuzzy' && (
                            <span className="text-[10px] text-yellow-700 bg-yellow-100 px-1.5 py-0.5 rounded">
                              {Math.round(match.confidence * 100)}%
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={handleApplyZelleMatches}
                    disabled={zelleMatches.filter(m => m.tenant).length === 0}
                    className="flex-1 px-4 py-2 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Apply {zelleMatches.filter(m => m.tenant).length} Payment{zelleMatches.filter(m => m.tenant).length !== 1 ? 's' : ''}
                  </button>
                  <button onClick={() => setZelleMatches(null)} className="px-4 py-2 text-gray-600 text-sm hover:text-gray-800">
                    Re-scan
                  </button>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* SMS Late Reminder Modal */}
      {showSMSPreview && (
        <Modal onClose={() => { setShowSMSPreview(false); setSmsResults(null) }} title="Send Late Rent Reminders">
          <div className="space-y-4">
            {smsResults ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
                  <Check size={16} className="text-green-600" />
                  {smsResults.filter(r => r.success).length} sent, {smsResults.filter(r => !r.success).length} failed
                </div>
                <div className="max-h-60 overflow-y-auto space-y-1">
                  {smsResults.map((r, i) => (
                    <div key={i} className={cn('text-xs px-3 py-2 rounded flex items-center justify-between', r.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800')}>
                      <span>{r.suiteNumber} — {r.tenantName}</span>
                      <span>{r.success ? 'Sent' : r.error || 'Failed'}</span>
                    </div>
                  ))}
                </div>
                <button onClick={() => { setShowSMSPreview(false); setSmsResults(null) }} className="w-full px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200">Done</button>
              </div>
            ) : (
              <>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Message Preview</p>
                  <p className="text-sm text-gray-800 italic">&ldquo;{buildReminderMessage('Tenant Name')}&rdquo;</p>
                </div>
                {(() => {
                  const lateTenants = getLateTenants()
                  return (
                    <div className="space-y-3">
                      {lateTenants.length > 0 ? (
                        <div>
                          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Will receive text ({lateTenants.length})</p>
                          <div className="max-h-40 overflow-y-auto space-y-1">
                            {lateTenants.map(e => (
                              <div key={e.tenant.id} className="text-xs bg-orange-50 text-orange-800 px-3 py-2 rounded flex items-center justify-between">
                                <span className="font-medium">{e.tenant.suiteNumber} — {e.tenant.name}</span>
                                <span className="text-orange-500 flex items-center gap-1"><Phone size={10} /> {e.tenant.phone}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="text-sm text-gray-500 text-center py-4">No late tenants with phone numbers to text.</div>
                      )}
                      <div className="flex gap-2 pt-2">
                        <button
                          onClick={handleSendReminders}
                          disabled={lateTenants.length === 0 || smsLoading}
                          className="flex-1 px-4 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                          {smsLoading ? (<><Loader2 size={14} className="animate-spin" /> Sending...</>) : (<><Send size={14} /> Send {lateTenants.length} Reminder{lateTenants.length !== 1 ? 's' : ''}</>)}
                        </button>
                        <button onClick={() => setShowSMSPreview(false)} className="px-4 py-2 text-gray-600 text-sm hover:text-gray-800">Cancel</button>
                      </div>
                    </div>
                  )
                })()}
              </>
            )}
          </div>
        </Modal>
      )}
      {/* Check Scan Modal */}
      {showCheckModal && (
        <Modal
          onClose={() => { setShowCheckModal(false); setCheckResults(null); setCheckError(null); setCheckEdits({}) }}
          title="Scan Check Deposit Slips"
        >
          <div className="space-y-4">
            {checkError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
                {checkError}
              </div>
            )}

            {/* Scanning in progress */}
            {checkScanning && (
              <div className="text-center py-8 space-y-3">
                <Loader2 size={28} className="animate-spin mx-auto text-amber-600" />
                <p className="text-sm text-gray-600">Reading handwriting from check images...</p>
                <p className="text-xs text-gray-400">This may take a few seconds per image</p>
              </div>
            )}

            {/* Results */}
            {checkResults && !checkScanning && (
              <div className="space-y-3">
                <div className="text-sm text-gray-700">
                  Scanned <strong>{checkResults.length}</strong> check image{checkResults.length !== 1 ? 's' : ''}.
                  {' '}<strong className="text-green-700">
                    {checkResults.filter(r => r.scanned.suiteNumber && r.scanned.amount).length}
                  </strong> successfully read.
                </div>

                <div className="max-h-[400px] overflow-y-auto space-y-3">
                  {checkResults.map((result, i) => {
                    const edits = checkEdits[i] || {}
                    const suite = edits.suiteNumber ?? result.scanned.suiteNumber ?? ''
                    const amount = edits.amount ?? (result.scanned.amount != null ? String(result.scanned.amount) : '')
                    const checkNum = edits.checkNumber ?? result.scanned.checkNumber ?? ''
                    const fridayKey = edits.fridayKey || (activeTab !== 'monthly-summary' ? activeTab : '')
                    const sortedFri = Object.keys(monthData.weeks).sort()

                    // Find matching tenant for preview
                    const matchedTenant = TENANTS.find(t =>
                      t.suiteNumber === suite ||
                      t.suiteNumber.includes(suite) ||
                      (suite && suite.includes(t.suiteNumber))
                    )

                    const confidence = result.scanned.confidence
                    const hasSuite = !!suite
                    const hasAmount = !!amount && parseFloat(amount) > 0

                    return (
                      <div
                        key={i}
                        className={cn(
                          'border rounded-lg px-3 py-3 text-sm',
                          result.error ? 'bg-red-50 border-red-200' :
                          confidence === 'high' && hasSuite && hasAmount ? 'bg-green-50 border-green-200' :
                          confidence === 'low' || !hasSuite || !hasAmount ? 'bg-yellow-50 border-yellow-200' :
                          'bg-blue-50 border-blue-200'
                        )}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Image size={14} className="text-gray-400" />
                            <span className="font-medium text-gray-700 text-xs">{result.fileName}</span>
                          </div>
                          <span className={cn(
                            'text-[10px] px-1.5 py-0.5 rounded font-medium',
                            confidence === 'high' ? 'bg-green-100 text-green-700' :
                            confidence === 'medium' ? 'bg-blue-100 text-blue-700' :
                            'bg-yellow-100 text-yellow-700'
                          )}>
                            {confidence} confidence
                          </span>
                        </div>

                        {result.error ? (
                          <p className="text-xs text-red-600">Error: {result.error}</p>
                        ) : (
                          <div className="grid grid-cols-4 gap-2">
                            <div>
                              <label className="block text-[10px] font-medium text-gray-500 uppercase mb-0.5">Suite #</label>
                              <input
                                type="text"
                                value={suite}
                                onChange={e => updateCheckEdit(i, 'suiteNumber', e.target.value)}
                                className={cn(
                                  'w-full border rounded px-2 py-1 text-sm',
                                  matchedTenant ? 'border-green-300 bg-green-50' : suite ? 'border-yellow-300 bg-yellow-50' : 'border-gray-300'
                                )}
                                placeholder="e.g. 110"
                              />
                              {matchedTenant && (
                                <p className="text-[10px] text-green-700 mt-0.5 truncate">{matchedTenant.name}</p>
                              )}
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium text-gray-500 uppercase mb-0.5">Amount</label>
                              <input
                                type="text"
                                value={amount}
                                onChange={e => updateCheckEdit(i, 'amount', e.target.value)}
                                className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                                placeholder="e.g. 220"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium text-gray-500 uppercase mb-0.5">Check #</label>
                              <input
                                type="text"
                                value={checkNum}
                                onChange={e => updateCheckEdit(i, 'checkNumber', e.target.value)}
                                className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                                placeholder="e.g. 1234"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium text-gray-500 uppercase mb-0.5">Week</label>
                              <select
                                value={fridayKey}
                                onChange={e => updateCheckEdit(i, 'fridayKey', e.target.value)}
                                className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                              >
                                {sortedFri.map((f, wi) => (
                                  <option key={f} value={f}>Week {wi + 1} ({fridayShortLabel(f)})</option>
                                ))}
                              </select>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={handleApplyChecks}
                    disabled={!checkResults.some((r, i) => {
                      const edits = checkEdits[i] || {}
                      const suite = edits.suiteNumber ?? r.scanned.suiteNumber
                      const amount = edits.amount ?? (r.scanned.amount != null ? String(r.scanned.amount) : '')
                      return suite && amount && parseFloat(amount) > 0
                    })}
                    className="flex-1 px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Apply {checkResults.filter((r, i) => {
                      const edits = checkEdits[i] || {}
                      const suite = edits.suiteNumber ?? r.scanned.suiteNumber
                      const amount = edits.amount ?? (r.scanned.amount != null ? String(r.scanned.amount) : '')
                      return suite && amount && parseFloat(amount) > 0
                    }).length} Check{checkResults.length !== 1 ? 's' : ''}
                  </button>
                  <button
                    onClick={() => checkInputRef.current?.click()}
                    className="px-4 py-2 text-gray-600 text-sm hover:text-gray-800"
                  >
                    Upload More
                  </button>
                </div>
              </div>
            )}

            {/* Empty state — not scanning, no results */}
            {!checkScanning && !checkResults && !checkError && (
              <div className="text-center py-8 space-y-3">
                <Camera size={32} className="mx-auto text-gray-300" />
                <p className="text-sm text-gray-600">Upload photos of the backs of check deposit slips.</p>
                <p className="text-xs text-gray-400">Claude AI will read the handwriting and extract suite number, amount, and check number.</p>
                <button
                  onClick={() => checkInputRef.current?.click()}
                  className="px-5 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 flex items-center gap-2 mx-auto"
                >
                  <Upload size={14} /> Select Images
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---- Monthly Summary View ----

function MonthlySummaryView({ monthData }: { monthData: MonthData }) {
  const summary = useMemo(() => calculateMonthlySummary(monthData), [monthData])

  return (
    <div className="space-y-4">
      {/* Top stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <BigStatCard label="Expected" value={formatCurrency(summary.totalExpected)} icon={<TrendingUp size={18} />} color="blue" />
        <BigStatCard label="Collected" value={formatCurrency(summary.totalCollected)} icon={<Check size={18} />} color="green" />
        <BigStatCard label="Outstanding" value={formatCurrency(summary.outstanding)} icon={<AlertCircle size={18} />} color="red" />
        <BigStatCard label="Collection Rate" value={`${summary.collectionRate.toFixed(1)}%`} icon={<BarChart3 size={18} />} color="purple" />
      </div>

      {/* Week-by-week breakdown */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <Calendar size={16} /> Week-by-Week Performance
        </h3>
        <div className="space-y-2">
          {summary.weekBreakdown.map((wk, i) => (
            <div key={wk.friday} className="flex items-center gap-3 text-sm">
              <div className="w-24 text-gray-700 font-medium">Week {i + 1} <span className="text-xs text-gray-400">{fridayShortLabel(wk.friday)}</span></div>
              <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden relative">
                <div
                  className={cn('h-full rounded-full transition-all', wk.rate >= 90 ? 'bg-green-500' : wk.rate >= 70 ? 'bg-yellow-500' : 'bg-red-400')}
                  style={{ width: `${Math.min(wk.rate, 100)}%` }}
                />
                <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-gray-800">
                  {wk.rate.toFixed(0)}% · {formatCurrency(wk.collected)} / {formatCurrency(wk.expected)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Chronic late / unpaid */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <AlertCircle size={16} className="text-red-500" /> Problem Tenants
          </h3>
          {summary.repeatUnpaid.length === 0 && summary.chronicLate.length === 0 ? (
            <p className="text-sm text-gray-500 italic">No late or unpaid tenants this month 🎉</p>
          ) : (
            <div className="space-y-1.5">
              {summary.repeatUnpaid.map(item => (
                <div key={'u-' + item.tenant.id} className="flex items-center justify-between text-sm px-3 py-2 bg-red-50 rounded">
                  <span className="text-gray-800 font-medium">{item.tenant.suiteNumber} — {item.tenant.name}</span>
                  <span className="text-red-700 text-xs font-semibold">{item.weeksUnpaid} week{item.weeksUnpaid !== 1 ? 's' : ''} unpaid</span>
                </div>
              ))}
              {summary.chronicLate.map(item => (
                <div key={'l-' + item.tenant.id} className="flex items-center justify-between text-sm px-3 py-2 bg-yellow-50 rounded">
                  <span className="text-gray-800 font-medium">{item.tenant.suiteNumber} — {item.tenant.name}</span>
                  <span className="text-yellow-700 text-xs font-semibold">{item.weeksLate} week{item.weeksLate !== 1 ? 's' : ''} late</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Payment method breakdown */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <CreditCard size={16} className="text-blue-500" /> Payment Methods
          </h3>
          {Object.keys(summary.paymentMethodBreakdown).length === 0 ? (
            <p className="text-sm text-gray-500 italic">No payments recorded yet</p>
          ) : (
            <div className="space-y-1.5">
              {Object.entries(summary.paymentMethodBreakdown)
                .sort((a, b) => b[1].total - a[1].total)
                .map(([method, data]) => (
                  <div key={method} className="flex items-center justify-between text-sm px-3 py-2 bg-gray-50 rounded">
                    <span className="text-gray-800 font-medium">{method}</span>
                    <span className="text-gray-600 text-xs">
                      {data.count} payment{data.count !== 1 ? 's' : ''} · <span className="font-semibold text-gray-900">{formatCurrency(data.total)}</span>
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>

      {/* Free / Comped weeks */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 flex items-center gap-3">
          <Gift size={20} className="text-indigo-600" />
          <div>
            <div className="text-2xl font-bold text-indigo-900">{summary.freeWeeksUsed}</div>
            <div className="text-xs text-indigo-700 uppercase tracking-wider font-medium">Free Weeks Used</div>
          </div>
        </div>
        <div className="bg-pink-50 border border-pink-200 rounded-lg p-3 flex items-center gap-3">
          <Heart size={20} className="text-pink-600" />
          <div>
            <div className="text-2xl font-bold text-pink-900">{summary.compedWeeksGiven}</div>
            <div className="text-xs text-pink-700 uppercase tracking-wider font-medium">Comped Weeks Given</div>
          </div>
        </div>
      </div>

      <div className="text-xs text-gray-400 text-center pt-2 space-y-0.5">
        {monthData.lastCSVUpload && (
          <p>Last CSV upload: {new Date(monthData.lastCSVUpload).toLocaleString()}</p>
        )}
        {monthData.lastGmailScan && (
          <p>Last Gmail Zelle scan: {new Date(monthData.lastGmailScan).toLocaleString()}</p>
        )}
      </div>
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
  onPhoneChange,
  isEditing,
  onStartEdit,
  onStopEdit,
}: {
  entry: MonthTenantEntry
  onUpdate: (id: string, updates: Partial<TenantWeekEntry>, markManual?: boolean) => void
  onFrequencyChange: (id: string, freq: BillingFrequency) => void
  onPhoneChange: (id: string, phone: string) => void
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
      <td className="px-3 py-1.5 text-sm font-mono text-gray-500">{tenant.suiteNumber}</td>

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

      <td className="px-3 py-1.5">
        {!isVacant && (
          <select
            value={tenant.billingFrequency}
            onChange={e => onFrequencyChange(tenant.id, e.target.value as BillingFrequency)}
            className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-400"
          >
            {BILLING_FREQUENCIES.map(f => (<option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>))}
          </select>
        )}
      </td>

      <td className="px-3 py-1.5 text-sm text-right font-mono">
        {isVacant ? <span className="text-gray-300">—</span> : <span className="text-gray-700">{formatCurrency(entry.amountDue)}</span>}
      </td>

      <td className="px-3 py-1.5 text-sm text-right font-mono">
        {isVacant ? (
          <span className="text-gray-300">—</span>
        ) : isSpecial || isPending ? (
          <span className="text-gray-400 text-xs italic">{isSpecial ? 'N/A' : '—'}</span>
        ) : isEditing ? (
          <input
            type="number" step="0.01"
            defaultValue={entry.amountPaid || ''}
            onBlur={e => {
              const val = parseFloat(e.target.value) || 0
              onUpdate(tenant.id, { amountPaid: val }, true)
              onStopEdit()
            }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
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

      <td className="px-3 py-1.5">
        {isVacant ? (
          <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-gray-100 text-gray-400 border-gray-200">VACANT</span>
        ) : (
          <select
            value={status}
            onChange={e => onUpdate(tenant.id, { status: e.target.value as WeekStatus })}
            className={cn('text-xs font-medium border rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400 cursor-pointer', getStatusColor(status))}
          >
            {[...WEEK_STATUSES, 'monthly_pending' as WeekStatus, 'biweekly_off' as WeekStatus].map(s => (
              <option key={s} value={s}>{getStatusLabel(s)}</option>
            ))}
          </select>
        )}
      </td>

      <td className="px-3 py-1.5 text-[11px] text-gray-500">
        {!isVacant && entry.amountPaid > 0 && (entry.confirmation || '')}
      </td>

      <td className="px-3 py-1.5">
        {!isVacant && !isSpecial && !isPending && (
          <input
            type="text"
            value={entry.checkNumber || ''}
            onChange={e => onUpdate(tenant.id, { checkNumber: e.target.value })}
            placeholder="—"
            className="w-full text-xs font-mono text-center border-0 border-b border-transparent hover:border-gray-200 focus:border-blue-300 bg-transparent px-1 py-0.5 focus:outline-none text-gray-600"
          />
        )}
      </td>

      <td className="px-3 py-1.5">
        {!isVacant && (
          <input
            type="tel"
            value={tenant.phone || ''}
            onChange={e => onPhoneChange(tenant.id, e.target.value)}
            placeholder="(555) 123-4567"
            className="w-full text-xs border-0 border-b border-transparent hover:border-gray-200 focus:border-blue-300 bg-transparent px-1 py-0.5 focus:outline-none text-gray-600"
          />
        )}
      </td>

      <td className="px-3 py-1.5">
        <NotesCell
          notes={entry.notes || ''}
          onChange={(val) => onUpdate(tenant.id, { notes: val })}
          isVacant={isVacant || false}
        />
      </td>
    </tr>
  )
}

function NotesCell({ notes, onChange, isVacant }: { notes: string; onChange: (val: string) => void; isVacant: boolean }) {
  const [isOpen, setIsOpen] = useState(false)
  if (isVacant) return null

  if (notes) {
    return (
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={notes}
          onChange={e => onChange(e.target.value)}
          className="flex-1 text-xs border-0 border-b border-gray-200 bg-transparent px-1 py-0.5 focus:outline-none focus:border-blue-300 text-gray-600"
        />
        <button onClick={() => { onChange(''); setIsOpen(false) }} className="text-gray-300 hover:text-red-400 flex-shrink-0" title="Clear notes">
          <X size={12} />
        </button>
      </div>
    )
  }

  if (!isOpen) {
    return (
      <button onClick={() => setIsOpen(true)} className="text-gray-300 hover:text-gray-500 p-0.5" title="Add note">
        <StickyNote size={14} />
      </button>
    )
  }

  return (
    <input
      type="text"
      value={notes}
      onChange={e => onChange(e.target.value)}
      placeholder="Add note..."
      autoFocus
      onBlur={() => { if (!notes) setIsOpen(false) }}
      className="w-full text-xs border-0 border-b border-blue-300 bg-transparent px-1 py-0.5 focus:outline-none text-gray-600"
    />
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

function BigStatCard({ label, value, icon, color }: { label: string; value: string; icon: React.ReactNode; color: string }) {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-900 border-blue-200',
    green: 'bg-green-50 text-green-900 border-green-200',
    red: 'bg-red-50 text-red-900 border-red-200',
    purple: 'bg-purple-50 text-purple-900 border-purple-200',
  }
  const iconColor: Record<string, string> = {
    blue: 'text-blue-500',
    green: 'text-green-500',
    red: 'text-red-500',
    purple: 'text-purple-500',
  }
  return (
    <div className={cn('rounded-lg border p-4 flex items-center gap-3', colorMap[color])}>
      <div className={iconColor[color]}>{icon}</div>
      <div>
        <div className="text-2xl font-bold font-mono">{value}</div>
        <div className="text-xs uppercase tracking-wider font-medium opacity-75">{label}</div>
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
