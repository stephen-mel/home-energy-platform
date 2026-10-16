import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import ts from 'typescript';import * as crypto from 'node:crypto';
const importAccount='a'.repeat(64),exportAccount='b'.repeat(64),importMeter='c'.repeat(64),exportMeter='d'.repeat(64);
const now='2026-10-15T10:00:00.000Z',domain={start:now,end:'2026-10-16T10:00:00.000Z'};
const price=amount=>({amount,currency:'GBP',unit:'kWh'});
const site=()=>({id:'home',name:'Home',integrations:{kraken:{enabled:true,wholeHomeDispatchRate:{enabled:true,importPrice:null},
  importTariffIdentity:{accountRef:importAccount,tariffCode:'IMPORT',meterPointRef:importMeter},
  exportTariffIdentity:{accountRef:exportAccount,meterPointRef:exportMeter,productCode:'EXPORT_PRODUCT',tariffCode:'EXPORT'},
  fixedExportAssumption:{provider:'eon-next',tariff:'Export Premium v3',price:price(.175)}},homeAssistant:{enabled:false},tesla:{enabled:true,energySiteId:'1'}},
  tariff:{timeZone:'Europe/London',normalImport:null,export:null,versions:[]},constraints:{maxImportKw:null,maxExportKw:null}});
const version={id:'import',name:'Import',provider:'eon-next-kraken',effectiveFrom:'2026-01-01T00:00:00.000Z',effectiveTo:'2027-01-01T00:00:00.000Z',pricesIncludeVat:true,
 normalImport:price(.23978),export:null,scheduledChargingImport:price(.0285),standingCharge:null,
 dailyImportWindows:[{start:'00:00',end:'06:00',kind:'guaranteed-off-peak',price:price(.0285)}]};
const state=()=>({vehicles:[],lastSuccessfulUpdate:now,stale:false,importTariff:{status:'available',accountRef:importAccount,observedAt:now,exportStatus:'unknown',
 agreement:{validFrom:'2026-01-01T00:00:00.000Z',validTo:'2027-01-01T00:00:00.000Z',productCode:'IMPORT_PRODUCT',tariffCode:'IMPORT',meterPointRef:importMeter},version},
 exportTariff:{status:'available',accountRef:exportAccount,observedAt:now,agreement:{validFrom:'2026-01-01T00:00:00.000Z',validTo:'2027-01-01T00:00:00.000Z',productCode:'EXPORT_PRODUCT',tariffCode:'EXPORT',meterPointRef:exportMeter},price:price(.175)}});
