import * as fs from 'fs'
import { parseAndMatchCSV } from '@/lib/csv-parser'
import { createEmptyMonth, mergeCSVIntoMonth } from '@/lib/month-data'
import { TENANTS } from '@/lib/tenant-data'
import { Tenant } from '@/types'

;(globalThis as any).window = undefined
const roster: Tenant[] = TENANTS.map(t => {
  if (t.suiteNumber === '124') return { ...t, id:'ines', name:'Ines Martinez', weeklyRent:250,
    billingFrequency:'monthly' as const, monthlyRent:1083.33, isActive:true }
  if (t.suiteNumber === '134') return { ...t, weeklyRent:250,
    billingFrequency:'monthly' as const, monthlyRent:1083 }
  return t
})

const r = parseAndMatchCSV(fs.readFileSync(process.argv[2] || './tx.csv','utf8'), roster)
const july = mergeCSVIntoMonth(createEmptyMonth('2026-07', roster), r.matched, roster)

let pass=0, fail=0
const ck=(n:string,g:any,w:any)=>{const ok=JSON.stringify(g)===JSON.stringify(w)
 console.log(`${ok?'PASS':'FAIL'}  ${n}${ok?'':`  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`);ok?pass++:fail++}
const tot=(s:string)=>Math.round(Object.values(july.weeks)
  .reduce((a,es)=>a+(es.find(e=>e.tenant.suiteNumber===s)?.amountPaid||0),0)*100)/100

console.log('Zedrick 134 per week:', Object.keys(july.weeks).sort()
  .map(f=>july.weeks[f].find(e=>e.tenant.suiteNumber==='134')?.amountPaid))
console.log('Ines 124 per week:   ', Object.keys(july.weeks).sort()
  .map(f=>july.weeks[f].find(e=>e.tenant.suiteNumber==='124')?.amountPaid))

ck('Zedrick recorded once, not 5x', tot('134'), 1083)
ck('Ines recorded once, not 5x', tot('124'), 1083.33)
ck('suite 135 takes the $425 TenantCloud billed', tot('135'), 425*5)
ck('...and reads Partial against the real $450', 
   july.weeks['2026-07-31'].find(e=>e.tenant.suiteNumber==='135')?.status, 'partial')

const pendingWeeks = Object.values(july.weeks).flat().filter(e=>(e.pendingAmount||0)>0)
ck('pending flows into the month', pendingWeeks.length > 0, true)
ck('pending rows say ACH Pending, not Card Processed',
   pendingWeeks.every(e=>e.confirmation==='ACH Pending'), true)

const grand = Math.round(Object.values(july.weeks).flat().reduce((a,e)=>a+e.amountPaid,0)*100)/100
console.log('\nJuly total recorded from this CSV: $'+grand)
console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0)
