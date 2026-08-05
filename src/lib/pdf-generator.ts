import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { TenantWeekEntry } from '@/types'
import { formatCurrency, getStatusLabel } from './utils'

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
