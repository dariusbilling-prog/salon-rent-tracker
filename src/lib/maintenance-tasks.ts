// Maintenance Task Board — Kanban-style task management for building maintenance.
//
// Separate from maintenance.ts (which tracks monthly P&L costs/invoices).
// This module manages the full lifecycle of maintenance requests:
//   New → Quoted → Scheduled → In Progress → Complete

export type TaskStatus = 'new' | 'quoted' | 'scheduled' | 'in-progress' | 'complete'
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low'

export type TaskCategory =
  | 'Plumbing'
  | 'Electrical'
  | 'HVAC'
  | 'Appliance'
  | 'Flooring'
  | 'Walls/Paint'
  | 'Door/Lock'
  | 'Lighting'
  | 'Pest Control'
  | 'General'
  | 'Other'

export interface Quote {
  vendor: string
  phone: string
  amount: number
  notes: string
  date: string
}

export interface MaintenanceTask {
  id: string
  title: string
  description: string
  suite: string          // Suite number or "Building"
  tenantName: string
  category: TaskCategory
  priority: TaskPriority
  status: TaskStatus
  dateCreated: string    // ISO date
  dueDate: string        // ISO date (target completion)
  dateCompleted?: string  // ISO date (actual completion)
  vendorName: string
  vendorPhone: string
  quotes: Quote[]
  estimatedCost: number
  actualCost: number
  materials: string
  notes: string
}

const STORAGE_KEY = 'salon-maintenance-tasks'

export function loadTasks(): MaintenanceTask[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as MaintenanceTask[]) : []
  } catch {
    return []
  }
}

export function saveTasks(tasks: MaintenanceTask[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
  } catch (err) {
    console.error('Failed to save maintenance tasks:', err)
  }
}

export function newTaskId(): string {
  return `mt-${Date.now()}-${Math.floor(Math.random() * 1000)}`
}

export function createBlankTask(): Omit<MaintenanceTask, 'id' | 'dateCreated'> {
  return {
    title: '',
    description: '',
    suite: '',
    tenantName: '',
    category: 'General',
    priority: 'medium',
    status: 'new',
    dueDate: '',
    vendorName: '',
    vendorPhone: '',
    quotes: [],
    estimatedCost: 0,
    actualCost: 0,
    materials: '',
    notes: '',
  }
}

export const STATUS_COLUMNS: { key: TaskStatus; label: string; color: string }[] = [
  { key: 'new',         label: 'New',          color: '#6c5ce7' },
  { key: 'quoted',      label: 'Quoted',       color: '#0984e3' },
  { key: 'scheduled',   label: 'Scheduled',    color: '#fdcb6e' },
  { key: 'in-progress', label: 'In Progress',  color: '#e17055' },
  { key: 'complete',    label: 'Complete',      color: '#00b894' },
]

export const PRIORITY_CONFIG: Record<TaskPriority, { label: string; color: string; bg: string }> = {
  urgent: { label: 'Urgent', color: '#e74c3c', bg: '#ffeaea' },
  high:   { label: 'High',   color: '#e67e22', bg: '#fff3e0' },
  medium: { label: 'Medium', color: '#f1c40f', bg: '#fef9e7' },
  low:    { label: 'Low',    color: '#27ae60', bg: '#e8f8f5' },
}

export const CATEGORIES: TaskCategory[] = [
  'Plumbing', 'Electrical', 'HVAC', 'Appliance', 'Flooring',
  'Walls/Paint', 'Door/Lock', 'Lighting', 'Pest Control', 'General', 'Other',
]

export function isOverdue(task: MaintenanceTask): boolean {
  if (task.status === 'complete' || !task.dueDate) return false
  return new Date(task.dueDate + 'T23:59:59') < new Date()
}

export function isDueSoon(task: MaintenanceTask): boolean {
  if (task.status === 'complete' || !task.dueDate) return false
  const due = new Date(task.dueDate + 'T23:59:59')
  const now = new Date()
  const diff = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  return diff >= 0 && diff <= 3
}

export function taskSortKey(task: MaintenanceTask): number {
  // Sort by: overdue first, then by priority, then by due date
  const priorityOrder: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 }
  let score = priorityOrder[task.priority] * 100
  if (isOverdue(task)) score -= 1000
  if (task.dueDate) score += new Date(task.dueDate).getTime() / 1e12
  return score
}
