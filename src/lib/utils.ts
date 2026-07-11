import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { WeekStatus } from '@/types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(amount)
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr + 'T12:00:00')
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function getStatusLabel(status: WeekStatus): string {
  const labels: Record<WeekStatus, string> = {
    paid: 'Paid',
    partial: 'Partial',
    late: 'Late',
    unpaid: 'Unpaid',
    free_week: 'Free Week',
    comped_week: 'Comped Week',
    monthly_pending: 'Monthly',
    biweekly_off: 'Off Week',
  }
  return labels[status]
}

export function getStatusColor(status: WeekStatus): string {
  const colors: Record<WeekStatus, string> = {
    paid: 'bg-green-50 text-green-700 border-green-200',
    partial: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    late: 'bg-red-50 text-red-700 border-red-200',
    unpaid: 'bg-gray-50 text-gray-500 border-gray-200',
    free_week: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    comped_week: 'bg-pink-50 text-pink-700 border-pink-200',
    monthly_pending: 'bg-purple-50 text-purple-700 border-purple-200',
    biweekly_off: 'bg-blue-50 text-blue-700 border-blue-200',
  }
  return colors[status]
}

// Format a date as ISO YYYY-MM-DD
export function toISODate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Parse ISO YYYY-MM-DD to a Date (local timezone)
export function fromISODate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(year, month - 1, day)
}

// Get all Fridays in a given month (YYYY-MM)
export function getFridaysInMonth(monthKey: string): string[] {
  const [year, month] = monthKey.split('-').map(Number)
  const fridays: string[] = []
  const date = new Date(year, month - 1, 1)
  while (date.getMonth() === month - 1) {
    if (date.getDay() === 5) {
      fridays.push(toISODate(date))
    }
    date.setDate(date.getDate() + 1)
  }
  return fridays
}

// Format a Friday ISO date to short label (e.g. "3/20")
export function fridayShortLabel(iso: string): string {
  const d = fromISODate(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// Format a Friday ISO date to full label (e.g. "Friday 3/20/26")
export function fridayFullLabel(iso: string): string {
  const d = fromISODate(iso)
  return `Friday ${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear().toString().slice(-2)}`
}

// Format a month key YYYY-MM to label (e.g. "March 2026")
export function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number)
  const d = new Date(year, month - 1, 1)
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

// Get current month key YYYY-MM
export function getCurrentMonthKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Navigate months
export function addMonths(monthKey: string, offset: number): string {
  const [year, month] = monthKey.split('-').map(Number)
  const d = new Date(year, month - 1 + offset, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Get the current rent week (Monday to Friday containing today)
export function getCurrentRentWeek(): { weekStart: string; weekEnd: string; dueDate: string; weekLabel: string } {
  const today = new Date()
  const day = today.getDay() // 0=Sun, 1=Mon, ..., 6=Sat

  // Find this week's Monday
  const monday = new Date(today)
  const daysFromMonday = day === 0 ? 6 : day - 1
  monday.setDate(today.getDate() - daysFromMonday)

  // Find this week's Friday
  const friday = new Date(monday)
  friday.setDate(monday.getDate() + 4)

  const fmt = (d: Date) => d.toISOString().split('T')[0]

  // Show the Friday due date as the week label (e.g. "Friday 3/20/26")
  const weekLabel = `Friday ${friday.getMonth() + 1}/${friday.getDate()}/${friday.getFullYear().toString().slice(-2)}`

  return {
    weekStart: fmt(monday),
    weekEnd: fmt(friday),
    dueDate: fmt(friday),
    weekLabel,
  }
}
