import { createEmptyMonth, recalcMonthDues, MonthData } from '@/lib/month-data'
import {
  planAllocation, applyPaymentAcross, openWeeksFor, MonthBook,
  matchTenantBySuite, suiteAlternatives,
} from '@/lib/payment-allocation'
import { monthlyWeekShare } from '@/lib/utils'
import { Tenant } from '@/types'

const T = (id: string, suite: string, rent: number, freq: any = 'weekly', monthly?: number): Tenant =>
  ({ id, name: 'T' + id, suiteNumber: suite, weeklyRent: rent, billingFrequency: freq, monthlyRent: monthly, isActive: true })

const KELLEY = T('132', '132', 235)
const LAUREN = T('120', '120/123', 450)
const COURTNEY = T('127', '127', 350)
const NANCY = T('126', '126', 260)
const CAMILLE = T('128', '128/129', 350)
const ASHLEY = T('108', '106/108', 450, 'monthly', 1900)
const TENANTS = [KELLEY, LAUREN, COURTNEY, NANCY, CAMILLE, ASHLEY]

let pass = 0, fail = 0
const check = (name: string, got: any, want: any) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}
const book = (): MonthBook => ({
  '2026-07': createEmptyMonth('2026-07', TENANTS),
  '2026-08': createEmptyMonth('2026-08', TENANTS),
})
const paidOn = (b: MonthBook, mk: string, fri: string, id: string) =>
  b[mk].weeks[fri].find(e => e.tenant.id === id)!.amountPaid

// ---- 1. Two checks, same tenant, same week: must SUM not overwrite -------
{
  let b = book()
  const wk = { monthKey: '2026-07', friday: '2026-07-31' }
  let r = applyPaymentAcross(b, [wk], KELLEY.id, 100, { paymentType: 'Check', checkNumber: '250' })
  r = applyPaymentAcross(r.book, [wk], KELLEY.id, 135, { paymentType: 'Check', checkNumber: '248' })
  check('two checks on one week sum to $235', paidOn(r.book, '2026-07', '2026-07-31', KELLEY.id), 235)
  check('both check numbers survive', r.book['2026-07'].weeks['2026-07-31'].find(e => e.tenant.id === KELLEY.id)!.checkNumber, '250, 248')
}

// ---- 2. Payment onto an ALREADY PAID week must not erase it --------------
{
  let b = book()
  const wk = { monthKey: '2026-07', friday: '2026-07-24' }
  let r = applyPaymentAcross(b, [wk], LAUREN.id, 450, { paymentType: 'Check', checkNumber: '385' })
  const before = paidOn(r.book, '2026-07', '2026-07-24', LAUREN.id)
  r = applyPaymentAcross(r.book, [wk], LAUREN.id, 450, { paymentType: 'Check', checkNumber: '1386' })
  check('paid week keeps its $450', paidOn(r.book, '2026-07', '2026-07-24', LAUREN.id), before)
  check('the second $450 is returned as leftover, not lost', r.leftover, 450)
}

// ---- 3. Courtney: $650 + $650 -> credits must total $600 -----------------
{
  let b = book()
  let credits = 0
  for (const chk of ['3040', '3039']) {
    const open = openWeeksFor(b, COURTNEY.id)
    const plan = planAllocation(b, COURTNEY.id, 650, open)
    const r = applyPaymentAcross(b, plan.weeks.slice(0, 1), COURTNEY.id, 650, { paymentType: 'Check', checkNumber: chk })
    b = r.book; credits += r.leftover
  }
  check('two $650 cheques leave $600 credit (was $300)', credits, 600)
}

// ---- 4. Cross-month: August-dated deposit fills a JULY week --------------
{
  let b = book()
  const plan = planAllocation(b, NANCY.id, 520)
  check('$520 auto-plans onto two weeks', plan.weeks.length, 2)
  check('oldest-first starts in July', plan.weeks[0].monthKey, '2026-07')
  const r = applyPaymentAcross(b, plan.weeks, NANCY.id, 520, { paymentType: 'Check', checkNumber: '284' })
  check('nothing left over', r.leftover, 0)
  check('July was written to', r.touched.includes('2026-07'), true)
}
{
  // a tenant whose July is settled must roll into August
  let b = book()
  const julyFris = Object.keys(b['2026-07'].weeks).sort()
  let r = applyPaymentAcross(b, julyFris.map(f => ({ monthKey: '2026-07', friday: f })), KELLEY.id, 235 * 5, { paymentType: 'Check' })
  const plan = planAllocation(r.book, KELLEY.id, 235)
  check('money rolls forward into next month', plan.weeks[0].monthKey, '2026-08')
}

// ---- 5. OCR cross-check: 128 vs 126 -------------------------------------
{
  const matched = matchTenantBySuite(TENANTS, '128')
  check('bare "128" matches Camille', matched?.id, CAMILLE.id)
  const alts = suiteAlternatives(TENANTS, '128', 520, matched)
  check('$520 flags suite 126 as the likely read', alts.map(a => a.suiteNumber), ['126'])
  const noAlts = suiteAlternatives(TENANTS, '132', 470, matchTenantBySuite(TENANTS, '132'))
  check('a clean divide raises no flag', noAlts.length, 0)
  check('stray "1" no longer matches 120/123', matchTenantBySuite(TENANTS, '1'), undefined)
}

// ---- 6. Monthly tenant: flat $1,900 across 4 and 5 Friday months ---------
{
  const july = createEmptyMonth('2026-07', TENANTS)   // 5 Fridays
  const aug  = createEmptyMonth('2026-08', TENANTS)   // 4 Fridays
  const sum = (m: MonthData) => Object.values(m.weeks)
    .reduce((s, es) => s + es.find(e => e.tenant.id === ASHLEY.id)!.amountDue, 0)
  check('July (5 Fridays) totals $1,900', sum(july), 1900)
  check('August (4 Fridays) totals $1,900', sum(aug), 1900)
  check('weekly shares still sum exactly', monthlyWeekShare(1900, 3, 0) + monthlyWeekShare(1900, 3, 1) + monthlyWeekShare(1900, 3, 2), 1900)
  const r = applyPaymentAcross({ '2026-07': july }, Object.keys(july.weeks).sort().map(f => ({ monthKey: '2026-07', friday: f })), ASHLEY.id, 1900, { paymentType: 'Check', checkNumber: '1014' })
  check('$1,900 settles her whole month with nothing left', r.leftover, 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
