import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { TenantWeekEntry, WeekStatus } from '@/types'
import { formatCurrency, getStatusLabel } from './utils'

interface ReportData {
  weekLabel: string
  entries: TenantWeekEntry[]
  totalDue: number
  totalPaid: number
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

  // Summary line
  const collectionRate = data.totalDue > 0 ? ((data.totalPaid / data.totalDue) * 100).toFixed(1) : '0.0'
  doc.setFontSize(10)
  doc.text(
    `Due: ${formatCurrency(data.totalDue)}  |  Collected: ${formatCurrency(data.totalPaid)}  |  Outstanding: ${formatCurrency(data.totalDue - data.totalPaid)}  |  Rate: ${collectionRate}%`,
    pageWidth / 2,
    76,
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
      entry.confirmation || '',
      entry.checkNumber || '',
      entry.notes || '',
    ]
  })

  autoTable(doc, {
    startY: 90,
    head: [['Suite', 'Tenant Name', 'Rent Due', 'Rent Paid', 'Pay Type', 'Status', 'Confirm', 'Check #', 'Notes']],
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
    foot: [[
      '', 'TOTALS:', formatCurrency(data.totalDue), formatCurrency(data.totalPaid), '', '', '', '', ''
    ]],
    footStyles: {
      fillColor: [243, 244, 246],
      textColor: [17, 24, 39],
      fontStyle: 'bold',
      fontSize: 9,
    },
  })

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
