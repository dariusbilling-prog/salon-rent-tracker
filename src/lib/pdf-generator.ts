import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { TenantWeekEntry } from '@/types'
import { formatCurrency, getStatusLabel, fridayFullLabel, fridayShortLabel } from './utils'
import { MaintenanceEntry, maintenanceTotal } from './maintenance'

interface ReportData {
  weekLabel: string
  entries: TenantWeekEntry[]
  totalDue: number
  /** Cleared cash only — pending ACH is reported separately. */
  totalPaid: number
  totalPending?: number
  /** The Friday this week was due, ISO. Used to tell on-time from late. */
  dueDate?: string
}

/** True when the money settled after the Friday it was due. */
function settledLate(entry: TenantWeekEntry, dueDate?: string): boolean {
  if (!dueDate || !entry.paidDate || entry.amountPaid <= 0) return false
  return entry.paidDate > dueDate
}

export function generateWeeklyPDF(data: ReportData): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' })

  const pageWidth = doc.internal.pageSize.getWidth()

  // Header
  doc.setFontSize(18)
  doc.setFont('helvetica', 'bold')
  doc.text('Salon Boutique — Weekly Rent Report', pageWidth / 2, 40, { align: 'center' })

  doc.setFontSize(12)
  doc.setFont('helvetica', 'normal')
  doc.text(data.weekLabel, pageWidth / 2, 58, { align: 'center' })

  // "As of" stamp. Late payments back-fill into earlier weeks, so two reports for
  // the same week can legitimately differ — the accountant needs to know which
  // snapshot she is holding.
  const now = new Date()
  const asOf = `${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} at ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
  doc.setFontSize(9)
  doc.setTextColor(107, 114, 128)
  doc.text(`Figures as of ${asOf}`, pageWidth / 2, 72, { align: 'center' })
  doc.setTextColor(0, 0, 0)

  // Summary line
  const pendingTotal = data.totalPending || 0
  const outstanding = Math.round((data.totalDue - data.totalPaid - pendingTotal) * 100) / 100
  const collectionRate = data.totalDue > 0 ? ((data.totalPaid / data.totalDue) * 100).toFixed(1) : '0.0'
  doc.setFontSize(10)
  doc.text(
    [
      `Due: ${formatCurrency(data.totalDue)}`,
      `Collected (cleared): ${formatCurrency(data.totalPaid)}`,
      ...(pendingTotal > 0 ? [`Pending: ${formatCurrency(pendingTotal)}`] : []),
      `Outstanding: ${formatCurrency(outstanding)}`,
      `Rate: ${collectionRate}%`,
    ].join('  |  '),
    pageWidth / 2,
    90,
    { align: 'center' }
  )

  // Table
  const tableData = data.entries.map(entry => {
    const statusLabel = entry.isVacant ? 'VACANT' : getStatusLabel(entry.status)
    const paidDisplay = entry.isVacant
      ? '—'
      : entry.status === 'free_week'
        ? 'FREE WEEK'
        : entry.status === 'comped_week'
          ? 'COMPED'
          : entry.status === 'monthly_pending'
            ? 'Monthly'
            : entry.status === 'biweekly_off'
              ? 'Off Week'
              : entry.amountPaid > 0
                ? formatCurrency(entry.amountPaid)
                : entry.status === 'late'
                  ? 'late'
                  : '$0.00'

    return [
      entry.tenant.suiteNumber,
      entry.isVacant ? 'Vacant' : entry.tenant.name,
      entry.isVacant ? '—' : formatCurrency(entry.amountDue),
      paidDisplay,
      entry.paymentType || '',
      statusLabel,
      (entry.pendingAmount || 0) > 0
        ? 'PENDING'
        : settledLate(entry, data.dueDate)
          ? `Late (${entry.paidDate})`
          : entry.confirmation || '',
      entry.checkNumber || '',
      entry.notes || '',
    ]
  })

  autoTable(doc, {
    startY: 104,
    head: [['Suite', 'Tenant Name', 'Rent Due', 'Rent Paid', 'Pay Type', 'Status', 'Confirm / Timing', 'Check #', 'Notes']],
    body: tableData,
    styles: {
      fontSize: 8,
      cellPadding: 3,
    },
    headStyles: {
      fillColor: [55, 65, 81],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
    },
    columnStyles: {
      0: { cellWidth: 50 },
      1: { cellWidth: 110 },
      2: { cellWidth: 55, halign: 'right' },
      3: { cellWidth: 55, halign: 'right' },
      4: { cellWidth: 50 },
      5: { cellWidth: 55 },
      6: { cellWidth: 70 },
      7: { cellWidth: 40, halign: 'center' },
      8: { cellWidth: 'auto' },
    },
    didParseCell: function (data) {
      // Color code status column
      // Make PENDING and Late unmissable in the Confirm column.
      if (data.column.index === 6 && data.section === 'body') {
        const val = String(data.cell.raw || '')
        if (val === 'PENDING') {
          data.cell.styles.textColor = [180, 83, 9]
          data.cell.styles.fontStyle = 'bold'
        } else if (val.startsWith('Late')) {
          data.cell.styles.textColor = [161, 98, 7]
        }
      }
      if (data.column.index === 5 && data.section === 'body') {
        const val = String(data.cell.raw)
        if (val === 'Paid') {
          data.cell.styles.textColor = [21, 128, 61]
          data.cell.styles.fontStyle = 'bold'
        } else if (val === 'Late') {
          data.cell.styles.textColor = [185, 28, 28]
          data.cell.styles.fontStyle = 'bold'
        } else if (val === 'Partial') {
          data.cell.styles.textColor = [161, 98, 7]
          data.cell.styles.fontStyle = 'bold'
        } else if (val === 'Free Week' || val === 'Comped Week') {
          data.cell.styles.textColor = [67, 56, 202]
          data.cell.styles.fontStyle = 'bold'
        } else if (val === 'VACANT') {
          data.cell.styles.textColor = [156, 163, 175]
          data.cell.styles.fontStyle = 'italic'
        }
      }
    },
    // No foot — summary is at the top to avoid duplicate totals
  })

  // Pending appendix — the reason this report exists in the first place. If ACH
  // is still in flight when it is sent, the accountant should not have to hunt
  // through the table to find which lines are not yet money in the bank.
  const pendingRows = data.entries.filter(e => (e.pendingAmount || 0) > 0)
  if (pendingRows.length > 0) {
    const y = ((doc as any).lastAutoTable?.finalY || 400) + 24
    doc.setFontSize(11)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(180, 83, 9)
    doc.text(`Pending payments — not yet cleared as of ${asOf}`, 40, y)
    doc.setTextColor(0, 0, 0)

    autoTable(doc, {
      startY: y + 8,
      head: [['Suite', 'Tenant Name', 'Amount Pending', 'Method', 'Expected Settlement']],
      body: pendingRows.map(e => [
        e.tenant.suiteNumber,
        e.tenant.name,
        formatCurrency(e.pendingAmount || 0),
        e.paymentType || 'ACH',
        e.paidDate || '—',
      ]),
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: {
        fillColor: [180, 83, 9],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 8,
      },
      columnStyles: {
        0: { cellWidth: 50 },
        1: { cellWidth: 140 },
        2: { cellWidth: 90, halign: 'right' },
        3: { cellWidth: 60 },
        4: { cellWidth: 110 },
      },
      foot: [[
        '',
        'Total pending',
        formatCurrency(pendingRows.reduce((sum, e) => sum + (e.pendingAmount || 0), 0)),
        '',
        '',
      ]],
      footStyles: { fillColor: [254, 243, 199], textColor: [120, 53, 15], fontStyle: 'bold', fontSize: 8 },
    })
  }

  // Footer
  const finalY = (doc as any).lastAutoTable?.finalY || 500
  doc.setFontSize(8)
  doc.setTextColor(156, 163, 175)
  doc.text(
    `Generated: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}  •  Salon Boutique Rent Tracker`,
    pageWidth / 2,
    finalY + 30,
    { align: 'center' }
  )

  return doc
}

// ---------------------------------------------------------------------------
// Monthly P&L — matches the spreadsheet report that has always gone to the
// accountant: Monthly Overview, Detailed Late Payment, Vacancy, Maintenance,
// then one detail page per week.
// ---------------------------------------------------------------------------

export interface MonthlyReportData {
  /** e.g. "February" */
  monthName: string
  /** e.g. "2026" */
  year: string
  weeks: Array<{ friday: string; entries: TenantWeekEntry[] }>
  maintenance: MaintenanceEntry[]
}

/** Statuses where rent was deliberately not charged. */
const NOT_BILLED: Record<string, string> = {
  free_week: 'Free week',
  comped_week: 'Comped',
  biweekly_off: 'Off week (bi-weekly)',
}

/** Accounting style: negatives in parentheses, as the existing report shows them. */
function acc(n: number): string {
  const v = Math.abs(Math.round(n * 100) / 100)
  const body = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `$ (${body})` : `$ ${body}`
}

const INK = { head: [68, 84, 106] as [number, number, number], line: [180, 186, 196] as [number, number, number] }

export function generateMonthlyPDF(data: MonthlyReportData): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const M = 40
  const r2 = (n: number) => Math.round(n * 100) / 100

  const now = new Date()
  const asOf = `${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} at ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`

  // ---- Aggregate ---------------------------------------------------------
  interface Late { suite: string; name: string; weeksOwed: number; due: number; paid: number; notes: string[] }
  interface Vac { suite: string; weeks: number; lost: number; notes: string[] }
  interface Pend { suite: string; name: string; week: string; amount: number; method: string; settles: string }

  const lates = new Map<string, Late>()
  const vacancies = new Map<string, Vac>()
  const pendings: Pend[] = []
  const unbilled = new Map<string, { suite: string; name: string; amount: number; reasons: Map<string, number> }>()
  let totalDue = 0, totalPaid = 0, totalPending = 0

  for (const { friday, entries } of data.weeks) {
    for (const e of entries) {
      if (e.isVacant) {
        const key = e.tenant.suiteNumber
        if (!vacancies.has(key)) vacancies.set(key, { suite: key, weeks: 0, lost: 0, notes: [] })
        const v = vacancies.get(key)!
        v.weeks += 1
        v.lost += e.tenant.weeklyRent || 0
        if (e.notes && !v.notes.includes(e.notes)) v.notes.push(e.notes)
        continue
      }

      if (NOT_BILLED[e.status]) {
        const key = e.tenant.id
        if (!unbilled.has(key)) unbilled.set(key, { suite: e.tenant.suiteNumber, name: e.tenant.name, amount: 0, reasons: new Map() })
        const u = unbilled.get(key)!
        u.amount += e.amountDue
        const label = NOT_BILLED[e.status]
        u.reasons.set(label, (u.reasons.get(label) || 0) + 1)
        continue
      }

      totalDue += e.amountDue
      totalPaid += e.amountPaid
      totalPending += e.pendingAmount || 0

      if ((e.pendingAmount || 0) > 0) {
        pendings.push({
          suite: e.tenant.suiteNumber, name: e.tenant.name, week: fridayShortLabel(friday),
          amount: e.pendingAmount || 0, method: e.paymentType || 'ACH', settles: e.paidDate || '—',
        })
      }

      if (e.amountDue - e.amountPaid > 0.005) {
        const key = e.tenant.id
        if (!lates.has(key)) lates.set(key, { suite: e.tenant.suiteNumber, name: e.tenant.name, weeksOwed: 0, due: 0, paid: 0, notes: [] })
        const l = lates.get(key)!
        l.weeksOwed += 1
        l.due += e.amountDue
        l.paid += e.amountPaid
        if (e.notes && !l.notes.includes(e.notes)) l.notes.push(e.notes)
      }
    }
  }

  const collected = r2(totalPaid)
  const outstanding = r2(totalDue - totalPaid)
  const maintTotal = maintenanceTotal(data.maintenance)
  const unbilledTotal = r2(Array.from(unbilled.values()).reduce((a, u) => a + u.amount, 0))

  // ---- Title -------------------------------------------------------------
  doc.setFillColor(242, 242, 242)
  doc.rect(M, 28, pageWidth - M * 2, 54, 'F')
  doc.setFontSize(20); doc.setFont('helvetica', 'normal'); doc.setTextColor(0, 0, 0)
  doc.text(`Salon Boutique Rockwall - ${data.monthName} P&L - ${data.year}`, pageWidth / 2, 54, { align: 'center' })
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(100, 100, 100)
  doc.text('Report Generated by Redline Studio LLC', pageWidth / 2, 72, { align: 'center' })
  doc.setFont('helvetica', 'normal'); doc.setTextColor(0, 0, 0)

  /**
   * Move to a new page when a section would otherwise be split across the fold.
   * A table whose header lands at the bottom of one page and whose rows land on
   * the next is genuinely hard to read — worse than a little white space.
   */
  const ensureRoom = (y: number, rows: number): number => {
    const needed = 46 + Math.min(rows, 12) * 22 + 30
    return y + needed > doc.internal.pageSize.getHeight() - 56 ? (doc.addPage(), 56) : y
  }

  const section = (title: string, y: number) => {
    doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(0, 0, 0)
    doc.text(title, M, y)
  }
  const tableOpts = {
    margin: { left: M, right: M },
    styles: { fontSize: 8.5, cellPadding: 4, lineColor: INK.line, lineWidth: 0.5 },
    headStyles: { fillColor: [217, 217, 217] as [number, number, number], textColor: [0, 0, 0] as [number, number, number], fontStyle: 'bold' as const, fontSize: 8.5 },
  }

  // ---- 1. Monthly Overview ------------------------------------------------
  doc.setFontSize(8); doc.setTextColor(120, 120, 120)
  doc.text(`Figures as of ${asOf}`, M, 96)
  doc.setTextColor(0, 0, 0)
  section('Monthly Overview Section', 116)
  autoTable(doc, {
    ...tableOpts,
    startY: 124,
    head: [['Rent', 'Amount']],
    body: [
      ['Total Rent Due', acc(totalDue)],
      ['Total Rent Collected', acc(collected)],
      ...(totalPending > 0 ? [['Pending — not yet cleared', acc(totalPending)]] : []),
      ['Outstanding Balance', acc(-outstanding)],
    ],
    columnStyles: { 0: { cellWidth: 240 }, 1: { cellWidth: 230, halign: 'right' } },
    didParseCell: d => {
      if (d.section !== 'body' || d.column.index !== 1) return
      const label = String((d.row.raw as string[])[0])
      if (label.includes('Collected')) { d.cell.styles.textColor = [0, 128, 0]; d.cell.styles.fontStyle = 'bold' }
      if (label.includes('Outstanding')) { d.cell.styles.textColor = [192, 0, 0]; d.cell.styles.fontStyle = 'bold' }
      if (label.includes('Pending')) { d.cell.styles.textColor = [180, 83, 9]; d.cell.styles.fontStyle = 'bold' }
    },
  })

  // ---- 2. Detailed Late Payment -------------------------------------------
  const lateRows = Array.from(lates.values()).sort((a, b) => (b.due - b.paid) - (a.due - a.paid))
  // Sum the rows actually printed above, NOT the month-wide outstanding.
  // Those two figures diverge whenever anyone overpays: an overpayment reduces
  // `outstanding` but never appears in this table, so the footer read $780 under
  // rows that added to $880. An accountant checks a column total by adding the
  // column, and a footer that does not match is the fastest way to lose their
  // trust in the whole report.
  const lateTotal = r2(lateRows.reduce((sum, l) => sum + (l.due - l.paid), 0))
  let y = ensureRoom(((doc as any).lastAutoTable?.finalY || 180) + 26, lateRows.length || 1)
  section('Detailed Late Payment Section', y)
  autoTable(doc, {
    ...tableOpts,
    startY: y + 8,
    head: [['Tenant Name', 'Weeks Owed', 'Amount Due', 'Amount Paid', 'Balance Due', 'Notes']],
    body: lateRows.length
      ? lateRows.map(l => [
          `${l.name} (${l.suite})`, String(l.weeksOwed), acc(l.due), acc(l.paid),
          acc(-(r2(l.due - l.paid))), l.notes.join('; '),
        ])
      : [['—', '', '', '', acc(0), 'Everything billed was collected in full']],
    foot: [['', '', '', 'Total Due:', { content: acc(-lateTotal), styles: { halign: 'right' as const } }, '']],
    footStyles: { fillColor: [242, 242, 242], textColor: [192, 0, 0], fontStyle: 'bold', fontSize: 8.5 },
    columnStyles: {
      0: { cellWidth: 170 }, 1: { cellWidth: 70, halign: 'center' },
      2: { cellWidth: 90, halign: 'right' }, 3: { cellWidth: 90, halign: 'right' },
      4: { cellWidth: 90, halign: 'right' }, 5: { cellWidth: 'auto' },
    },
    didParseCell: d => {
      if (d.section === 'body' && d.column.index === 4) d.cell.styles.textColor = [192, 0, 0]
    },
  })

  // Where tenants have paid more than they were billed, the outstanding balance
  // in the overview is smaller than the total owed above. Say so in one line,
  // rather than leaving two different totals on the page unexplained.
  const overpaid = r2(lateTotal - outstanding)
  if (Math.abs(overpaid) > 0.005) {
    const noteY = ((doc as any).lastAutoTable?.finalY || y) + 14
    doc.setFontSize(7.5); doc.setFont('helvetica', 'italic'); doc.setTextColor(120, 120, 120)
    doc.text(
      `Total owed above is ${acc(lateTotal)}. Overpayments elsewhere in the month of ${acc(overpaid)} reduce the ` +
        `Outstanding Balance in the Monthly Overview to ${acc(outstanding)}.`,
      M, noteY
    )
    doc.setFont('helvetica', 'normal'); doc.setTextColor(0, 0, 0)
    ;(doc as any).lastAutoTable.finalY = noteY + 4
  }

  // ---- 3. Vacancy ----------------------------------------------------------
  const vacRows = Array.from(vacancies.values())
  y = ensureRoom(((doc as any).lastAutoTable?.finalY || y) + 26, vacRows.length || 1)
  section('Salon Vacancy for Month', y)
  autoTable(doc, {
    ...tableOpts,
    startY: y + 8,
    head: [['Suite Number', 'Weeks Vacant Total', 'Lost Rental Income', 'Notes']],
    body: vacRows.length
      ? vacRows.map(v => [v.suite, String(v.weeks), acc(-v.lost), v.notes.join('; ')])
      : [['—', '0', acc(0), 'No vacant suites this month']],
    columnStyles: {
      0: { cellWidth: 110 }, 1: { cellWidth: 120, halign: 'center' },
      2: { cellWidth: 130, halign: 'right' }, 3: { cellWidth: 'auto' },
    },
    didParseCell: d => {
      if (d.section === 'body' && d.column.index === 2) d.cell.styles.textColor = [192, 0, 0]
    },
  })

  // ---- 3b. Rent not billed (concessions) ----------------------------------
  if (unbilled.size > 0) {
    y = ensureRoom(((doc as any).lastAutoTable?.finalY || y) + 26, unbilled.size)
    section('Rent Not Billed (excluded from Total Rent Due)', y)
    autoTable(doc, {
      ...tableOpts,
      startY: y + 8,
      head: [['Suite Number', 'Tenant Name', 'Amount', 'Reason']],
      body: Array.from(unbilled.values()).sort((a, b) => b.amount - a.amount).map(u => [
        u.suite, u.name, acc(-u.amount),
        Array.from(u.reasons.entries()).map(([l, n]) => (n > 1 ? `${l} x${n}` : l)).join('; '),
      ]),
      foot: [['', 'Total not billed:', { content: acc(-unbilledTotal), styles: { halign: 'right' as const } }, '']],
      footStyles: { fillColor: [242, 242, 242], textColor: [0, 0, 0], fontStyle: 'bold', fontSize: 8.5 },
      columnStyles: {
        0: { cellWidth: 110 }, 1: { cellWidth: 170 },
        2: { cellWidth: 110, halign: 'right' }, 3: { cellWidth: 'auto' },
      },
    })
  }

  // ---- 3c. Pending ---------------------------------------------------------
  if (pendings.length > 0) {
    y = ensureRoom(((doc as any).lastAutoTable?.finalY || y) + 26, pendings.length)
    section(`Pending Transactions — initiated but not yet cleared as of ${asOf}`, y)
    autoTable(doc, {
      ...tableOpts,
      startY: y + 8,
      head: [['Suite Number', 'Tenant Name', 'Week', 'Amount Pending', 'Method', 'Expected Settlement']],
      body: pendings.sort((a, b) => b.amount - a.amount)
        .map(p => [p.suite, p.name, p.week, acc(p.amount), p.method, p.settles]),
      foot: [['', '', 'Total Pending:', { content: acc(totalPending), styles: { halign: 'right' as const } }, '', '']],
      footStyles: { fillColor: [254, 243, 199], textColor: [120, 53, 15], fontStyle: 'bold', fontSize: 8.5 },
      columnStyles: {
        0: { cellWidth: 90 }, 1: { cellWidth: 150 }, 2: { cellWidth: 60, halign: 'center' },
        3: { cellWidth: 100, halign: 'right' }, 4: { cellWidth: 70 }, 5: { cellWidth: 'auto' },
      },
      didParseCell: d => {
        if (d.section === 'body' && d.column.index === 3) d.cell.styles.textColor = [180, 83, 9]
      },
    })
  }

  // ---- 4. Maintenance Log --------------------------------------------------
  y = ensureRoom(((doc as any).lastAutoTable?.finalY || y) + 26, data.maintenance.length || 1)
  section('Maintenance Log', y)
  autoTable(doc, {
    ...tableOpts,
    startY: y + 8,
    head: [['Date', 'Company', 'Suite Number or Bldg', 'Activity', 'Cost', 'Notes']],
    body: data.maintenance.length
      ? [...data.maintenance]
          .sort((a, b) => a.date.localeCompare(b.date))
          .map(m => [m.date, m.company, m.location, m.activity, acc(-m.cost), m.notes])
      : [['—', '', '', '', acc(0), 'No maintenance recorded this month']],
    foot: [['', '', '', 'Total in Monthly Maintenance', { content: acc(-maintTotal), styles: { halign: 'right' as const } }, '']],
    footStyles: { fillColor: [242, 242, 242], textColor: [192, 0, 0], fontStyle: 'bold', fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 70 }, 1: { cellWidth: 130 }, 2: { cellWidth: 130 },
      3: { cellWidth: 90 }, 4: { cellWidth: 100, halign: 'right' }, 5: { cellWidth: 'auto' },
    },
    didParseCell: d => {
      if (d.section === 'body' && d.column.index === 4) d.cell.styles.textColor = [192, 0, 0]
    },
  })

  // ---- Weekly detail pages -------------------------------------------------
  for (const { friday, entries } of data.weeks) {
    doc.addPage()
    doc.setFillColor(242, 242, 242)
    doc.rect(M, 34, pageWidth - M * 2, 26, 'F')
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(0, 0, 0)
    doc.text(fridayFullLabel(friday), M + 8, 52)

    let wDue = 0, wPaid = 0
    for (const e of entries) {
      if (e.isVacant || NOT_BILLED[e.status]) continue
      wDue += e.amountDue; wPaid += e.amountPaid
    }

    autoTable(doc, {
      ...tableOpts,
      startY: 68,
      head: [['Suite Number', 'Tenant Name', 'Rent Due', 'Rent Paid', 'Payment Type', 'Status', 'Confirm', 'Check #', 'Notes']],
      body: entries.map(e => [
        e.tenant.suiteNumber,
        e.isVacant ? 'Vacant' : e.tenant.name,
        e.isVacant ? '—' : acc(e.amountDue),
        e.isVacant ? '—' : NOT_BILLED[e.status] ? NOT_BILLED[e.status] : acc(e.amountPaid),
        e.paymentType || '',
        e.isVacant ? 'VACANT' : getStatusLabel(e.status),
        (e.pendingAmount || 0) > 0 ? 'PENDING' : e.confirmation || '',
        e.checkNumber || '',
        e.notes || '',
      ]),
      foot: [[
        '', 'Totals',
        { content: acc(wDue), styles: { halign: 'right' as const } },
        { content: acc(wPaid), styles: { halign: 'right' as const } },
        '', '', '', '', '',
      ]],
      footStyles: { fillColor: [242, 242, 242], textColor: [0, 0, 0], fontStyle: 'bold', fontSize: 8.5 },
      columnStyles: {
        0: { cellWidth: 62 }, 1: { cellWidth: 130 },
        2: { cellWidth: 72, halign: 'right' }, 3: { cellWidth: 76, halign: 'right' },
        4: { cellWidth: 70 }, 5: { cellWidth: 62 }, 6: { cellWidth: 66 },
        7: { cellWidth: 50, halign: 'center' }, 8: { cellWidth: 'auto' },
      },
      didParseCell: d => {
        if (d.section !== 'body') return
        if (d.column.index === 5) {
          const v = String(d.cell.raw)
          if (v === 'Paid') d.cell.styles.textColor = [0, 128, 0]
          else if (v === 'Late' || v === 'Unpaid') d.cell.styles.textColor = [192, 0, 0]
          else if (v === 'VACANT') { d.cell.styles.textColor = [150, 150, 150]; d.cell.styles.fontStyle = 'italic' }
        }
        if (d.column.index === 6 && String(d.cell.raw) === 'PENDING') {
          d.cell.styles.textColor = [180, 83, 9]; d.cell.styles.fontStyle = 'bold'
        }
      },
    })
  }

  // ---- Footer on every page ------------------------------------------------
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setFontSize(7.5); doc.setTextColor(150, 150, 150)
    doc.text(
      `Report Generated by Redline Studio LLC  •  ${data.monthName} ${data.year}  •  As of ${asOf}  •  Page ${i} of ${pages}`,
      pageWidth / 2, doc.internal.pageSize.getHeight() - 22, { align: 'center' }
    )
  }

  return doc
}
