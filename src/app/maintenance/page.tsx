'use client'

import { useState, useCallback, useMemo, useRef } from 'react'
import Link from 'next/link'
import {
  Plus, X, ChevronLeft, AlertTriangle, Clock, Phone,
  DollarSign, Wrench, MapPin, User, FileText, Package,
  Calendar, CheckCircle2, GripVertical,
} from 'lucide-react'
import {
  MaintenanceTask, TaskStatus, TaskPriority, TaskCategory,
  loadTasks, saveTasks, newTaskId, createBlankTask,
  STATUS_COLUMNS, PRIORITY_CONFIG, CATEGORIES,
  isOverdue, isDueSoon, taskSortKey,
} from '@/lib/maintenance-tasks'

// ─── Suite list (matches tenant-data.ts) ─────────────────────────────────────
const SUITES = [
  'Building', '101/102', '103', '104', '105', '106/108', '107',
  '109', '110', '111', '112', '113', '114', '115/116', '117',
  '118', '119', '120', '121', '122', '123', '124', '125',
  '126', '127', '128/129', '130', '131', '132', '133', '134', '135',
]

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function MaintenancePage() {
  const [tasks, setTasks] = useState<MaintenanceTask[]>(() => loadTasks())
  const [showForm, setShowForm] = useState(false)
  const [editingTask, setEditingTask] = useState<MaintenanceTask | null>(null)
  const [filterSuite, setFilterSuite] = useState<string>('')
  const [dragId, setDragId] = useState<string | null>(null)

  const persist = useCallback((next: MaintenanceTask[]) => {
    setTasks(next)
    saveTasks(next)
  }, [])

  const addTask = useCallback((task: Omit<MaintenanceTask, 'id' | 'dateCreated'>) => {
    const newTask: MaintenanceTask = {
      ...task,
      id: newTaskId(),
      dateCreated: new Date().toISOString().split('T')[0],
    }
    persist([...tasks, newTask])
    setShowForm(false)
  }, [tasks, persist])

  const updateTask = useCallback((updated: MaintenanceTask) => {
    persist(tasks.map(t => t.id === updated.id ? updated : t))
    setEditingTask(null)
  }, [tasks, persist])

  const deleteTask = useCallback((id: string) => {
    if (confirm('Delete this maintenance task?')) {
      persist(tasks.filter(t => t.id !== id))
      setEditingTask(null)
    }
  }, [tasks, persist])

  const moveTask = useCallback((taskId: string, newStatus: TaskStatus) => {
    persist(tasks.map(t => {
      if (t.id !== taskId) return t
      const update: Partial<MaintenanceTask> = { status: newStatus }
      if (newStatus === 'complete' && !t.dateCompleted) {
        update.dateCompleted = new Date().toISOString().split('T')[0]
      }
      if (newStatus !== 'complete') {
        update.dateCompleted = undefined
      }
      return { ...t, ...update }
    }))
  }, [tasks, persist])

  // Filter
  const filtered = useMemo(() => {
    if (!filterSuite) return tasks
    return tasks.filter(t => t.suite === filterSuite)
  }, [tasks, filterSuite])

  // Stats
  const stats = useMemo(() => {
    const open = tasks.filter(t => t.status !== 'complete')
    const overdue = open.filter(isOverdue)
    const totalEstimated = open.reduce((s, t) => s + (t.estimatedCost || 0), 0)
    const completedThisMonth = tasks.filter(t => {
      if (t.status !== 'complete' || !t.dateCompleted) return false
      const now = new Date()
      const d = new Date(t.dateCompleted)
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    })
    const totalSpent = completedThisMonth.reduce((s, t) => s + (t.actualCost || 0), 0)
    return { open: open.length, overdue: overdue.length, totalEstimated, totalSpent }
  }, [tasks])

  // Drag handlers
  const handleDragStart = (taskId: string) => setDragId(taskId)
  const handleDragEnd = () => setDragId(null)
  const handleDrop = (status: TaskStatus) => {
    if (dragId) { moveTask(dragId, status); setDragId(null) }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
            >
              <ChevronLeft size={16} /> Rent Tracker
            </Link>
            <div className="h-5 w-px bg-gray-300" />
            <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Wrench size={20} className="text-slate-600" />
              Maintenance Board
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {/* Suite filter */}
            <select
              value={filterSuite}
              onChange={e => setFilterSuite(e.target.value)}
              className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white"
            >
              <option value="">All Suites</option>
              {SUITES.map(s => (
                <option key={s} value={s}>{s === 'Building' ? 'Building-wide' : `Suite ${s}`}</option>
              ))}
            </select>
            <button
              onClick={() => { setEditingTask(null); setShowForm(true) }}
              className="px-4 py-2 bg-slate-700 text-white text-sm font-medium rounded-lg hover:bg-slate-800 flex items-center gap-1.5"
            >
              <Plus size={16} /> New Task
            </button>
          </div>
        </div>
      </header>

      {/* Stats bar */}
      <div className="max-w-[1600px] mx-auto px-4 py-3">
        <div className="flex gap-4 text-sm">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white rounded-lg border border-gray-200">
            <Wrench size={14} className="text-gray-500" />
            <span className="font-semibold">{stats.open}</span>
            <span className="text-gray-500">open</span>
          </div>
          {stats.overdue > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 rounded-lg border border-red-200">
              <AlertTriangle size={14} className="text-red-500" />
              <span className="font-semibold text-red-700">{stats.overdue}</span>
              <span className="text-red-500">overdue</span>
            </div>
          )}
          {stats.totalEstimated > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white rounded-lg border border-gray-200">
              <DollarSign size={14} className="text-gray-500" />
              <span className="text-gray-500">Est.</span>
              <span className="font-semibold">${stats.totalEstimated.toLocaleString()}</span>
            </div>
          )}
          {stats.totalSpent > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 rounded-lg border border-green-200">
              <CheckCircle2 size={14} className="text-green-600" />
              <span className="text-green-600">Spent this month:</span>
              <span className="font-semibold text-green-700">${stats.totalSpent.toLocaleString()}</span>
            </div>
          )}
        </div>
      </div>

      {/* Kanban Board */}
      <div className="max-w-[1600px] mx-auto px-4 pb-6">
        <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: 'calc(100vh - 160px)' }}>
          {STATUS_COLUMNS.map(col => {
            const colTasks = filtered
              .filter(t => t.status === col.key)
              .sort((a, b) => taskSortKey(a) - taskSortKey(b))

            return (
              <div
                key={col.key}
                className="flex-shrink-0 w-[300px] flex flex-col"
                onDragOver={e => e.preventDefault()}
                onDrop={() => handleDrop(col.key)}
              >
                {/* Column header */}
                <div className="flex items-center gap-2 mb-3 px-1">
                  <div className="w-3 h-3 rounded-full" style={{ background: col.color }} />
                  <span className="font-semibold text-sm text-gray-700">{col.label}</span>
                  <span className="text-xs text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">
                    {colTasks.length}
                  </span>
                </div>

                {/* Cards */}
                <div className="flex-1 bg-gray-100/50 rounded-xl p-2 space-y-2 min-h-[200px]">
                  {colTasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onEdit={() => setEditingTask(task)}
                      onDragStart={() => handleDragStart(task.id)}
                      onDragEnd={handleDragEnd}
                      isDragging={dragId === task.id}
                    />
                  ))}

                  {col.key === 'new' && colTasks.length === 0 && (
                    <button
                      onClick={() => { setEditingTask(null); setShowForm(true) }}
                      className="w-full py-8 border-2 border-dashed border-gray-300 rounded-lg text-gray-400 hover:text-gray-600 hover:border-gray-400 flex flex-col items-center gap-1 text-sm transition-colors"
                    >
                      <Plus size={20} />
                      Add first task
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Modals */}
      {(showForm || editingTask) && (
        <TaskFormModal
          task={editingTask}
          onSave={editingTask ? updateTask : addTask}
          onDelete={editingTask ? () => deleteTask(editingTask.id) : undefined}
          onClose={() => { setShowForm(false); setEditingTask(null) }}
        />
      )}
    </div>
  )
}

// ─── Task Card ───────────────────────────────────────────────────────────────
function TaskCard({
  task, onEdit, onDragStart, onDragEnd, isDragging,
}: {
  task: MaintenanceTask
  onEdit: () => void
  onDragStart: () => void
  onDragEnd: () => void
  isDragging: boolean
}) {
  const overdue = isOverdue(task)
  const dueSoon = isDueSoon(task)
  const pri = PRIORITY_CONFIG[task.priority]
  const cost = task.status === 'complete' ? task.actualCost : task.estimatedCost
  const bestQuote = task.quotes.length > 0
    ? Math.min(...task.quotes.map(q => q.amount))
    : 0

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onEdit}
      className={`
        bg-white rounded-lg border shadow-sm p-3 cursor-pointer
        hover:shadow-md transition-shadow select-none
        ${isDragging ? 'opacity-40' : ''}
        ${overdue ? 'border-red-300 ring-1 ring-red-200' : 'border-gray-200'}
      `}
    >
      {/* Priority + Category row */}
      <div className="flex items-center justify-between mb-1.5">
        <span
          className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded"
          style={{ color: pri.color, background: pri.bg }}
        >
          {pri.label}
        </span>
        <span className="text-[10px] text-gray-400">{task.category}</span>
      </div>

      {/* Title */}
      <h4 className="text-sm font-semibold text-gray-900 mb-1 leading-tight">{task.title}</h4>

      {/* Suite + Tenant */}
      <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
        <span className="flex items-center gap-0.5">
          <MapPin size={11} />
          {task.suite === 'Building' ? 'Building' : `Suite ${task.suite}`}
        </span>
        {task.tenantName && (
          <span className="flex items-center gap-0.5">
            <User size={11} />
            {task.tenantName}
          </span>
        )}
      </div>

      {/* Bottom row: due date, cost, vendor */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          {task.dueDate && (
            <span className={`flex items-center gap-0.5 ${
              overdue ? 'text-red-600 font-semibold' : dueSoon ? 'text-amber-600' : 'text-gray-400'
            }`}>
              {overdue && <AlertTriangle size={11} />}
              {!overdue && <Calendar size={11} />}
              {new Date(task.dueDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          )}
          {task.vendorName && (
            <span className="text-gray-400 truncate max-w-[80px]">{task.vendorName}</span>
          )}
        </div>
        {(cost > 0 || bestQuote > 0) && (
          <span className="font-semibold text-gray-700">
            ${(cost || bestQuote).toLocaleString()}
          </span>
        )}
      </div>

      {/* Quote count badge */}
      {task.quotes.length > 1 && (
        <div className="mt-1.5 text-[10px] text-blue-600 bg-blue-50 rounded px-1.5 py-0.5 inline-block">
          {task.quotes.length} quotes
        </div>
      )}
    </div>
  )
}

// ─── Task Form Modal ─────────────────────────────────────────────────────────
function TaskFormModal({
  task, onSave, onDelete, onClose,
}: {
  task: MaintenanceTask | null
  onSave: (task: any) => void
  onDelete?: () => void
  onClose: () => void
}) {
  const isEditing = !!task
  const [form, setForm] = useState(() => {
    if (task) return { ...task }
    return {
      ...createBlankTask(),
      quotes: [] as { vendor: string; phone: string; amount: number; notes: string; date: string }[],
    }
  })
  const [showQuoteForm, setShowQuoteForm] = useState(false)
  const [quoteForm, setQuoteForm] = useState({ vendor: '', phone: '', amount: '', notes: '', date: '' })

  const set = (key: string, val: any) => setForm((f: any) => ({ ...f, [key]: val }))

  const addQuote = () => {
    if (!quoteForm.vendor || !quoteForm.amount) return
    set('quotes', [...(form.quotes || []), {
      vendor: quoteForm.vendor,
      phone: quoteForm.phone,
      amount: parseFloat(quoteForm.amount),
      notes: quoteForm.notes,
      date: quoteForm.date || new Date().toISOString().split('T')[0],
    }])
    setQuoteForm({ vendor: '', phone: '', amount: '', notes: '', date: '' })
    setShowQuoteForm(false)
  }

  const removeQuote = (idx: number) => {
    set('quotes', form.quotes.filter((_: any, i: number) => i !== idx))
  }

  const canSave = form.title && form.suite

  const handleSave = () => {
    if (!canSave) return
    onSave({
      ...form,
      estimatedCost: parseFloat(String(form.estimatedCost)) || 0,
      actualCost: parseFloat(String(form.actualCost)) || 0,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[5vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">
            {isEditing ? 'Edit Task' : 'New Maintenance Task'}
          </h3>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
            <X size={20} />
          </button>
        </div>

        {/* Form body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Title */}
          <div>
            <label className="text-xs font-semibold text-gray-600 uppercase mb-1 block">Task Title *</label>
            <input
              type="text"
              value={form.title}
              onChange={e => set('title', e.target.value)}
              placeholder="e.g. Fix leaking faucet in Suite 103"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-slate-500 focus:border-transparent"
              autoFocus
            />
          </div>

          {/* Suite + Tenant + Category row */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-600 uppercase mb-1 block">Suite *</label>
              <select
                value={form.suite}
                onChange={e => set('suite', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
              >
                <option value="">Select...</option>
                {SUITES.map(s => (
                  <option key={s} value={s}>{s === 'Building' ? 'Building-wide' : s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-600 uppercase mb-1 block">Tenant</label>
              <input
                type="text"
                value={form.tenantName}
                onChange={e => set('tenantName', e.target.value)}
                placeholder="Tenant name"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-600 uppercase mb-1 block">Category</label>
              <select
                value={form.category}
                onChange={e => set('category', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
              >
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          {/* Priority + Status + Due Date */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-600 uppercase mb-1 block">Priority</label>
              <select
                value={form.priority}
                onChange={e => set('priority', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
              >
                <option value="urgent">🔴 Urgent</option>
                <option value="high">🟠 High</option>
                <option value="medium">🟡 Medium</option>
                <option value="low">🟢 Low</option>
              </select>
            </div>
            {isEditing && (
              <div>
                <label className="text-xs font-semibold text-gray-600 uppercase mb-1 block">Status</label>
                <select
                  value={form.status}
                  onChange={e => set('status', e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  {STATUS_COLUMNS.map(c => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="text-xs font-semibold text-gray-600 uppercase mb-1 block">Due Date</label>
              <input
                type="date"
                value={form.dueDate}
                onChange={e => set('dueDate', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-semibold text-gray-600 uppercase mb-1 block">Description</label>
            <textarea
              value={form.description}
              onChange={e => set('description', e.target.value)}
              rows={2}
              placeholder="What needs to be done?"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none"
            />
          </div>

          {/* Vendor Info */}
          <div className="border-t pt-4">
            <h4 className="text-xs font-semibold text-gray-600 uppercase mb-2 flex items-center gap-1">
              <Phone size={12} /> Vendor / Contractor
            </h4>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                value={form.vendorName}
                onChange={e => set('vendorName', e.target.value)}
                placeholder="Vendor name"
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              <input
                type="tel"
                value={form.vendorPhone}
                onChange={e => set('vendorPhone', e.target.value)}
                placeholder="Phone number"
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Quotes */}
          <div className="border-t pt-4">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-gray-600 uppercase flex items-center gap-1">
                <FileText size={12} /> Quotes
              </h4>
              <button
                onClick={() => setShowQuoteForm(true)}
                className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-0.5"
              >
                <Plus size={12} /> Add Quote
              </button>
            </div>
            {form.quotes && form.quotes.length > 0 && (
              <div className="space-y-2 mb-2">
                {form.quotes.map((q: any, i: number) => (
                  <div key={i} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm">
                    <div>
                      <span className="font-medium">{q.vendor}</span>
                      {q.phone && <span className="text-gray-400 ml-2">{q.phone}</span>}
                      <span className="text-green-700 font-semibold ml-2">${q.amount.toLocaleString()}</span>
                      {q.notes && <span className="text-gray-400 ml-2">— {q.notes}</span>}
                    </div>
                    <button onClick={() => removeQuote(i)} className="text-gray-400 hover:text-red-500">
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {showQuoteForm && (
              <div className="bg-blue-50 rounded-lg p-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={quoteForm.vendor}
                    onChange={e => setQuoteForm(f => ({ ...f, vendor: e.target.value }))}
                    placeholder="Vendor name *"
                    className="border border-gray-300 rounded px-2 py-1.5 text-sm"
                  />
                  <input
                    type="tel"
                    value={quoteForm.phone}
                    onChange={e => setQuoteForm(f => ({ ...f, phone: e.target.value }))}
                    placeholder="Phone"
                    className="border border-gray-300 rounded px-2 py-1.5 text-sm"
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <input
                    type="number"
                    step="0.01"
                    value={quoteForm.amount}
                    onChange={e => setQuoteForm(f => ({ ...f, amount: e.target.value }))}
                    placeholder="Amount *"
                    className="border border-gray-300 rounded px-2 py-1.5 text-sm"
                  />
                  <input
                    type="date"
                    value={quoteForm.date}
                    onChange={e => setQuoteForm(f => ({ ...f, date: e.target.value }))}
                    className="border border-gray-300 rounded px-2 py-1.5 text-sm"
                  />
                  <input
                    type="text"
                    value={quoteForm.notes}
                    onChange={e => setQuoteForm(f => ({ ...f, notes: e.target.value }))}
                    placeholder="Notes"
                    className="border border-gray-300 rounded px-2 py-1.5 text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={addQuote}
                    disabled={!quoteForm.vendor || !quoteForm.amount}
                    className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    Add Quote
                  </button>
                  <button
                    onClick={() => setShowQuoteForm(false)}
                    className="px-3 py-1.5 text-gray-500 text-xs hover:text-gray-700"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Cost + Materials */}
          <div className="border-t pt-4">
            <h4 className="text-xs font-semibold text-gray-600 uppercase mb-2 flex items-center gap-1">
              <DollarSign size={12} /> Cost & Materials
            </h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-0.5 block">Estimated Cost</label>
                <input
                  type="number"
                  step="0.01"
                  value={form.estimatedCost || ''}
                  onChange={e => set('estimatedCost', e.target.value)}
                  placeholder="$0.00"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-0.5 block">Actual Cost</label>
                <input
                  type="number"
                  step="0.01"
                  value={form.actualCost || ''}
                  onChange={e => set('actualCost', e.target.value)}
                  placeholder="$0.00"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="mt-2">
              <label className="text-xs text-gray-500 mb-0.5 block">Materials / Parts</label>
              <input
                type="text"
                value={form.materials}
                onChange={e => set('materials', e.target.value)}
                placeholder="e.g. replacement faucet, pipe fittings, silicone"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Notes */}
          <div className="border-t pt-4">
            <label className="text-xs font-semibold text-gray-600 uppercase mb-1 block">Notes</label>
            <textarea
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              rows={2}
              placeholder="Additional details, scheduling notes, etc."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between">
          <div>
            {onDelete && (
              <button
                onClick={onDelete}
                className="px-3 py-2 text-red-600 text-sm hover:text-red-800 hover:bg-red-50 rounded-lg"
              >
                Delete Task
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-gray-600 text-sm hover:bg-gray-100 rounded-lg">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="px-5 py-2 bg-slate-700 text-white text-sm font-medium rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isEditing ? 'Save Changes' : 'Create Task'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
