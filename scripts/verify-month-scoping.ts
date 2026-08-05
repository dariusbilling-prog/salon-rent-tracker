import * as fs from 'fs'
import { parseAndMatchCSV } from '@/lib/csv-parser'
import { createEmptyMonth, mergeCSVIntoMonth, MonthData } from '@/lib/month-data'
import { TENANTS } from '@/lib/tenant-data'
import { Tenant } from '@/types'
const roster: Tenant[] = TENANTS.map(t => {
  if (t.suiteNumber === '124') return { ...t, id:'ines', name:'Ines Martinez', weeklyRent:250, billingFrequency:'monthly' as const, monthlyRent:1083.33, isActive:true }
  if (t.suiteNumber === '134') return { ...t, weeklyRent:250, billingFrequency:'monthly' as const, monthlyRent:1083 }
  return t })
const r = parseAndMatchCSV(fs.readFileSync(process.argv[2] || './tx.csv','utf8'), roster)
const sum = (m: MonthData): number => {
  let total = 0
  for (const entries of Object.values(m.weeks)) for (const e of entries) total += e.amountPaid || 0
  return Math.round(total * 100) / 100
}
const jul = mergeCSVIntoMonth(createEmptyMonth('2026-07', roster), r.matched, roster)
const aug = mergeCSVIntoMonth(createEmptyMonth('2026-08', roster), r.matched, roster)
const sep = mergeCSVIntoMonth(createEmptyMonth('2026-06', roster), r.matched, roster)
let p=0,f=0; const ck=(n:string,g:any,w:any)=>{const ok=g===w;console.log(`${ok?'PASS':'FAIL'}  ${n}  got ${g}`);ok?p++:f++}
ck('July takes the July CSV', sum(jul), 22321.33)
ck('August takes nothing from a July CSV', sum(aug), 0)
ck('June takes nothing either', sum(sep), 0)
console.log(`${p} passed, ${f} failed`); process.exit(f?1:0)