function graph(kraken=state()) { let calls=0;const modules=new Map(),root=process.cwd(),mocks=new Map([[path.resolve(root,'src/lib/site/kraken-state.ts'),{getKrakenState:async()=>{calls++;return structuredClone(kraken);}}]]);
 function load(file){file=path.resolve(file);if(mocks.has(file))return mocks.get(file);if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {exports,structuredClone,Date,Error,Intl,Object,Array,Number,String,Boolean,Set,Map,RegExp,Math,JSON,process,require(name){if(name==='server-only')return{};if(name==='node:crypto')return crypto;if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.ts'));throw Error(name);}});return exports;}const api=load('src/lib/tesla-tariff/trusted-kraken-baseline.ts');api.__calls=()=>calls;api.__current=load('src/lib/tesla-tariff/current-baseline.ts');return api;}
const authorityFalse=result=>{for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority'])assert.equal(result[key],false,key);};

test('trusted path requires independently configured import and export meter-point identities',async()=>{
 const missing=site();delete missing.integrations.kraken.importTariffIdentity.accountRef;delete missing.integrations.kraken.exportTariffIdentity.meterPointRef;
 const result=await graph().assessTrustedCurrentBaselineFromKraken({site:missing,tesla:null,domain,assessedAt:now,maxEvidenceAgeMs:60000});
 assert.ok(result.blockers.includes('EXPECTED_EON_IMPORT_ACCOUNT_IDENTITY_UNCONFIGURED'));
 assert.ok(result.blockers.includes('EXPECTED_EON_EXPORT_METER_POINT_IDENTITY_UNVERIFIED'));authorityFalse(result);
});
test('correct configured identities pass binding while malformed identities fail closed',async()=>{
 const valid=await graph().assessTrustedCurrentBaselineFromKraken({site:site(),tesla:null,domain,assessedAt:now,maxEvidenceAgeMs:60000});
 assert.ok(!valid.blockers.some(code=>code.includes('IDENTITY_MISMATCH')||code.includes('IDENTITY_UNCONFIGURED')||code.includes('IDENTITY_UNVERIFIED')));authorityFalse(valid);
 const malformed=site();malformed.integrations.kraken.importTariffIdentity.accountRef='not-an-opaque-reference';
 const rejected=await graph().assessTrustedCurrentBaselineFromKraken({site:malformed,tesla:null,domain,assessedAt:now,maxEvidenceAgeMs:60000});
 assert.ok(rejected.blockers.includes('EXPECTED_EON_IMPORT_ACCOUNT_IDENTITY_UNCONFIGURED'));authorityFalse(rejected);
});
test('wrong account, meter point, tariff and cached cross-account evidence fail closed',async()=>{
 for(const mutate of [s=>s.importTariff.accountRef='e'.repeat(64),s=>s.importTariff.agreement.meterPointRef='e'.repeat(64),s=>s.importTariff.agreement.tariffCode='OTHER',s=>{s.stale=true;}]){
  const evidence=state();mutate(evidence);const result=await graph(evidence).assessTrustedCurrentBaselineFromKraken({site:site(),tesla:null,domain,assessedAt:now,maxEvidenceAgeMs:60000});
  assert.ok(result.blockers.some(code=>code.includes('MISMATCH')||code.includes('STALE')));authorityFalse(result);
 }
});
test('wrong export meter point and contradictory agreement identity fail closed',async()=>{
 for(const mutate of [s=>s.exportTariff.agreement.meterPointRef='e'.repeat(64),s=>s.exportTariff.agreement.productCode='OTHER',s=>s.exportTariff.agreement.tariffCode='OTHER']){
  const evidence=state();mutate(evidence);const result=await graph(evidence).assessTrustedCurrentBaselineFromKraken({site:site(),tesla:null,domain,assessedAt:now,maxEvidenceAgeMs:60000});
  assert.ok(result.blockers.includes('EXPECTED_EON_EXPORT_IDENTITY_MISMATCH'));authorityFalse(result);
 }
});
test('fixed export assumption prices financial curves but cannot establish authenticated identity',async()=>{
 const api=graph(),configured=site();delete configured.integrations.kraken.exportTariffIdentity.meterPointRef;
 const result=await api.assessTrustedCurrentBaselineFromKraken({site:configured,tesla:null,domain,assessedAt:now,maxEvidenceAgeMs:60000});
 assert.ok(result.blockers.includes('EXPECTED_EON_EXPORT_METER_POINT_IDENTITY_UNVERIFIED'));authorityFalse(result);
});
test('public structural assessment remains unavailable to fabricated matching economics',()=>{
 const modules=new Map();function load(file){file=path.resolve(file);if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,structuredClone,Date,Error,Intl,Object,Array,Number,String,Boolean,Set,Map,RegExp,Math,JSON,require(name){if(name==='node:crypto')return crypto;if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.ts'));throw Error(name);}});return exports;}
 const current=load('src/lib/tesla-tariff/current-baseline.ts'),window={start:domain.start,end:domain.end,price:price(.175),priceStatus:'known',kind:'standard',condition:'none',eligibilityPeriods:[],stale:false,sources:[{provider:'eon-next-kraken',description:'fabricated',observedAt:now,stale:false}]};
 const expected={source:{kind:'kraken-account-tariff',siteId:'home',observedAt:now,timeZone:'Europe/London'},diagnostics:[],signal:{scope:'whole-home',generatedAt:now,horizon:domain,import:[window],export:[window]}};
 const result=current.assessTrustedCurrentBaseline({siteId:'home',energySiteId:'1',timeZone:'Europe/London',assessedAt:now,maxEvidenceAgeMs:60000,domain,tesla:null,expected});
 assert.ok(result.blockers.includes('EXPECTED_EON_ACCOUNT_BINDING_UNAVAILABLE'));authorityFalse(result);
});
test('malformed comparison requests fail before authenticated acquisition',async()=>{
 for(const value of [null,undefined,0,'domain',[],{}, {start:domain.start}, {start:domain.end,end:domain.start}, {start:domain.start,end:domain.start}]){
  const api=graph();const result=await api.assessTrustedCurrentBaselineFromKraken({site:site(),tesla:null,domain:value,assessedAt:now,maxEvidenceAgeMs:60000});
  assert.ok(result.blockers.includes('COMPARISON_DOMAIN_INVALID'));assert.equal(api.__calls(),0);authorityFalse(result);
 }
 const api=graph();const result=await api.assessTrustedCurrentBaselineFromKraken({site:site(),tesla:null,domain,assessedAt:'invalid',maxEvidenceAgeMs:60000});
 assert.ok(result.blockers.includes('ASSESSMENT_REQUEST_INVALID'));assert.equal(api.__calls(),0);authorityFalse(result);
});
test('complete authenticated identities preserve acquisition time across fresh assessment boundaries',async()=>{
 const side=(sell=false)=>({code:'FLATPEAK',name:sell?'Export':'Import',utility:'E.ON Next',currency:'GBP',version:1,
  seasons:{Annual:{fromMonth:1,fromDay:1,toMonth:12,toDay:31,tou_periods:{cheap:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:0,toHour:6,fromMinute:0,toMinute:0}]},peak:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:6,toHour:0,fromMinute:0,toMinute:0}]}}}},
  energy_charges:{Annual:{rates:sell?{cheap:.175,peak:.175}:{cheap:.0285,peak:.23978}}},demand_charges:{Annual:{rates:{ALL:0}}}});
 for(const elapsed of [1,1000,59999,60000]){const api=graph(),assessedAt=new Date(Date.parse(now)+elapsed).toISOString();
  const tesla=api.__current.captureTeslaCurrentState({response:{energy_site_id:1,installation_time_zone:'Europe/London',default_real_mode:'autonomous',tariff_content_v2:{...side(),sell_tariff:side(true)}}},'1',now);
  const result=await api.assessTrustedCurrentBaselineFromKraken({site:site(),tesla,domain,assessedAt,maxEvidenceAgeMs:60000});
  assert.equal(result.status,'matches-expected-economics');assert.deepEqual(result.blockers,[]);assert.equal(result.expected.source.observedAt,now);
  assert.equal(api.__calls(),1);authorityFalse(result);}
});
test('stale, future and malformed acquisition timestamps fail closed',async()=>{
 for(const [observedAt,assessedAt,code] of [
  [now,new Date(Date.parse(now)+60001).toISOString(),'EXPECTED_EON_EVIDENCE_STALE'],
  [new Date(Date.parse(now)+1).toISOString(),now,'EXPECTED_EON_EVIDENCE_FUTURE'],
  ['invalid',now,'EXPECTED_EON_EVIDENCE_MALFORMED'],
 ]){const evidence=state();evidence.lastSuccessfulUpdate=observedAt;evidence.importTariff.observedAt=observedAt;evidence.exportTariff.observedAt=observedAt;
  const result=await graph(evidence).assessTrustedCurrentBaselineFromKraken({site:site(),tesla:null,domain,assessedAt,maxEvidenceAgeMs:60000});
  assert.equal(result.status,'insufficient-evidence');assert.ok(result.blockers.includes(code),`${observedAt}: ${result.blockers.join(',')}`);authorityFalse(result);}
});
test('contradictory export evidence cannot reach trusted economic matching',async()=>{
 const evidence=state();evidence.exportTariffDiagnostic={status:'unavailable',code:'EXPORT_ACCOUNT_CONTEXT_CHANGED'};
 const api=graph(evidence),side=(sell=false)=>({code:'FLATPEAK',name:sell?'Export':'Import',utility:'E.ON Next',currency:'GBP',version:1,
  seasons:{Annual:{fromMonth:1,fromDay:1,toMonth:12,toDay:31,tou_periods:{cheap:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:0,toHour:6,fromMinute:0,toMinute:0}]},peak:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:6,toHour:0,fromMinute:0,toMinute:0}]}}}},
  energy_charges:{Annual:{rates:sell?{cheap:.175,peak:.175}:{cheap:.0285,peak:.23978}}},demand_charges:{Annual:{rates:{ALL:0}}}});
 const tesla=api.__current.captureTeslaCurrentState({response:{energy_site_id:1,installation_time_zone:'Europe/London',default_real_mode:'autonomous',tariff_content_v2:{...side(),sell_tariff:side(true)}}},'1',now);
 const result=await api.assessTrustedCurrentBaselineFromKraken({site:site(),tesla,domain,assessedAt:now,maxEvidenceAgeMs:60000});
 assert.notEqual(result.status,'matches-expected-economics');assert.ok(result.blockers.length>0);authorityFalse(result);
});
