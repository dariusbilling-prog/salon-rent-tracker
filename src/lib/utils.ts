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
