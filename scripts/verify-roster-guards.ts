import { findSuiteOccupant, deleteTenant, archiveTenant } from '@/lib/tenant-manager'
import { Tenant } from '@/types'
// storage shims — these helpers persist as a side effect
;(globalThis as any).window = { localStorage: { setItem(){}, getItem(){return null}, length:0, key(){return null} } }
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const T=(id:string,suite:string,rent:number,active=true,arch=false):Tenant=>
 ({id,name:'T'+id,suiteNumber:suite,weeklyRent:rent,billingFrequency:'weekly',isActive:active,isArchived:arch})

let pass=0,fail=0
const ck=(n:string,g:any,w:any)=>{const ok=JSON.stringify(g)===JSON.stringify(w)
 console.log(`${ok?'PASS':'FAIL'}  ${n}${ok?'':`  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`);ok?pass++:fail++}

const INES = T('ines','124',1083.33)
const VACANT = T('v','126',260,false)
const roster = [INES, VACANT]

ck('occupied suite is detected', findSuiteOccupant(roster,'124')?.id, 'ines')
ck('a vacant suite reports no occupant', findSuiteOccupant(roster,'126'), undefined)
ck('an unknown suite reports no occupant', findSuiteOccupant(roster,'999'), undefined)

// archiving the only occupant leaves a vacant placeholder
const after1 = archiveTenant([INES], 'ines', '2026-08-31')
ck('sole occupant leaves -> suite goes vacant', after1.filter(t=>t.suiteNumber==='124' && !t.isArchived && !t.isActive).length, 1)

// archiving a duplicate must NOT invent a vacant row beside the remaining tenant
const DUPE = T('dupe','124',250)
const after2 = archiveTenant([INES, DUPE], 'dupe', '2026-08-31')
ck('duplicate leaves -> no phantom Vacant row', after2.filter(t=>t.name==='Vacant').length, 0)
ck('...and the real tenant stays active', after2.find(t=>t.id==='ines')?.isActive, true)

// delete removes outright
const after3 = deleteTenant([INES, DUPE], 'dupe')
ck('delete removes the record', after3.map(t=>t.id), ['ines'])
ck('delete leaves no placeholder behind', after3.length, 1)

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0)
