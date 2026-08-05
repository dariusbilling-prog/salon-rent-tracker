import { createEmptyMonth, reconcileMonthRoster, MonthData } from '@/lib/month-data'
import { Tenant } from '@/types'

const T = (id:string,suite:string,rent:number,active=true,archived=false):Tenant =>
  ({id,name:'T'+id,suiteNumber:suite,weeklyRent:rent,billingFrequency:'weekly',isActive:active,isArchived:archived})

let pass=0, fail=0
const ck=(n:string,g:any,w:any)=>{const ok=JSON.stringify(g)===JSON.stringify(w);
  console.log(`${ok?'PASS':'FAIL'}  ${n}${ok?'':`\n        got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`); ok?pass++:fail++}

const VACANT124 = T('v1','124',265,false)
const NANCY = T('23','126',260)
const before = [NANCY, VACANT124]

// July built while 124 was vacant
let july = createEmptyMonth('2026-07', before)
const row = (m:MonthData,fri:string,suite:string)=>m.weeks[fri].find(e=>e.tenant.suiteNumber===suite)
ck('124 starts vacant', row(july,'2026-07-03','124')!.isVacant, true)

// Ines moves in -> vacant placeholder replaced by a real tenant
const INES = T('ines','124',265)
const after = [NANCY, INES]
july = reconcileMonthRoster(july, after)
ck('124 now shows Ines', row(july,'2026-07-03','124')!.tenant.name, 'Tines')
ck('124 no longer vacant', row(july,'2026-07-03','124')!.isVacant, false)
ck('Ines owes rent in July', row(july,'2026-07-03','124')!.amountDue, 265)
ck('all 5 July weeks updated', Object.keys(july.weeks).every(f=>!row(july,f,'124')!.isVacant), true)
ck('no duplicate 124 rows', july.weeks['2026-07-03'].filter(e=>e.tenant.suiteNumber==='124').length, 1)
ck('rows stay in suite order', july.weeks['2026-07-03'].map(e=>e.tenant.suiteNumber), ['124','126'])

// Money is never destroyed when someone leaves the roster
let aug = createEmptyMonth('2026-08', after)
aug.weeks['2026-08-07'] = aug.weeks['2026-08-07'].map(e =>
  e.tenant.suiteNumber==='124' ? {...e, amountPaid:265, status:'paid' as const} : e)
const movedOut = [NANCY, T('ines','124',265,false,true), T('v2','124',265,false)]
const aug2 = reconcileMonthRoster(aug, movedOut)
const paidRow = aug2.weeks['2026-08-07'].find(e=>e.amountPaid>0)
ck('a paid week survives the tenant leaving', paidRow?.amountPaid, 265)
ck('no vacant row shoved in beside the paid one',
   aug2.weeks['2026-08-07'].filter(e=>e.tenant.suiteNumber==='124').length, 1)

// An unpaid week does flip to vacant
const aug3 = reconcileMonthRoster(aug, movedOut)
ck('unpaid later week goes vacant', aug3.weeks['2026-08-14'].find(e=>e.tenant.suiteNumber==='124')!.isVacant, true)

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0)
