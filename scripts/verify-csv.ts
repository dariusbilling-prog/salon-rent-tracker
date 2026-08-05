import * as fs from 'fs'
import { parseAndMatchCSV } from '@/lib/csv-parser'
import { TENANTS } from '@/lib/tenant-data'
import { Tenant } from '@/types'

const csvPath = process.argv[2]
if (!csvPath) {
  console.log('Usage: npx tsx scripts/verify-csv.ts <TenantCloud-export.csv>')
  process.exit(0)
}
const csv = fs.readFileSync(csvPath, 'utf8')
// Roster with Ines moved into 124 (monthly $1,083.33) as she really is
const roster: Tenant[] = TENANTS.map(t =>
  t.suiteNumber === '124'
    ? { ...t, id: 'ines', name: 'Ines Martinez', weeklyRent: 250,
        billingFrequency: 'monthly' as const, monthlyRent: 1083.33, isActive: true }
    : t)

const r = parseAndMatchCSV(csv, roster)
let pass = 0, fail = 0
const ck = (n: string, g: any, w: any) => { const ok = JSON.stringify(g) === JSON.stringify(w)
  console.log(`${ok?'PASS':'FAIL'}  ${n}${ok?'':`  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`); ok?pass++:fail++ }

const pend = r.matched.filter(m => m.pendingAmount > 0)
console.log(`\nmatched ${r.matched.length} · unmatched ${r.unmatched.length} · skipped ${r.skipped.length}`)
console.log('PENDING rows detected:')
for (const m of pend.sort((a,b)=>a.dueDate.localeCompare(b.dueDate)))
  console.log(`   ${m.dueDate}  ${m.tenant.suiteNumber.padEnd(8)} ${m.tenant.name.padEnd(22)} $${m.pendingAmount}  settles ${m.paidDate}  [${m.statuses}]`)

ck('pending rows found', pend.length, 10)
ck('every pending carries a settlement date', pend.every(m => !!m.paidDate), true)
ck('Void rows skipped', r.skipped.filter(s=>s.reason==='Voided transaction').length, 9)
ck('the $60 TenantCloud software expense is excluded',
   r.matched.some(m => m.amount === 60), false)
ck('Overdue skipped', r.skipped.filter(s=>s.reason.includes('Overdue')).length, 2)
ck('Open row (zero paid) skipped', r.skipped.filter(s=>s.reason==='Invalid or zero amount').length >= 1, true)

const ines = r.matched.filter(m => m.tenant.suiteNumber === '124')
ck('Ines matched on suite 124', ines.length, 1)
ck('Ines amount', ines[0]?.amount, 1083.33)
ck('Ines flagged monthly', ines[0]?.isMonthlyPayment, true)
ck('Ines is not pending', ines[0]?.pendingAmount, 0)

// Suite 135 is three stylists splitting one week
const s135 = r.matched.filter(m => m.tenant.suiteNumber === '135' && m.dueDate === '2026-07-31')
ck('suite 135 combines its 3 split payments', s135[0]?.amount, 425)
ck('...and reports the split as pending when one leg is', s135[0]?.pendingAmount, 141.67)

console.log(`\n${pass} passed, ${fail} failed`)
