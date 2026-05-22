'use client'

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import {
  Upload, Plus, FileDown, ChevronLeft, ChevronRight,
  Check, AlertCircle, Clock, Gift, Heart, Calendar, Repeat,
  MessageSquare, Phone, Send, Loader2, StickyNote, X, BarChart3,
  TrendingUp, CreditCard, RefreshCw, Mail, CheckCircle2, Camera, Image,
  Pencil, DoorOpen, UserPlus, ChevronDown, Archive, Wallet
} from 'lucide-react'
import { Tenant, TenantWeekEntry, WeekStatus, PaymentType, BillingFrequency } from '@/types'
import { TENANTS as DEFAULT_TENANTS } from '@/lib/tenant-data'
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
import { DepositSlipResult } from '@/lib/check-scanner'
import {
  loadTenants, saveTenants, createTenant, updateTenant, archiveTenant,
  getActiveTenants, getArchivedTenants, loadCredits, saveCredits, addCredit,
  useCredit, getTenantCredit, TenantFormData
} from '@/lib/tenant-manager'

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
  const [tenants, setTenants] = useState<Tenant[]>(() => loadTenants())
  const [credits, setCredits] = useState<Record<string, number>>(() => loadCredits())
  const [monthData, setMonthData] = useState<MonthData>(() => createEmptyMonth(monthKey, getActiveTenants(loadTenants())))
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
  const [checkResults, setCheckResults] = useState<DepositSlipResult[] | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [checkEdits, setCheckEdits] = useState<Record<string, { suiteNumber?: string; amount?: string; checkNumber?: string; fridayKey?: string; fridayKeys?: string[] }>>({})

  // Tenant management state
  const [showTenantPanel, setShowTenantPanel] = useState(false)
  const [tenantPanelMode, setTenantPanelMode] = useState<'add' | 'edit'>('add')
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null)
  const [tenantPanelSuite, setTenantPanelSuite] = useState('')
  const [showPastTenants, setShowPastTenants] = useState(false)
  const [showMoveOutConfirm, setShowMoveOutConfirm] = useState<string | null>(null)
  const [moveOutDate, setMoveOutDate] = useState('')

  // Credit prompt state
  const [creditPrompt, setCreditPrompt] = useState<{ tenantId: string; creditAmount: number; paymentContext: string } | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const checkInputRef = useRef<HTMLInputElement>(null)

  const activeTenants = useMemo(() => getActiveTenants(tenants), [tenants])
  const archivedTenants = useMemo(() => getArchivedTenants(tenants), [tenants])

  // Load month data from localStorage when month changes
  useEffect(() => {
    const loaded = loadMonthData(monthKey)
    const data = loaded || createEmptyMonth(monthKey, activeTenants)
    setMonthData(data)
    const firstFriday = Object.keys(data.weeks).sort()[0]
    setActiveTab(firstFriday || '')
    setSmsSentThisWeek(new Set())
  }, [monthKey]) // eslint-disable-line react-hooks/exhaustive-deps

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

    const url = new URL(window.location.href)
    const authStatus = url.searchParams.get('gmail_auth')
    if (authStatus === 'success') {
      setGmailConnected(true)
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
          setZelleError(data.error || 'Failed to scan Gmail')
        }
        setZelleLoading(false)
        return
      }

      const matches = matchZellePayments(data.payments, activeTenants)
      setZelleMatches(matches)
    } catch (err) {
      setZelleError('Error scanning Gmail: ' + (err as Error).message)
    } finally {
      setZelleLoading(false)
    }
  }, [monthKey, activeTenants])

  const handleApplyZelleMatches = useCallback(() => {
    if (!zelleMatches) return
    const approved = zelleMatches.filter(m => m.tenant !== null)
    setMonthData(prev => applyZelleMatchesToMonth(prev, approved))
    setZelleMatches(null)
    setShowZelleModal(false)
  }, [zelleMatches])

  const handleAssignZelleTenant = useCallback((messageId: string, tenantId: string) => {
    setZelleMatches(prev => {
      if (!prev) return prev
      return prev.map(m => {
        if (m.payment.messageId !== messageId) return m
        const tenant = activeTenants.find(t => t.id === tenantId) || null
        return { ...m, tenant, matchMethod: tenant ? 'exact' : 'none', confidence: tenant ? 1.0 : 0 }
      })
    })
  }, [activeTenants])

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
      const images: Array<{ base64: string; mimeType: string; fileName: string }> = []

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result as string
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
      if (checkInputRef.current) checkInputRef.current.value = ''
    }
  }, [])

  // Apply scanned/edited check data to the month (supports multi-week payments + credits)
  const handleApplyChecks = useCallback(() => {
    if (!checkResults) return
    const fridays = Object.keys(monthData.weeks).sort()
    let newCredits = { ...credits }

    setMonthData(prev => {
      const newWeeks = { ...prev.weeks }

      for (const result of checkResults) {
        for (let entryIdx = 0; entryIdx < result.entries.length; entryIdx++) {
          const entry = result.entries[entryIdx]
          const editKey = `${result.imageIndex}-${entryIdx}`
          const edits = checkEdits[editKey] || {}

          const suiteNum = edits.suiteNumber ?? entry.suiteNumber
          const amountStr = edits.amount ?? (entry.amount != null ? String(entry.amount) : '')
          const checkNum = edits.checkNumber ?? entry.checkNumber
          const totalAmount = parseFloat(amountStr)

          if (!suiteNum || isNaN(totalAmount) || totalAmount <= 0) continue

          const tenant = activeTenants.find(t =>
            t.suiteNumber === suiteNum ||
            t.suiteNumber.includes(suiteNum) ||
            suiteNum.includes(t.suiteNumber)
          )
          if (!tenant) continue

          const selectedWeeks = edits.fridayKeys && edits.fridayKeys.length > 0
            ? edits.fridayKeys
            : [edits.fridayKey || (activeTab !== 'monthly-summary' ? activeTab : fridays[0])]

          const weeklyRent = tenant.weeklyRent
          let remaining = totalAmount

          for (const targetFriday of selectedWeeks) {
            if (!targetFriday || !newWeeks[targetFriday]) continue

            const entries = [...newWeeks[targetFriday]]
            const idx = entries.findIndex(e => e.tenant.id === tenant.id)
            if (idx === -1) continue

            const applyAmount = Math.min(remaining, weeklyRent)
            remaining -= applyAmount

            entries[idx] = {
              ...entries[idx],
              amountPaid: applyAmount,
              paymentType: 'Check',
              status: applyAmount >= entries[idx].amountDue ? 'paid' : 'partial',
              checkNumber: checkNum || undefined,
              confirmation: 'Check',
              paymentSource: 'manual',
            }
            newWeeks[targetFriday] = entries
          }

          // If there's leftover after applying to all selected weeks, store as credit
          if (remaining > 0.01) {
            newCredits = addCredit(newCredits, tenant.id, remaining)
          }
        }
      }

      return { ...prev, weeks: newWeeks }
    })

    setCredits(newCredits)
    setShowCheckModal(false)
    setCheckResults(null)
    setCheckEdits({})
  }, [checkResults, checkEdits, monthData, activeTab, credits, activeTenants])

  const updateCheckEdit = useCallback((editKey: string, field: string, value: string) => {
    setCheckEdits(prev => ({
      ...prev,
      [editKey]: { ...prev[editKey], [field]: value },
    }))
  }, [])

  const currentWeekEntries: MonthTenantEntry[] = useMemo(() => {
    if (activeTab === 'monthly-summary' || !activeTab) return []
    const entries = monthData.weeks[activeTab] || []

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

  // CSV upload
  const handleCSVFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      try {
        const result = parseAndMatchCSV(text, activeTenants)
        setImportResult(result)
        setMonthData(prev => mergeCSVIntoMonth(prev, result.matched, activeTenants))
      } catch (err) {
        alert('Error parsing CSV: ' + (err as Error).message)
      }
    }
    reader.readAsText(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [activeTenants])

  // PDF export
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
    multiWeekKeys: [] as string[],
  })

  // Multi-week detection for manual entry
  const manualTenant = activeTenants.find(t => t.id === manualForm.tenantId)
  const manualAmount = parseFloat(manualForm.amount) || 0
  const manualIsMultiWeek = manualTenant && manualTenant.weeklyRent > 0 && manualAmount > manualTenant.weeklyRent
  const manualWeeksCount = manualTenant && manualTenant.weeklyRent > 0 ? Math.floor(manualAmount / manualTenant.weeklyRent) : 0
  const manualCreditAmount = manualTenant && manualTenant.weeklyRent > 0 ? manualAmount - (manualWeeksCount * manualTenant.weeklyRent) : 0

  const handleManualAdd = useCallback(() => {
    if (!manualForm.tenantId || !manualForm.amount) return
    const amount = parseFloat(manualForm.amount)
    if (isNaN(amount) || amount <= 0) return

    const confirmation =
      ['Zelle', 'Cash', 'Check', 'Money Order'].includes(manualForm.paymentType) ? 'Cash' : 'Card Processed'

    const tenant = activeTenants.find(t => t.id === manualForm.tenantId)
    const weeklyRent = tenant?.weeklyRent || 0

    // Check for existing credit to prompt
    const existingCredit = getTenantCredit(credits, manualForm.tenantId)
    if (existingCredit > 0 && !creditPrompt) {
      setCreditPrompt({
        tenantId: manualForm.tenantId,
        creditAmount: existingCredit,
        paymentContext: 'manual',
      })
      return
    }

    // Multi-week: apply across selected weeks
    if (manualForm.multiWeekKeys.length > 1 && weeklyRent > 0) {
      const fridays = Object.keys(monthData.weeks).sort()
      let remaining = amount

      setMonthData(prev => {
        const newWeeks = { ...prev.weeks }

        for (const fridayKey of manualForm.multiWeekKeys) {
          if (!newWeeks[fridayKey] || !fridays.includes(fridayKey)) continue
          const entries = [...newWeeks[fridayKey]]
          const idx = entries.findIndex(e => e.tenant.id === manualForm.tenantId)
          if (idx === -1) continue

          const applyAmount = Math.min(remaining, weeklyRent)
          remaining -= applyAmount

          entries[idx] = {
            ...entries[idx],
            amountPaid: applyAmount,
            paymentType: manualForm.paymentType,
            status: applyAmount >= entries[idx].amountDue ? 'paid' : 'partial',
            checkNumber: manualForm.checkNumber || undefined,
            notes: manualForm.notes || undefined,
            confirmation,
            paymentSource: 'manual',
          }
          newWeeks[fridayKey] = entries
        }
        return { ...prev, weeks: newWeeks }
      })

      // Store any leftover as credit
      const totalApplied = manualForm.multiWeekKeys.length * weeklyRent
      const leftover = amount - totalApplied
      if (leftover > 0.01) {
        setCredits(prev => addCredit(prev, manualForm.tenantId, leftover))
      }
    } else {
      // Single-week
      const entry = currentWeekEntries.find(e => e.tenant.id === manualForm.tenantId)
      updateEntry(manualForm.tenantId, {
        amountPaid: amount,
        paymentType: manualForm.paymentType,
        status: amount >= (entry?.amountDue || 0) ? 'paid' : 'partial',
        checkNumber: manualForm.checkNumber || undefined,
        notes: manualForm.notes || undefined,
        confirmation,
      }, true)
    }

    setCreditPrompt(null)
    setManualForm({ tenantId: '', amount: '', paymentType: 'Zelle', checkNumber: '', notes: '', multiWeekKeys: [] })
    setShowManualEntry(false)
  }, [manualForm, currentWeekEntries, updateEntry, monthData, credits, creditPrompt, activeTenants])

  // Apply credit to a payment
  const handleApplyCredit = useCallback((tenantId: string) => {
    const creditAmt = getTenantCredit(credits, tenantId)
    if (creditAmt <= 0) return

    // Apply credit to current week
    if (activeTab && activeTab !== 'monthly-summary') {
      const entry = currentWeekEntries.find(e => e.tenant.id === tenantId)
      if (entry) {
        const owed = entry.amountDue - entry.amountPaid
        const applyAmt = Math.min(creditAmt, owed)
        if (applyAmt > 0) {
          updateEntry(tenantId, {
            amountPaid: entry.amountPaid + applyAmt,
            status: (entry.amountPaid + applyAmt) >= entry.amountDue ? 'paid' : 'partial',
          }, true)
          setCredits(prev => useCredit(prev, tenantId, applyAmt))
        }
      }
    }
    setCreditPrompt(null)
  }, [credits, activeTab, currentWeekEntries, updateEntry])

  // Dismiss credit prompt and proceed without applying
  const handleSkipCredit = useCallback(() => {
    setCreditPrompt(null)
  }, [])

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

  // ---- Tenant Management Handlers ----
  const handleOpenAddTenant = useCallback((suiteNumber: string) => {
    setTenantPanelMode('add')
    setSelectedTenantId(null)
    setTenantPanelSuite(suiteNumber)
    setShowTenantPanel(true)
  }, [])

  const handleOpenEditTenant = useCallback((tenantId: string) => {
    setTenantPanelMode('edit')
    setSelectedTenantId(tenantId)
    const t = tenants.find(x => x.id === tenantId)
    setTenantPanelSuite(t?.suiteNumber || '')
    setShowTenantPanel(true)
  }, [tenants])

  const handleSaveTenant = useCallback((data: TenantFormData) => {
    if (tenantPanelMode === 'add') {
      const updated = createTenant(tenants, data)
      setTenants(updated)
      // Rebuild month data to include new tenant
      const newMonthData = createEmptyMonth(monthKey, getActiveTenants(updated))
      // Merge existing payment data
      const mergedWeeks: Record<string, MonthTenantEntry[]> = {}
      for (const [friday, entries] of Object.entries(newMonthData.weeks)) {
        const existingEntries = monthData.weeks[friday] || []
        mergedWeeks[friday] = entries.map(newEntry => {
          const existing = existingEntries.find(e => e.tenant.id === newEntry.tenant.id)
          return existing || newEntry
        })
      }
      setMonthData(prev => ({ ...prev, weeks: mergedWeeks }))
    } else if (selectedTenantId) {
      const updated = updateTenant(tenants, selectedTenantId, data)
      setTenants(updated)
      // Update tenant data in month entries
      setMonthData(prev => {
        const newWeeks: Record<string, MonthTenantEntry[]> = {}
        for (const [friday, entries] of Object.entries(prev.weeks)) {
          newWeeks[friday] = entries.map(e => {
            if (e.tenant.id !== selectedTenantId) return e
            const updatedTenant = updated.find(t => t.id === selectedTenantId)
            return updatedTenant ? { ...e, tenant: updatedTenant } : e
          })
        }
        return { ...prev, weeks: newWeeks }
      })
    }
    setShowTenantPanel(false)
  }, [tenantPanelMode, selectedTenantId, tenants, monthKey, monthData])

  const handleMoveOutTenant = useCallback((tenantId: string) => {
    if (!moveOutDate) return
    const updated = archiveTenant(tenants, tenantId, moveOutDate)
    setTenants(updated)

    // Update month data: mark the archived tenant's future weeks, add vacant
    setMonthData(prev => {
      const newWeeks: Record<string, MonthTenantEntry[]> = {}
      const archivedT = updated.find(t => t.id === tenantId)
      const vacantT = updated.find(t => t.suiteNumber === archivedT?.suiteNumber && !t.isArchived && !t.isActive)

      for (const [friday, entries] of Object.entries(prev.weeks)) {
        let weekEntries = entries.map(e => {
          if (e.tenant.id === tenantId) {
            // Keep payment data intact for past weeks
            const fridayDate = new Date(friday + 'T00:00:00')
            const moveDate = new Date(moveOutDate + 'T00:00:00')
            if (fridayDate > moveDate) {
              // Future weeks: mark as vacant
              return vacantT ? {
                ...e,
                tenant: vacantT,
                isVacant: true,
                status: 'unpaid' as WeekStatus,
                amountPaid: 0,
                amountDue: 0,
                paymentType: undefined,
                paymentSource: 'none' as const,
              } : e
            }
          }
          return e
        })
        newWeeks[friday] = weekEntries
      }
      return { ...prev, weeks: newWeeks }
    })

    setShowMoveOutConfirm(null)
    setMoveOutDate('')
  }, [tenants, moveOutDate])

  const sortedFridays = useMemo(() => Object.keys(monthData.weeks).sort(), [monthData.weeks])
  const isMonthlySummaryTab = activeTab === 'monthly-summary'

  // Check if all multi-week entries in checks are fully allocated
  const allCheckMultiWeeksAllocated = useMemo(() => {
    if (!checkResults) return true
    for (const result of checkResults) {
      for (let entryIdx = 0; entryIdx < result.entries.length; entryIdx++) {
        const entry = result.entries[entryIdx]
        const editKey = `${result.imageIndex}-${entryIdx}`
        const edits = checkEdits[editKey] || {}
        const suite = edits.suiteNumber ?? entry.suiteNumber
        const amount = edits.amount ?? (entry.amount != null ? String(entry.amount) : '')
        const amountVal = parseFloat(amount) || 0

        if (!suite || amountVal <= 0) continue

        const matchedTenant = activeTenants.find(t =>
          t.suiteNumber === suite ||
          t.suiteNumber.includes(suite) ||
          (suite && suite.includes(t.suiteNumber))
        )
        if (!matchedTenant) continue

        const weeklyRent = matchedTenant.weeklyRent
        if (weeklyRent > 0 && amountVal > weeklyRent) {
          const weeksNeeded = Math.floor(amountVal / weeklyRent)
          const selectedKeys = edits.fridayKeys || []
          if (selectedKeys.length !== weeksNeeded) return false
        }
      }
    }
    return true
  }, [checkResults, checkEdits, activeTenants])

  // Manual entry: check if multi-week is fully allocated
  const manualMultiWeekAllocated = !manualIsMultiWeek || manualForm.multiWeekKeys.length === manualWeeksCount

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
              title="Upload monthly TenantCloud CSV"
            >
              {monthData.lastCSVUpload ? <RefreshCw size={14} /> : <Upload size={14} />}
              {monthData.lastCSVUpload ? 'Refresh CSV' : 'Import CSV'}
            </button>

            {gmailConnected ? (
              <button
                onClick={() => { setShowZelleModal(true); setZelleMatches(null); setZelleError(null) }}
                className="px-3 py-1.5 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 flex items-center gap-1.5"
              >
                <Mail size={14} /> Scan Zelle
              </button>
            ) : (
              <a
                href="/api/auth/google"
                className="px-3 py-1.5 bg-white text-gray-700 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center gap-1.5"
              >
                <Mail size={14} /> Connect Gmail
              </a>
            )}
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
            {archivedTenants.length > 0 && (
              <button
                onClick={() => setShowPastTenants(true)}
                className="px-3 py-1.5 bg-gray-100 text-gray-600 text-sm font-medium rounded-lg border border-gray-200 hover:bg-gray-200 flex items-center gap-1.5"
              >
                <Archive size={14} /> Past Tenants
              </button>
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
                      <Th className="w-16"></Th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentWeekEntries.map(entry => (
                      <EntryRow
                        key={entry.tenant.id}
                        entry={entry}
                        credit={getTenantCredit(credits, entry.tenant.id)}
                        onUpdate={updateEntry}
                        onFrequencyChange={updateFrequency}
                        onPhoneChange={updatePhone}
                        isEditing={editingCell === entry.tenant.id}
                        onStartEdit={() => setEditingCell(entry.tenant.id)}
                        onStopEdit={() => setEditingCell(null)}
                        onAddTenant={handleOpenAddTenant}
                        onEditTenant={handleOpenEditTenant}
                        onMoveOutTenant={(id) => { setShowMoveOutConfirm(id); setMoveOutDate('') }}
                        onApplyCredit={handleApplyCredit}
                      />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-50 border-t-2 border-gray-300">
                      <td colSpan={3} className="px-3 py-2 text-sm font-bold text-gray-700 text-right">Totals:</td>
                      <td className="px-3 py-2 text-sm font-bold text-gray-900 text-right font-mono">{formatCurrency(stats.totalDue)}</td>
                      <td className="px-3 py-2 text-sm font-bold text-green-700 text-right font-mono">{formatCurrency(stats.totalPaid)}</td>
                      <td colSpan={7}></td>
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
        <Modal onClose={() => { setShowManualEntry(false); setCreditPrompt(null) }} title={`Add Manual Payment — ${fridayFullLabel(activeTab as string)}`}>
          <div className="space-y-3">
            {/* Credit prompt */}
            {creditPrompt && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-emerald-800">
                    <Wallet size={14} className="inline mr-1.5 -mt-0.5" />
                    <strong>{formatCurrency(creditPrompt.creditAmount)}</strong> credit on file
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleApplyCredit(creditPrompt.tenantId)}
                      className="px-2.5 py-1 bg-emerald-600 text-white text-xs font-medium rounded hover:bg-emerald-700"
                    >
                      Apply Credit
                    </button>
                    <button
                      onClick={handleSkipCredit}
                      className="px-2.5 py-1 text-emerald-600 text-xs font-medium hover:text-emerald-800"
                    >
                      Skip
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tenant</label>
              <select
                value={manualForm.tenantId}
                onChange={e => { setManualForm(f => ({ ...f, tenantId: e.target.value })); setCreditPrompt(null) }}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">Select tenant...</option>
                {currentWeekEntries.filter(e => !e.isVacant).map(e => (
                  <option key={e.tenant.id} value={e.tenant.id}>
                    {e.tenant.suiteNumber} — {e.tenant.name} ({formatCurrency(e.tenant.weeklyRent)})
                    {getTenantCredit(credits, e.tenant.id) > 0 ? ` [${formatCurrency(getTenantCredit(credits, e.tenant.id))} credit]` : ''}
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
            {/* Multi-week selector for manual entry */}
            {manualIsMultiWeek && (() => {
              const sortedFri = Object.keys(monthData.weeks).sort()
              return (
                <div className="border border-purple-200 bg-purple-50 rounded-lg px-3 py-2">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-purple-700">
                      {formatCurrency(manualAmount)} = {manualWeeksCount} week{manualWeeksCount !== 1 ? 's' : ''} at {formatCurrency(manualTenant!.weeklyRent)}/wk
                      {manualCreditAmount > 0 && (
                        <span className="text-amber-600 ml-1">(+{formatCurrency(manualCreditAmount)} credit)</span>
                      )}
                      {manualCreditAmount === 0 && <span className="text-green-600 ml-1">(no credit)</span>}
                    </span>
                    <span className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded font-medium',
                      manualForm.multiWeekKeys.length === manualWeeksCount ? 'bg-green-100 text-green-700' :
                      manualForm.multiWeekKeys.length > 0 ? 'bg-amber-100 text-amber-700' :
                      'bg-gray-100 text-gray-500'
                    )}>
                      Selected: {manualForm.multiWeekKeys.length} of {manualWeeksCount} weeks
                    </span>
                  </div>
                  <p className="text-[10px] text-purple-600 mb-2">Select which weeks to apply this payment to:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {sortedFri.map((f, wi) => {
                      const isSelected = manualForm.multiWeekKeys.includes(f)
                      return (
                        <button
                          key={f}
                          type="button"
                          onClick={() => {
                            setManualForm(prev => ({
                              ...prev,
                              multiWeekKeys: isSelected
                                ? prev.multiWeekKeys.filter(k => k !== f)
                                : [...prev.multiWeekKeys, f],
                            }))
                          }}
                          className={cn(
                            'px-3 py-1.5 rounded text-xs font-medium border transition-colors',
                            isSelected
                              ? 'bg-purple-600 text-white border-purple-600'
                              : 'bg-white text-gray-600 border-gray-300 hover:border-purple-400'
                          )}
                        >
                          {isSelected && <Check size={10} className="inline mr-1 -mt-0.5" />}
                          Week {wi + 1} ({fridayShortLabel(f)})
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })()}
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
                disabled={!manualForm.tenantId || !manualForm.amount || !manualMultiWeekAllocated}
                className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Add Payment
              </button>
              <button onClick={() => { setShowManualEntry(false); setCreditPrompt(null) }} className="px-4 py-2 text-gray-600 text-sm hover:text-gray-800">Cancel</button>
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

            {!zelleMatches && (
              <div className="text-center py-6 space-y-3">
                <p className="text-sm text-gray-600">
                  Scan your Gmail for Chase Zelle notifications received during {monthLabel(monthKey)}.
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

            {zelleMatches && (
              <div className="space-y-3">
                <div className="text-sm text-gray-700">
                  Found <strong>{zelleMatches.length}</strong> Zelle payment{zelleMatches.length !== 1 ? 's' : ''}.
                  {zelleMatches.filter(m => m.tenant).length > 0 && (
                    <> <strong className="text-green-700">{zelleMatches.filter(m => m.tenant).length}</strong> auto-matched.</>
                  )}
                </div>

                <div className="max-h-80 overflow-y-auto space-y-2">
                  {zelleMatches.map((match) => {
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
                            {activeTenants.filter(t => t.isActive).map(t => (
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
          wide
        >
          <div className="space-y-4">
            {checkError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
                {checkError}
              </div>
            )}

            {checkScanning && (
              <div className="text-center py-8 space-y-3">
                <Loader2 size={28} className="animate-spin mx-auto text-amber-600" />
                <p className="text-sm text-gray-600">Reading handwriting from check images...</p>
                <p className="text-xs text-gray-400">This may take a few seconds per image</p>
              </div>
            )}

            {checkResults && !checkScanning && (() => {
              const totalEntries = checkResults.reduce((sum, r) => sum + r.entries.length, 0)
              const validEntries: Array<{ imageIdx: number; entryIdx: number }> = []
              checkResults.forEach(r => r.entries.forEach((entry, ei) => {
                const editKey = `${r.imageIndex}-${ei}`
                const edits = checkEdits[editKey] || {}
                const suite = edits.suiteNumber ?? entry.suiteNumber
                const amt = edits.amount ?? (entry.amount != null ? String(entry.amount) : '')
                if (suite && amt && parseFloat(amt) > 0) {
                  validEntries.push({ imageIdx: r.imageIndex, entryIdx: ei })
                }
              }))

              return (
              <div className="space-y-3">
                <div className="text-sm text-gray-700">
                  Scanned <strong>{checkResults.length}</strong> deposit slip{checkResults.length !== 1 ? 's' : ''}.
                  {' '}<strong className="text-green-700">{totalEntries}</strong> check entries found.
                </div>

                <div className="max-h-[450px] overflow-y-auto space-y-4">
                  {checkResults.map((result) => (
                    <div key={result.imageIndex} className="space-y-2">
                      <div className="flex items-center gap-2 border-b pb-1">
                        <Image size={14} className="text-gray-400" />
                        <span className="font-medium text-gray-700 text-xs">{result.fileName}</span>
                        <span className="text-[10px] text-gray-400">({result.entries.length} entries)</span>
                      </div>

                      {result.error ? (
                        <p className="text-xs text-red-600 pl-5">Error: {result.error}</p>
                      ) : result.entries.length === 0 ? (
                        <p className="text-xs text-yellow-600 pl-5">No check entries detected in this image.</p>
                      ) : (
                        result.entries.map((entry, entryIdx) => {
                          const editKey = `${result.imageIndex}-${entryIdx}`
                          const edits = checkEdits[editKey] || {}
                          const suite = edits.suiteNumber ?? entry.suiteNumber ?? ''
                          const amount = edits.amount ?? (entry.amount != null ? String(entry.amount) : '')
                          const checkNum = edits.checkNumber ?? entry.checkNumber ?? ''
                          const fridayKey = edits.fridayKey || (activeTab !== 'monthly-summary' ? activeTab : '')
                          const sortedFri = Object.keys(monthData.weeks).sort()

                          const matchedTenant = activeTenants.find(t =>
                            t.suiteNumber === suite ||
                            t.suiteNumber.includes(suite) ||
                            (suite && suite.includes(t.suiteNumber))
                          )

                          const confidence = entry.confidence
                          const hasSuite = !!suite
                          const hasAmount = !!amount && parseFloat(amount) > 0

                          // Multi-week detection
                          const amountVal = parseFloat(amount) || 0
                          const weeklyRent = matchedTenant?.weeklyRent || 0
                          const isMultiWeek = matchedTenant && weeklyRent > 0 && amountVal > weeklyRent
                          const weeksCount = weeklyRent > 0 ? Math.floor(amountVal / weeklyRent) : 0
                          const creditAmount = weeklyRent > 0 ? amountVal - (weeksCount * weeklyRent) : 0
                          const selectedFridayKeys = edits.fridayKeys || []

                          return (
                            <div
                              key={editKey}
                              className={cn(
                                'border rounded-lg px-3 py-2 text-sm ml-2',
                                confidence === 'high' && hasSuite && hasAmount ? 'bg-green-50 border-green-200' :
                                confidence === 'low' || !hasSuite || !hasAmount ? 'bg-yellow-50 border-yellow-200' :
                                'bg-blue-50 border-blue-200'
                              )}
                            >
                              <div className="flex items-center justify-between mb-1.5">
                                <span className="text-[10px] text-gray-500">Entry {entryIdx + 1}</span>
                                <div className="flex items-center gap-2">
                                  {matchedTenant && (
                                    <span className="text-[10px] text-green-700 font-medium">{matchedTenant.name}</span>
                                  )}
                                  <span className={cn(
                                    'text-[10px] px-1.5 py-0.5 rounded font-medium',
                                    confidence === 'high' ? 'bg-green-100 text-green-700' :
                                    confidence === 'medium' ? 'bg-blue-100 text-blue-700' :
                                    'bg-yellow-100 text-yellow-700'
                                  )}>
                                    {confidence}
                                  </span>
                                </div>
                              </div>

                              <div className="grid grid-cols-3 gap-2">
                                <div>
                                  <label className="block text-[10px] font-medium text-gray-500 uppercase mb-0.5">Suite #</label>
                                  <input
                                    type="text"
                                    value={suite}
                                    onChange={e => updateCheckEdit(editKey, 'suiteNumber', e.target.value)}
                                    className={cn(
                                      'w-full border rounded px-2 py-1 text-sm',
                                      matchedTenant ? 'border-green-300 bg-green-50' : suite ? 'border-yellow-300 bg-yellow-50' : 'border-gray-300'
                                    )}
                                    placeholder="e.g. 110"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] font-medium text-gray-500 uppercase mb-0.5">Amount</label>
                                  <input
                                    type="text"
                                    value={amount}
                                    onChange={e => updateCheckEdit(editKey, 'amount', e.target.value)}
                                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                                    placeholder="e.g. 220"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] font-medium text-gray-500 uppercase mb-0.5">Check #</label>
                                  <input
                                    type="text"
                                    value={checkNum}
                                    onChange={e => updateCheckEdit(editKey, 'checkNumber', e.target.value)}
                                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                                    placeholder="e.g. 1234"
                                  />
                                </div>
                              </div>

                              {/* Multi-week selector or single week dropdown */}
                              {isMultiWeek ? (
                                <div className="mt-2 border-t pt-2">
                                  <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[10px] font-semibold text-purple-700 uppercase">
                                      {formatCurrency(amountVal)} = {weeksCount} week{weeksCount !== 1 ? 's' : ''} at {formatCurrency(weeklyRent)}/wk
                                      {creditAmount > 0 && (
                                        <span className="text-amber-600 ml-1">(+{formatCurrency(creditAmount)} credit)</span>
                                      )}
                                      {creditAmount === 0 && <span className="text-green-600 ml-1">(no credit)</span>}
                                    </span>
                                    <span className={cn(
                                      'text-[10px] px-1.5 py-0.5 rounded font-medium',
                                      selectedFridayKeys.length === weeksCount ? 'bg-green-100 text-green-700' :
                                      selectedFridayKeys.length > 0 ? 'bg-amber-100 text-amber-700' :
                                      'bg-gray-100 text-gray-500'
                                    )}>
                                      Selected: {selectedFridayKeys.length} of {weeksCount} weeks
                                    </span>
                                  </div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {sortedFri.map((f, wi) => {
                                      const isSelected = selectedFridayKeys.includes(f)
                                      return (
                                        <button
                                          key={f}
                                          type="button"
                                          onClick={() => {
                                            const current = edits.fridayKeys || []
                                            const updated = isSelected
                                              ? current.filter(k => k !== f)
                                              : [...current, f]
                                            setCheckEdits(prev => ({
                                              ...prev,
                                              [editKey]: { ...prev[editKey], fridayKeys: updated },
                                            }))
                                          }}
                                          className={cn(
                                            'px-2.5 py-1 rounded text-[11px] font-medium border transition-colors',
                                            isSelected
                                              ? 'bg-purple-600 text-white border-purple-600'
                                              : 'bg-white text-gray-600 border-gray-300 hover:border-purple-400'
                                          )}
                                        >
                                          {isSelected && <Check size={10} className="inline mr-1 -mt-0.5" />}
                                          Wk {wi + 1} ({fridayShortLabel(f)})
                                        </button>
                                      )
                                    })}
                                  </div>
                                </div>
                              ) : (
                                <div className="mt-2">
                                  <label className="block text-[10px] font-medium text-gray-500 uppercase mb-0.5">Week</label>
                                  <select
                                    value={fridayKey}
                                    onChange={e => updateCheckEdit(editKey, 'fridayKey', e.target.value)}
                                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                                  >
                                    {sortedFri.map((f, wi) => (
                                      <option key={f} value={f}>Week {wi + 1} ({fridayShortLabel(f)})</option>
                                    ))}
                                  </select>
                                </div>
                              )}
                            </div>
                          )
                        })
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={handleApplyChecks}
                    disabled={validEntries.length === 0 || !allCheckMultiWeeksAllocated}
                    className="flex-1 px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {!allCheckMultiWeeksAllocated
                      ? 'Select weeks for all multi-week entries'
                      : `Apply ${validEntries.length} Check${validEntries.length !== 1 ? 's' : ''}`
                    }
                  </button>
                  <button
                    onClick={() => checkInputRef.current?.click()}
                    className="px-4 py-2 text-gray-600 text-sm hover:text-gray-800"
                  >
                    Upload More
                  </button>
                </div>
              </div>
              )
            })()}

            {!checkScanning && !checkResults && !checkError && (
              <div className="text-center py-8 space-y-3">
                <Camera size={32} className="mx-auto text-gray-300" />
                <p className="text-sm text-gray-600">Upload photos of your check deposit slips.</p>
                <p className="text-xs text-gray-400">Each slip can have multiple checks — all entries will be read automatically.</p>
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

      {/* Move Out Confirmation Modal */}
      {showMoveOutConfirm && (() => {
        const tenant = tenants.find(t => t.id === showMoveOutConfirm)
        if (!tenant) return null
        return (
          <Modal onClose={() => setShowMoveOutConfirm(null)} title={`Move Out — ${tenant.name}`}>
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                This will archive <strong>{tenant.name}</strong> (Suite {tenant.suiteNumber}) and mark the suite as Vacant.
                All past payment records will be preserved for your reports.
              </p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Last Day</label>
                <input
                  type="date"
                  value={moveOutDate}
                  onChange={e => setMoveOutDate(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => handleMoveOutTenant(showMoveOutConfirm)}
                  disabled={!moveOutDate}
                  className="flex-1 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  <DoorOpen size={14} /> Confirm Move Out
                </button>
                <button onClick={() => setShowMoveOutConfirm(null)} className="px-4 py-2 text-gray-600 text-sm hover:text-gray-800">Cancel</button>
              </div>
            </div>
          </Modal>
        )
      })()}

      {/* Past Tenants Modal */}
      {showPastTenants && (
        <Modal onClose={() => setShowPastTenants(false)} title="Past Tenants" wide>
          <div className="space-y-3">
            {archivedTenants.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">No archived tenants yet.</p>
            ) : (
              <div className="max-h-96 overflow-y-auto space-y-2">
                {archivedTenants.map(t => (
                  <div key={t.id} className="border border-gray-200 rounded-lg px-4 py-3 bg-gray-50">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-gray-900">{t.name}</span>
                        <span className="text-xs text-gray-500 ml-2">Suite {t.suiteNumber}</span>
                      </div>
                      <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">
                        Moved out {t.movedOutDate || 'N/A'}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500 flex gap-4">
                      <span>Rent: {formatCurrency(t.weeklyRent)}/{t.billingFrequency}</span>
                      {t.moveInDate && <span>Move-in: {t.moveInDate}</span>}
                      {t.phone && <span>Phone: {t.phone}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => setShowPastTenants(false)} className="w-full px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200">Close</button>
          </div>
        </Modal>
      )}

      {/* Tenant Add/Edit Slide-out Panel */}
      {showTenantPanel && (
        <TenantPanel
          mode={tenantPanelMode}
          suiteNumber={tenantPanelSuite}
          tenant={selectedTenantId ? tenants.find(t => t.id === selectedTenantId) : undefined}
          onSave={handleSaveTenant}
          onClose={() => setShowTenantPanel(false)}
        />
      )}
    </div>
  )
}

// ---- Tenant Add/Edit Panel (Slide-out) ----

function TenantPanel({
  mode,
  suiteNumber,
  tenant,
  onSave,
  onClose,
}: {
  mode: 'add' | 'edit'
  suiteNumber: string
  tenant?: Tenant
  onSave: (data: TenantFormData) => void
  onClose: () => void
}) {
  const [showDetails, setShowDetails] = useState(false)
  const [showSecondName, setShowSecondName] = useState(!!tenant?.secondName)
  const [form, setForm] = useState({
    name: tenant ? (tenant.secondName ? tenant.name.split(' & ')[0] : tenant.name) : '',
    secondName: tenant?.secondName || '',
    suiteNumber: suiteNumber,
    weeklyRent: tenant?.weeklyRent?.toString() || '',
    billingFrequency: (tenant?.billingFrequency || 'weekly') as BillingFrequency,
    defaultPayType: (tenant?.defaultPayType || '') as PaymentType | '',
    moveInDate: tenant?.moveInDate || '',
    phone: tenant?.phone || '',
    email: tenant?.email || '',
    securityDeposit: tenant?.securityDeposit?.toString() || '',
    leaseEnd: tenant?.leaseEnd || '',
    notes: tenant?.notes || '',
  })

  const handleSubmit = () => {
    if (!form.name || !form.weeklyRent || !form.moveInDate) return
    onSave({
      name: form.name,
      secondName: showSecondName ? form.secondName : undefined,
      suiteNumber: form.suiteNumber,
      weeklyRent: parseFloat(form.weeklyRent),
      billingFrequency: form.billingFrequency,
      defaultPayType: form.defaultPayType as PaymentType || undefined,
      moveInDate: form.moveInDate,
      phone: form.phone,
      email: form.email,
      securityDeposit: form.securityDeposit ? parseFloat(form.securityDeposit) : undefined,
      leaseEnd: form.leaseEnd,
      notes: form.notes,
    })
  }

  const isValid = form.name && form.weeklyRent && parseFloat(form.weeklyRent) > 0 && form.moveInDate

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white shadow-xl flex flex-col animate-slide-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              {mode === 'add' ? 'Add Tenant' : 'Edit Tenant'}
            </h3>
            <p className="text-xs text-gray-500">Suite {form.suiteNumber}</p>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
            <X size={20} />
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Tenant Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Lauren"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            {!showSecondName ? (
              <button
                type="button"
                onClick={() => setShowSecondName(true)}
                className="text-xs text-blue-600 hover:text-blue-800 mt-1 flex items-center gap-1"
              >
                <Plus size={10} /> Add second name (shared suite)
              </button>
            ) : (
              <div className="mt-2">
                <label className="block text-xs text-gray-500 mb-0.5">Second Tenant Name</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={form.secondName}
                    onChange={e => setForm(f => ({ ...f, secondName: e.target.value }))}
                    placeholder="e.g. Tonya"
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => { setShowSecondName(false); setForm(f => ({ ...f, secondName: '' })) }}
                    className="text-gray-400 hover:text-red-400 p-1"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Suite (auto-filled, read-only for add) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Suite Number</label>
            <input
              type="text"
              value={form.suiteNumber}
              onChange={e => setForm(f => ({ ...f, suiteNumber: e.target.value }))}
              readOnly={mode === 'add'}
              className={cn(
                'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm',
                mode === 'add' ? 'bg-gray-50 text-gray-500' : 'focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
              )}
            />
          </div>

          {/* Rent + Frequency */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Rent Amount <span className="text-red-500">*</span>
              </label>
              <input
                type="number" step="0.01"
                value={form.weeklyRent}
                onChange={e => setForm(f => ({ ...f, weeklyRent: e.target.value }))}
                placeholder="0.00"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Pay Frequency <span className="text-red-500">*</span>
              </label>
              <select
                value={form.billingFrequency}
                onChange={e => setForm(f => ({ ...f, billingFrequency: e.target.value as BillingFrequency }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {BILLING_FREQUENCIES.map(f => (<option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>))}
              </select>
            </div>
          </div>

          {/* Default Pay Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Default Payment Type</label>
            <select
              value={form.defaultPayType}
              onChange={e => setForm(f => ({ ...f, defaultPayType: e.target.value as PaymentType }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="">None</option>
              {PAYMENT_TYPES.map(t => (<option key={t} value={t}>{t}</option>))}
            </select>
          </div>

          {/* Move-in Date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Move-in Date <span className="text-red-500">*</span>
            </label>
            <input
              type="date"
              value={form.moveInDate}
              onChange={e => setForm(f => ({ ...f, moveInDate: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Phone */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
            <input
              type="tel"
              value={form.phone}
              onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
              placeholder="(555) 123-4567"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Security Deposit */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Security Deposit</label>
            <input
              type="number" step="0.01"
              value={form.securityDeposit}
              onChange={e => setForm(f => ({ ...f, securityDeposit: e.target.value }))}
              placeholder="0.00"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Lease End Date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Lease End Date</label>
            <input
              type="date"
              value={form.leaseEnd}
              onChange={e => setForm(f => ({ ...f, leaseEnd: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Optional details */}
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
          >
            <ChevronDown size={14} className={cn('transition-transform', showDetails && 'rotate-180')} />
            Optional details
          </button>
          {showDetails && (
            <div className="space-y-3 pl-2 border-l-2 border-gray-100">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="tenant@email.com"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  rows={3}
                  placeholder="Any additional details..."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-200 flex gap-2">
          <button
            onClick={handleSubmit}
            disabled={!isValid}
            className="flex-1 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {mode === 'add' ? <><UserPlus size={14} /> Add Tenant</> : <><Check size={14} /> Save Changes</>}
          </button>
          <button onClick={onClose} className="px-4 py-2.5 text-gray-600 text-sm hover:text-gray-800">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- Monthly Summary View ----

function MonthlySummaryView({ monthData }: { monthData: MonthData }) {
  const summary = useMemo(() => calculateMonthlySummary(monthData), [monthData])

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <BigStatCard label="Expected" value={formatCurrency(summary.totalExpected)} icon={<TrendingUp size={18} />} color="blue" />
        <BigStatCard label="Collected" value={formatCurrency(summary.totalCollected)} icon={<Check size={18} />} color="green" />
        <BigStatCard label="Outstanding" value={formatCurrency(summary.outstanding)} icon={<AlertCircle size={18} />} color="red" />
        <BigStatCard label="Collection Rate" value={`${summary.collectionRate.toFixed(1)}%`} icon={<BarChart3 size={18} />} color="purple" />
      </div>

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
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <AlertCircle size={16} className="text-red-500" /> Problem Tenants
          </h3>
          {summary.repeatUnpaid.length === 0 && summary.chronicLate.length === 0 ? (
            <p className="text-sm text-gray-500 italic">No late or unpaid tenants this month</p>
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

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={cn('px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider', className)}>
      {children}
    </th>
  )
}

function EntryRow({
  entry,
  credit,
  onUpdate,
  onFrequencyChange,
  onPhoneChange,
  isEditing,
  onStartEdit,
  onStopEdit,
  onAddTenant,
  onEditTenant,
  onMoveOutTenant,
  onApplyCredit,
}: {
  entry: MonthTenantEntry
  credit: number
  onUpdate: (id: string, updates: Partial<TenantWeekEntry>, markManual?: boolean) => void
  onFrequencyChange: (id: string, freq: BillingFrequency) => void
  onPhoneChange: (id: string, phone: string) => void
  isEditing: boolean
  onStartEdit: () => void
  onStopEdit: () => void
  onAddTenant: (suiteNumber: string) => void
  onEditTenant: (tenantId: string) => void
  onMoveOutTenant: (tenantId: string) => void
  onApplyCredit: (tenantId: string) => void
}) {
  const { tenant, status, isVacant } = entry
  const isSpecial = status === 'free_week' || status === 'comped_week'
  const isPending = status === 'monthly_pending' || status === 'biweekly_off'
  // Monthly tenants should still show payment fields — only bi-weekly off weeks are truly disabled
  const isPaymentDisabled = isSpecial || status === 'biweekly_off'

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
          {/* Credit badge */}
          {credit > 0 && !isVacant && (
            <button
              onClick={() => onApplyCredit(tenant.id)}
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 cursor-pointer flex items-center gap-0.5"
              title={`Apply ${formatCurrency(credit)} credit`}
            >
              <Wallet size={9} /> {formatCurrency(credit)}
            </button>
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
        ) : isPaymentDisabled ? (
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
        {!isVacant && !isPaymentDisabled && (
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
        {!isVacant && !isPaymentDisabled && (
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

      {/* Actions column */}
      <td className="px-2 py-1.5">
        {isVacant ? (
          <button
            onClick={() => onAddTenant(tenant.suiteNumber)}
            className="p-1 text-blue-500 hover:text-blue-700 hover:bg-blue-50 rounded"
            title="Add tenant to this suite"
          >
            <UserPlus size={14} />
          </button>
        ) : (
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => onEditTenant(tenant.id)}
              className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
              title="Edit tenant"
            >
              <Pencil size={13} />
            </button>
            <button
              onClick={() => onMoveOutTenant(tenant.id)}
              className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
              title="Move out tenant"
            >
              <DoorOpen size={13} />
            </button>
          </div>
        )}
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

function Modal({ onClose, title, children, wide }: { onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className={cn('bg-white rounded-xl shadow-xl p-5 mx-4', wide ? 'w-full max-w-2xl' : 'w-full max-w-md')} onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 mb-3">{title}</h3>
        {children}
      </div>
    </div>
  )
}
