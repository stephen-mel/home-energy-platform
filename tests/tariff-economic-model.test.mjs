import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

class SuppliedDate extends Date {
  constructor(...args) { assert.ok(args.length, 'No implicit wall clock'); super(...args); }
  static now() { throw Error('No wall clock'); }
}
function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Date: SuppliedDate, structuredClone, require(name) {
    assert.ok(name in dependencies, `Pure dependency boundary: ${name}`); return dependencies[name];
  } });
  return exports;
}
const decimal = load('src/lib/tariff/economic-decimal.ts');
const { resolveEconomicModel: resolve, economicInstant } = load('src/lib/tariff/resolve-economic-model.ts', { './economic-decimal': decimal });
const plain = v => JSON.parse(JSON.stringify(v));
const period = (start, end) => ({ start, end });
const extent = period('2026-01-01T00:00:00Z', '2027-01-17T00:00:00Z');
const horizon = period('2026-10-06T23:00:00Z', '2026-10-07T23:00:00Z');
const generated = '2026-10-06T23:00:00Z';
const price = (amount, unit = 'kWh', basis = 'tax-exclusive') => ({ amount, unit, currency: 'GBP', basis, ...(basis === 'tax-exclusive' ? { taxId: 'vat' } : {}) });
function model() {
  const evidence = ['agreement', 'rates', 'tax', 'rule'].map(id => ({ id, provider: 'supplier', kind: id === 'agreement' ? 'supplier-agreement' : 'manual',
    observedAt: '2026-01-01T00:00:00Z', freshness: 'fresh', coverage: [extent] }));
  const agreements = ['import','export'].map(direction => ({ id: direction, supplyRef: 'synthetic', direction, supplier: 'supplier', productCode: 'product', tariffCode: direction,
    validFrom: extent.start, validTo: extent.end, status: 'active', invalidatedAt: null, evidenceIds: ['agreement'] }));
  const rates = [['a','0.0285'],['b','0.23978'],['c','0.4']].map(([id,amount]) => ({ id, price: price(amount), validity: extent, evidenceIds: ['rates'] }));
  rates.push({ id:'standing', price:price('0.57143','day'), validity:extent,evidenceIds:['rates'] });
  const schedule = [{ rateId:'a',local:{kind:'daily',start:'00:00',end:'06:00'},overlayPolicy:'preserve',compatibility:'guaranteed-off-peak' },
    { rateId:'b',local:{kind:'daily',start:'06:00',end:'24:00'},overlayPolicy:'replace' }];
  return bindFixture({ timeZone:'Europe/London', evidence, agreements, taxes:[
    { id:'vat',validity:period(extent.start,'2026-09-30T23:00:00Z'),fraction:'0.05',evidenceIds:['tax'] },
    { id:'vat',validity:period('2026-09-30T23:00:00Z',extent.end),fraction:'0',evidenceIds:['tax'] }], versions:[
    { id:'import-v1',agreementId:'import',validity:extent,evidenceIds:['rates'],rates,schedule,standingRateId:'standing',conditionalRules:[
      { id:'dispatch',rateId:'a',validity:extent,evidenceIds:['rule'],dispatchType:'SMART',provider:'kraken',qualification:'physical-charging-required',compatibility:'drive-smart' }] },
    { id:'export-v1',agreementId:'export',validity:extent,evidenceIds:['rates'],rates:[{ id:'export-rate',price:price('0.175','kWh','tax-inclusive'),validity:extent,evidenceIds:['rates'] }],
      schedule:[{rateId:'export-rate',local:{kind:'all-day'},overlayPolicy:'preserve'}],standingRateId:null,conditionalRules:[] }] });
}
// Test-only construction of explicit evidence; production never infers subjects.
const subject = a => ({agreementId:a.id,supplyRef:a.supplyRef,supplier:a.supplier,direction:a.direction,productCode:a.productCode,tariffCode:a.tariffCode});
function bindFixture(m) {
  m.evidence=[];
  for(const a of m.agreements){
    const suffix=a.id==='import'?'':`-${a.id}`;
    const add=(id,kind,claims)=>{const key=id+suffix;m.evidence.push({id:key,provider:a.supplier,kind,subject:subject(a),claims,
      observedAt:'2026-01-01T00:00:00Z',freshness:'fresh',coverage:[extent]});return key;};
    a.evidenceIds=[add('agreement','supplier-agreement',[{role:'agreement-identity'},{role:'agreement-validity'}])];
    const v=m.versions.find(v=>v.agreementId===a.id);
    const claims=[{role:'economic-version',versionId:v.id},{role:'schedule-definition',versionId:v.id},
      ...v.rates.map(r=>({role:r.price.unit==='day'?'standing-charge':'energy-rate',versionId:v.id,rateId:r.id}))];
    const rateId=add('rates','supplier-rates',claims);v.evidenceIds=[rateId];v.rates.forEach(r=>r.evidenceIds=[rateId]);
    for(const r of v.conditionalRules)r.evidenceIds=[add('rule','supplier-rates',[{role:'conditional-rule-definition',versionId:v.id,ruleId:r.id}])];
    add('tax','supplier-rates',[{role:'tax-treatment',taxId:'vat'}]);
  }
  m.taxes.forEach(t=>t.evidenceIds=['tax','tax-export']);return m;
}
function addVersionClaims(m,v){
  for(const id of new Set([...v.evidenceIds,...v.rates.flatMap(r=>r.evidenceIds),...v.conditionalRules.flatMap(r=>r.evidenceIds)])){
    const e=m.evidence.find(e=>e.id===id);e.claims.push(...e.claims.filter(c=>'versionId'in c).map(c=>({...c,versionId:v.id})));
  }
}
function dispatch(m, start='2026-10-07T08:00:00Z', end='2026-10-07T10:00:00Z') {
  m.evidence.push({id:'dispatch-evidence',provider:'kraken',kind:'authenticated-dispatch',observedAt:generated,freshness:'fresh',coverage:[period(start,end)],subject:subject(m.agreements[0]),claims:[{role:'conditional-dispatch-occurrence',ruleId:'dispatch',assetId:'vehicle',dispatchType:'SMART',start,end}]});
  return {start,end,ruleId:'dispatch',agreementId:'import',evidenceId:'dispatch-evidence',cause:{kind:'ev-dispatch',assetId:'vehicle',start,end,dispatchType:'SMART'}};
}
const at = (r,t,direction='import') => r.signal[direction].find(p => Date.parse(p.start)<=Date.parse(t) && Date.parse(p.end)>Date.parse(t));
const run = (m=model(), h=horizon, ds=[]) => resolve(m,h,generated,ds);

test('Drive Smart shape uses generic rates and independent export, without authority', () => {
  const r=run();assert.equal(r.status,'resolved');assert.equal(at(r,'2026-10-07T02:00:00Z').price.amount,0.0285);
  assert.equal(at(r,'2026-10-07T12:00:00Z').price.amount,0.23978);assert.equal(at(r,'2026-10-07T12:00:00Z','export').price.amount,0.175);
  assert.ok(r.standingCharges.every(p=>p.consumerPrice.amount==='0.57143'));
  assert.ok(!JSON.stringify(r.signal).includes('0.57143'));assert.equal(r.writeReady,undefined);assert.equal(r.rollbackProven,undefined);
});
test('NSSS-like three rates, four periods and repeated daytime reference use same resolver', () => {
  const m=model();m.versions[0].schedule=[['a','23:30','05:30'],['b','05:30','16:00'],['c','16:00','19:00'],['b','19:00','23:30']]
    .map(([rateId,start,end])=>({rateId,local:{kind:'daily',start,end},overlayPolicy:'replace'}));
  const r=run(m);for(const [time,expected] of [['00:00',0.0285],['04:29',0.0285],['04:30',0.23978],['15:00',0.4],['18:00',0.23978],['22:30',0.0285]])
    assert.equal(at(r,`2026-10-07T${time}:00Z`).price.amount,expected);
});
for (const [name,h,cheapHours] of [
  ['spring-forward',period('2026-03-29T00:00:00Z','2026-03-29T23:00:00Z'),5],
  ['autumn-fold',period('2026-10-24T23:00:00Z','2026-10-26T00:00:00Z'),7],
]) test(`London ${name}: actual elapsed overnight duration and continuous coverage`,()=>{
  const r=run(model(),h);const ws=r.signal.import;
  assert.equal(ws.reduce((n,w)=>n+(w.kind==='guaranteed-off-peak'?Date.parse(w.end)-Date.parse(w.start):0),0),cheapHours*3600000);
  assert.equal(ws[0].start,new Date(h.start).toISOString());assert.equal(ws.at(-1).end,new Date(h.end).toISOString());
  for(let i=1;i<ws.length;i++)assert.equal(ws[i-1].end,ws[i].start);
});
test('agreement end is exclusive; nullable end is unknown rather than infinity',()=>{
  const m=model();m.agreements[0].validTo='2026-10-07T12:00:00Z';let r=run(m);
  assert.equal(at(r,'2026-10-07T11:59:59Z').priceStatus,'known');assert.equal(at(r,'2026-10-07T12:00:00Z').price,null);
  m.agreements[0].validTo=null;r=run(m);assert.ok(r.signal.import.every(w=>w.price===null));
});
test('future agreement with missing economics stays unknown',()=>{
  const m=model();m.agreements[0].status='future';m.agreements[0].validFrom='2026-10-07T12:00:00Z';m.versions=m.versions.filter(v=>v.agreementId!=='import');m.evidence=m.evidence.filter(e=>e.subject.agreementId!=='import'||e.kind==='supplier-agreement'||e.id==='tax');
  assert.ok(run(m).signal.import.every(w=>w.price===null));
});
test('revocation and customer cutoff do not rewrite prior covered periods',()=>{
  const m=model();m.agreements[0].status='terminated';m.agreements[0].invalidatedAt='2026-10-07T12:00:00Z';const r=run(m);
  assert.equal(at(r,'2026-10-07T11:00:00Z').priceStatus,'known');assert.equal(at(r,'2026-10-07T12:00:00Z').priceStatus,'unknown');
  m.agreements[0].status='revoked';m.agreements[0].invalidatedAt=null;assert.ok(run(m).signal.import.every(w=>w.price===null));
});
test('exact decimal September and zero VAT October derivation',()=>{
  for(const [base,unit,expected]of [['0.0285','kWh','0.029925'],['0.23978','kWh','0.251769'],['0.57143','day','0.6000015']]){
    assert.equal(decimal.deriveConsumerAmount(price(base,unit),'0.05'),expected);assert.equal(decimal.deriveConsumerAmount(price(base,unit),'0'),base);
  }
  assert.notEqual(decimal.deriveConsumerAmount(price('0.0285'),'0.05'),'0.02993');
});
test('independent agreement, rate and tax boundaries are all respected',()=>{
  const m=model(),v=m.versions[0];const b=v.rates.find(r=>r.id==='b');b.validity={...extent,end:'2026-10-01T12:00:00Z'};
  v.rates.push({...structuredClone(b),validity:period(b.validity.end,extent.end),price:price('0.3')});m.agreements[0].validTo='2026-10-01T14:00:00Z';
  const r=run(m,period('2026-09-30T12:00:00Z','2026-10-01T15:00:00Z'));
  assert.equal(at(r,'2026-09-30T12:00:00Z').price.amount,0.251769);assert.equal(at(r,'2026-10-01T06:00:00Z').price.amount,0.23978);
  assert.equal(at(r,'2026-10-01T12:00:00Z').price.amount,0.3);assert.equal(at(r,'2026-10-01T14:00:00Z').price,null);
});
test('inclusive and observed prices are not taxed twice or decomposed',()=>{
  for(const basis of ['tax-inclusive','observed-external'])assert.equal(decimal.deriveConsumerAmount(price('0.02993','kWh',basis),'0.05'),'0.02993');
});
test('missing tax evidence fails closed; inclusive export remains available',()=>{
  const m=model();m.taxes=[];m.evidence=m.evidence.filter(e=>!e.claims.some(c=>c.role==='tax-treatment'));const r=run(m);assert.ok(r.signal.import.every(w=>w.price===null));assert.ok(r.signal.export.every(w=>w.price.amount===0.175));
});
test('unresolved rate reference is unknown, not baseline fallback',()=>{
  const m=model();m.versions[0].schedule[1].rateId='absent';assert.equal(at(run(m),'2026-10-07T12:00:00Z').price,null);
});
for(const conflict of ['schedule','version','rate','tax','agreement'])test(`conflicting ${conflict} fails closed`,()=>{
  const m=model();if(conflict==='schedule')m.versions[0].schedule.push(structuredClone(m.versions[0].schedule[1]));
  if(conflict==='version'){const v={...structuredClone(m.versions[0]),id:'other'};m.versions.push(v);addVersionClaims(m,v);}
  if(conflict==='rate')m.versions[0].rates.push({...structuredClone(m.versions[0].rates[1]),price:price('0.5')});
  if(conflict==='tax')m.taxes.push(structuredClone(m.taxes[1]));
  if(conflict==='agreement'){const a={...structuredClone(m.agreements[0]),id:'other',evidenceIds:['other-agreement']};m.agreements.push(a);m.evidence.push({...structuredClone(m.evidence[0]),id:'other-agreement',subject:subject(a)});}
  assert.equal(at(run(m),'2026-10-07T12:00:00Z').priceStatus,'conflicting');
});
test('freshness does not extend or shorten contractual/economic coverage',()=>{
  const m=model();m.evidence.forEach(e=>e.freshness='stale');const r=run(m);assert.equal(at(r,'2026-10-07T12:00:00Z').price.amount,0.23978);assert.equal(at(r,'2026-10-07T12:00:00Z').stale,true);
  m.evidence.find(e=>e.id==='rates').coverage=[period(horizon.start,'2026-10-07T12:00:00Z')];assert.equal(at(run(m),'2026-10-07T12:00:00Z').price,null);
});
test('SMART overlay uses dated economic rate and retains conservative qualification',()=>{
  const m=model(),d=dispatch(m);const r=run(m,horizon,[d]),w=at(r,d.start);
  assert.equal(w.price.amount,0.0285);assert.equal(w.condition,'scheduled-ev-charging');assert.ok(w.eligibilityPeriods.every(p=>p.state==='planned-conditional'));
  assert.equal(at(r,d.end).price.amount,0.23978);assert.equal(at(r,d.start,'export').price.amount,0.175);
});
test('SMART rates follow revisions; protected overnight stays unconditional',()=>{
  const m=model(),d=dispatch(m,'2026-10-07T00:00:00Z','2026-10-07T10:00:00Z');const a=m.versions[0].rates[0];a.validity={...extent,end:'2026-10-07T09:00:00Z'};
  m.versions[0].rates.push({...structuredClone(a),validity:period(a.validity.end,extent.end),price:price('0.03')});const r=run(m,horizon,[d]);
  assert.equal(at(r,d.start).condition,'none');assert.equal(at(r,'2026-10-07T08:00:00Z').price.amount,0.0285);assert.equal(at(r,'2026-10-07T09:00:00Z').price.amount,0.03);
});
test('generic provider qualification need not require physical charging; unsupported projection fails closed',()=>{
  const m=model(),d=dispatch(m);m.versions[0].conditionalRules[0].qualification='provider-defined';m.versions[0].conditionalRules[0].compatibility=null;
  const r=run(m,horizon,[d]);assert.equal(r.status,'resolved');assert.equal(r.periods.find(p=>p.conditional).consumerPrice.amount,'0.0285');
  assert.equal(at(r,d.start).price,null);assert.ok(r.diagnostics.includes('CONDITION_NOT_REPRESENTABLE'));
});
test('failed charger commands do not invalidate dispatch or infer delivery; power alone creates nothing',()=>{
  const m=model(),d=dispatch(m);const before=run(m,horizon,[d]);
  m.physicalObservations=[{assetId:'vehicle',observedAt:d.start,observation:{kind:'command',outcome:'failed'}},{assetId:'vehicle',observedAt:d.start,observation:{kind:'power',kw:3.7}}];
  assert.deepEqual(plain(run(m,horizon,[d])),plain(before));assert.ok(!JSON.stringify(before).includes('delivered-energy'));
  assert.ok(run(m).periods.every(p=>p.conditional===null));
});
test('invalid dispatch authentication, malformed dates and duplicate evidence fail closed',()=>{
  const m=model(),d=dispatch(m);m.evidence.at(-1).kind='tesla-observation';assert.equal(run(m,horizon,[d]).status,'invalid');
  assert.ok(Number.isNaN(economicInstant('2026-02-30T00:00:00Z')));assert.ok(Number.isNaN(economicInstant('2026-10-07T24:00:00Z')));
  assert.notEqual(economicInstant('2026-10-25T01:30:00+01:00'),economicInstant('2026-10-25T01:30:00+00:00'));
  const bad=model();bad.evidence.push(structuredClone(bad.evidence[0]));assert.equal(run(bad).status,'invalid');
});
test('inputs remain unchanged and results are detached; no I/O dependencies are available',()=>{
  const m=model(),snapshot=structuredClone(m),r=run(m);assert.deepEqual(m,snapshot);m.versions[0].rates[0].price.amount='999';assert.equal(at(r,'2026-10-07T02:00:00Z').price.amount,0.0285);
});
test('legacy adapter preserves complete historical September PriceSignal',()=>{
  const curve=load('src/lib/tariff/price-signal.ts'),effective=load('src/lib/tariff/effective-tariff.ts',{'./price-signal':curve});
  const kraken=load('src/lib/tariff/kraken-dispatches.ts',{'./price-signal':curve});
  const siteApi=load('src/lib/site/get-site-price-signal.ts',{'../tariff/price-signal':curve,'../tariff/effective-tariff':effective,'../tariff/kraken-dispatches':kraken});
  const legacy=load('src/lib/tariff/legacy-economic-adapter.ts',{'../site/get-site-price-signal':siteApi});
  const {currentSite}=load('src/lib/site/current-site.ts');const now='2026-09-23T00:00:00+01:00';
  const state={stale:false,lastSuccessfulUpdate:now,vehicles:[{id:'ev',name:'Car',plannedDispatches:[{start:'2026-09-23T09:00:00+01:00',end:'2026-09-23T11:00:00+01:00',type:'SMART',energyAddedKwh:'7'}]}]};
  assert.deepEqual(plain(legacy.resolveLegacySiteEconomics(currentSite,state,now)),plain(siteApi.getSitePriceSignal(currentSite,state,now)));
});

test('adjacent economic versions switch independently of agreement end without a gap',()=>{
  const m=model(),v=m.versions[0],boundary='2026-10-07T12:00:00Z';
  const next=structuredClone(v);v.validity={...extent,end:boundary};next.id='import-v2';next.validity=period(boundary,extent.end);
  next.rates.find(r=>r.id==='b').price=price('0.31');m.versions.push(next);addVersionClaims(m,next);const r=run(m);
  assert.equal(at(r,'2026-10-07T11:59:59Z').price.amount,0.23978);assert.equal(at(r,boundary).price.amount,0.31);
  assert.equal(r.signal.import.at(-1).end,new Date(horizon.end).toISOString());
});
test('short evidence horizon is not extended by agreement end or an authenticated overlay',()=>{
  const m=model(),d=dispatch(m);m.evidence.find(e=>e.id==='rates').coverage=[period(horizon.start,'2026-10-07T09:00:00Z')];
  const r=run(m,horizon,[d]);assert.equal(at(r,'2026-10-07T08:59:59Z').price.amount,0.0285);assert.equal(at(r,'2026-10-07T09:00:00Z').price,null);
});
test('BOOST cannot use Drive Smart compatibility and currency conflicts cannot be hidden',()=>{
  const m=model(),d=dispatch(m);d.cause.dispatchType='BOOST';assert.equal(run(m,horizon,[d]).status,'invalid');
  const other=model(),ds=dispatch(other);other.versions[0].rates.find(r=>r.id==='a').price.currency='USD';
  assert.equal(at(run(other,horizon,[ds]),ds.start).priceStatus,'conflicting');
});
test('unknown tax basis and malformed calendar/offset inputs are rejected',()=>{
  const m=model();m.versions[0].rates[0].price.basis='assume-no-tax';assert.equal(run(m).status,'invalid');
  for(const t of ['2026-02-29T00:00:00Z','2026-10-07T12:60:00Z','2026-10-07T12:00:60Z','2026-10-07T12:00:00+24:00','2026-10-07T12:00:00+01:60'])assert.ok(Number.isNaN(economicInstant(t)));
  assert.ok(Number.isFinite(economicInstant('2028-02-29T00:00:00Z')));
});

function rejected(m,ds=[],code){
  const r=run(m,horizon,ds);assert.equal(r.status,'invalid');
  assert.ok([...r.signal.import,...r.signal.export].every(w=>w.price===null));assert.equal(r.standingCharges.length,0);
  if(code)assert.ok(r.diagnostics.includes(code),JSON.stringify(r.diagnostics));return r;
}
const economicRoleRecords=[
  ['agreement-identity','agreement'],['agreement-validity','agreement'],['economic-version','rates'],['schedule-definition','rates'],
  ['energy-rate','rates'],['standing-charge','rates'],['tax-treatment','tax'],['conditional-rule-definition','rule'],
];
for(const [role,id] of economicRoleRecords)test(`authenticated dispatch cannot substantiate ${role}, even with existing IDs`,()=>{
  const m=model(),e=m.evidence.find(e=>e.id===id);e.kind='authenticated-dispatch';e.provider='kraken';e.claims=e.claims.filter(c=>c.role===role);
  rejected(m,[],'EVIDENCE_ROLE_NOT_PERMITTED');
});
for(const [role,id] of economicRoleRecords)test(`Tesla observation cannot substantiate ${role}`,()=>{
  const m=model(),e=m.evidence.find(e=>e.id===id);e.kind='tesla-observation';e.provider='tesla';e.claims=e.claims.filter(c=>c.role===role);
  rejected(m,[],'EVIDENCE_ROLE_NOT_PERMITTED');
});
for(const physical of ['physical','control','delivery'])for(const id of ['agreement','rates','tax'])test(`${physical} evidence cannot substantiate ${id}`,()=>{
  const m=model();m.evidence.find(e=>e.id===id).kind=physical;rejected(m);
});
for(const [field,value]of Object.entries({agreementId:'absent',supplyRef:'another-supply',supplier:'supplier-B',direction:'export',productCode:'other-product',tariffCode:'other-tariff'}))
  test(`evidence subject rejects wrong ${field}`,()=>{const m=model();m.evidence.find(e=>e.id==='rates').subject[field]=value;rejected(m,[],'EVIDENCE_SUBJECT_MISMATCH');});
for(const id of ['agreement','rates','tax','rule'])test(`supplier-owned ${id} rejects contradictory attestor`,()=>{
  const m=model();m.evidence.find(e=>e.id===id).provider='supplier-B';rejected(m,[],'EVIDENCE_ATTESTOR_MISMATCH');
});
test('correct manual third-party attestation retains explicit subject without impersonating supplier',()=>{
  const m=model();m.evidence.forEach(e=>{e.kind='manual';e.provider='independent-attestor';});
  const r=run(m);assert.equal(r.status,'resolved');assert.equal(at(r,'2026-10-07T12:00:00Z').price.amount,0.23978);
});
test('manual attestation cannot assert authenticated occurrence',()=>{
  const m=model(),d=dispatch(m);m.evidence.at(-1).kind='manual';rejected(m,[d],'EVIDENCE_ROLE_NOT_PERMITTED');
});
test('valid authenticated occurrence still applies only with independent rule/rate/tax evidence',()=>{
  const m=model(),d=dispatch(m),r=run(m,horizon,[d]);assert.equal(r.status,'resolved');assert.equal(at(r,d.start).price.amount,0.0285);
  assert.equal(at(r,d.start).condition,'scheduled-ev-charging');
});
test('occurrence cannot manufacture conditional-rule definition by ID substitution',()=>{
  const m=model(),d=dispatch(m);m.versions[0].conditionalRules[0].evidenceIds=[d.evidenceId];rejected(m,[d],'EVIDENCE_TARGET_MISMATCH');
});
test('rule evidence cannot manufacture an occurrence; unconsumed occurrence evidence creates no interval',()=>{
  const m=model(),d=dispatch(m);assert.ok(run(m).periods.every(p=>p.conditional===null));d.evidenceId='rule';rejected(m,[d]);
});
for(const field of ['ruleId','assetId','dispatchType','start','end'])test(`dispatch claim must match exact ${field}`,()=>{
  const m=model(),d=dispatch(m),c=m.evidence.at(-1).claims[0];
  c[field]=field==='start'?'2026-10-07T08:01:00Z':field==='end'?'2026-10-07T09:59:00Z':'different';rejected(m,[d]);
});
test('dispatch subject cannot be reassigned to another valid agreement',()=>{
  const m=model(),d=dispatch(m);m.evidence.at(-1).subject=subject(m.agreements[1]);rejected(m,[d]);
});
test('valid wrong-agreement rate evidence is rejected at its consuming reference',()=>{
  const m=model();m.versions[0].rates[1].evidenceIds=['rates-export'];rejected(m,[],'EVIDENCE_SUBJECT_MISMATCH');
});
test('tax evidence for agreement B cannot satisfy agreement A through a shared tax definition',()=>{
  const m=model();m.taxes.forEach(t=>t.evidenceIds=['tax-export']);rejected(m,[],'EVIDENCE_CLAIM_MISSING');
});
test('shared tax has independently bound evidence per consuming agreement',()=>{
  const m=model();m.versions[1].rates[0].price=price('0.175');const r=run(m);assert.equal(r.status,'resolved');
  assert.equal(at(r,'2026-10-07T12:00:00Z','export').price.amount,0.175);
  assert.ok(at(r,'2026-10-07T12:00:00Z','export').sources.some(s=>s.description==='supplier-rates:tax-export'));
  assert.ok(!at(r,'2026-10-07T12:00:00Z','export').sources.some(s=>s.description==='supplier-rates:tax'));
});
test('collective identity/validity claims may be on separate contributing records',()=>{
  const m=model(),e=m.evidence.find(e=>e.id==='agreement');e.claims=[{role:'agreement-identity'}];
  m.evidence.push({...structuredClone(e),id:'validity',claims:[{role:'agreement-validity'}]});m.agreements[0].evidenceIds.push('validity');
  assert.equal(run(m).status,'resolved');m.agreements[0].evidenceIds.push('rates');rejected(m,[],'EVIDENCE_TARGET_MISMATCH');
});
for(const [name,mutate,code] of [
  ['missing subject',e=>{delete e.subject;},'EVIDENCE_SUBJECT_MISMATCH'],
  ['missing claims',e=>{delete e.claims;},'EVIDENCE_CLAIM_MISSING'],
  ['empty claims',e=>{e.claims=[];},'EVIDENCE_CLAIM_MISSING'],
  ['unknown role',e=>{e.claims[0].role='trusted';},'EVIDENCE_ROLE_NOT_PERMITTED'],
  ['malformed target',e=>{e.claims[0].versionId=null;},'EVIDENCE_TARGET_MISMATCH'],
  ['unexpected target',e=>{e.claims[0].agreementId='import';},'EVIDENCE_TARGET_MISMATCH'],
  ['duplicate claim',e=>{e.claims.push(structuredClone(e.claims[0]));},'EVIDENCE_CLAIM_DUPLICATE'],
  ['wrong version',e=>{e.claims[0].versionId='export-v1';},'EVIDENCE_TARGET_MISMATCH'],
  ['wrong rate',e=>{e.claims.find(c=>c.role==='energy-rate').rateId='missing-rate';},'EVIDENCE_TARGET_MISMATCH'],
])test(`${name} is rejected, not inferred`,()=>{const m=model();mutate(m.evidence.find(e=>e.id==='rates'));rejected(m,[],code);});
test('missing one required agreement role fails even though its evidence exists',()=>{
  const m=model();m.evidence.find(e=>e.id==='agreement').claims=[{role:'agreement-identity'}];rejected(m,[],'EVIDENCE_CLAIM_MISSING');
});
test('wrong existing rate target cannot support another rate reference',()=>{
  const m=model();m.evidence.find(e=>e.id==='rates').claims=m.evidence.find(e=>e.id==='rates').claims.filter(c=>c.rateId!=='b');rejected(m,[],'EVIDENCE_TARGET_MISMATCH');
});
test('wrong rule target rejects independently of dispatch data',()=>{
  const m=model();m.evidence.find(e=>e.id==='rule').claims[0].ruleId='different';rejected(m,[],'EVIDENCE_TARGET_MISMATCH');
});
test('prohibited unused declared role rejects; observation-only evidence grants no claims',()=>{
  const m=model();m.evidence.push({id:'observation',provider:'tesla',kind:'tesla-observation',subject:subject(m.agreements[0]),claims:[],observedAt:generated,freshness:'fresh',coverage:[horizon]});
  assert.equal(run(m).status,'resolved');m.evidence.at(-1).claims=[{role:'agreement-validity'}];rejected(m,[],'EVIDENCE_ROLE_NOT_PERMITTED');
});
test('supplier bill can support scoped rates/tax, not schedule or agreement validity',()=>{
  const m=model();const e=m.evidence.find(e=>e.id==='rates');
  m.evidence.push({...structuredClone(e),id:'billed-rates',kind:'supplier-bill',claims:e.claims.filter(c=>['energy-rate','standing-charge'].includes(c.role))});
  m.versions[0].rates.forEach(r=>r.evidenceIds=['billed-rates']);m.evidence.find(e=>e.id==='tax').kind='supplier-bill';assert.equal(run(m).status,'resolved');
  m.evidence.at(-1).claims.push({role:'schedule-definition',versionId:'import-v1'});rejected(m,[],'EVIDENCE_ROLE_NOT_PERMITTED');
});
test('timestamp-equivalent duplicate occurrence claims reject after normalization',()=>{
  const m=model(),d=dispatch(m),e=m.evidence.at(-1);e.claims.push({...e.claims[0],start:'2026-10-07T09:00:00+01:00',end:'2026-10-07T11:00:00+01:00'});
  rejected(m,[d],'EVIDENCE_CLAIM_DUPLICATE');
});
test('correct occurrence offsets normalize but never extend explicit coverage',()=>{
  const m=model(),d=dispatch(m),e=m.evidence.at(-1);e.claims[0].start='2026-10-07T09:00:00+01:00';e.coverage=[period(d.start,'2026-10-07T09:00:00Z')];
  const r=run(m,horizon,[d]);assert.equal(at(r,'2026-10-07T08:30:00Z').price.amount,0.0285);assert.equal(at(r,'2026-10-07T09:00:00Z').price,null);
});

function unchangedAfterMutation(result, mutate) {
  const before=JSON.stringify(result);
  try { mutate(); } catch(error) { assert.equal(error.name,'TypeError'); }
  assert.equal(JSON.stringify(result),before);
}
test('shared source-price aliases cannot be mutated into disagreement with consumer or projected prices',()=>{
  const m=model(),d=dispatch(m),r=run(m,horizon,[d]);const p=r.periods.find(p=>p.sourcePrice);
  const peers=r.periods.filter(w=>w.sourcePrice===p.sourcePrice);assert.ok(peers.length>1);
  unchangedAfterMutation(r,()=>{p.sourcePrice.amount='999';});
  unchangedAfterMutation(r,()=>{p.consumerPrice.amount='999';});
  unchangedAfterMutation(r,()=>{r.signal.import[0].price.amount=999;});
  assert.ok(peers.every(w=>w.sourcePrice.amount==='0.0285'));
});
test('shared tax and conditional-rule aliases are deeply immutable',()=>{
  const m=model(),d=dispatch(m),r=run(m,horizon,[d]);const p=r.periods.find(p=>p.conditional);
  assert.ok(r.periods.filter(w=>w.conditional?.rule===p.conditional.rule).length>1);
  unchangedAfterMutation(r,()=>{p.conditional.rule.compatibility=null;});
  unchangedAfterMutation(r,()=>{p.tax.fraction='999';});
  unchangedAfterMutation(r,()=>{p.tax.validity.end=extent.start;});
  unchangedAfterMutation(r,()=>{p.conditional.intervals[0].cause.start=extent.start;});
  unchangedAfterMutation(r,()=>{p.conditional.rule.evidenceIds.push('invented');});
});
test('all returned arrays, provenance and projected eligibility resist actual mutation',()=>{
  const m=model(),d=dispatch(m),r=run(m,horizon,[d]);const w=at(r,d.start);
  for(const array of [r.periods,r.standingCharges,r.signal.import,r.signal.export,r.diagnostics,w.sources,w.eligibilityPeriods]){
    unchangedAfterMutation(r,()=>array.push({}));unchangedAfterMutation(r,()=>array.reverse());
    unchangedAfterMutation(r,()=>{array[0]={};});
  }
  unchangedAfterMutation(r,()=>{w.sources[0].provider='forged';});
  unchangedAfterMutation(r,()=>{w.eligibilityPeriods[0].state='billed-verified';});
  unchangedAfterMutation(r,()=>{r.signal.horizon.end=extent.end;});
  unchangedAfterMutation(r,()=>{r.signal={};});
});
test('retained nested evidence/claim/subject metadata is detached and immutable',()=>{
  const m=model();m.taxes[1].provenance={evidence:m.evidence.find(e=>e.id==='tax')};const r=run(m);
  const retained=r.periods.find(p=>p.tax).tax.provenance.evidence;
  unchangedAfterMutation(r,()=>{retained.subject.supplier='other';});
  unchangedAfterMutation(r,()=>{retained.claims[0].taxId='other';});
  unchangedAfterMutation(r,()=>retained.claims.push({role:'energy-rate'}));
  m.taxes[1].provenance.evidence.subject.supplier='caller-can-change';
  assert.equal(retained.subject.supplier,'supplier');
});
for(const state of ['unknown','conflicting','invalid','invalid-horizon'])test(`${state} result is immutable on its return path`,()=>{
  const m=model();if(state==='unknown')m.agreements[0].validTo=null;
  if(state==='conflicting')m.versions[0].schedule.push(structuredClone(m.versions[0].schedule[0]));
  if(state==='invalid')delete m.evidence[0].claims;
  const r=state==='invalid-horizon'?run(m,period('bad',horizon.end)):run(m);
  if(state.startsWith('invalid'))assert.equal(r.status,'invalid');
  unchangedAfterMutation(r,()=>{r.status='changed';});unchangedAfterMutation(r,()=>r.diagnostics.push('changed'));
  unchangedAfterMutation(r,()=>{r.signal.horizon.start='changed';});unchangedAfterMutation(r,()=>r.signal.import.push({}));
  if(r.periods.length)unchangedAfterMutation(r,()=>{r.periods[0].diagnostics[0]='changed';});
});
test('caller model, horizon, evidence and intervals remain mutable and detached',()=>{
  const m=model(),d=dispatch(m),h={...horizon};const r=run(m,h,[d]),before=JSON.stringify(r);
  m.versions[0].rates[0].price.amount='999';m.evidence[0].subject.supplier='changed';m.taxes[1].fraction='999';
  d.cause.assetId='changed';h.start='changed';m.versions[0].conditionalRules[0].compatibility=null;
  assert.equal(JSON.stringify(r),before);
  const bad={start:{nested:true},end:horizon.end};const invalid=run(model(),bad);
  bad.start.nested=false;assert.equal(invalid.signal.horizon.start,'');assert.equal(invalid.status,'invalid');
});
test('shared cyclic plain metadata freezes safely without freezing caller data',()=>{
  const m=model(),extra={label:'original'};extra.self=extra;m.versions[0].rates[0].price.extra=extra;
  const r=run(m);assert.equal(r.status,'resolved');const returned=r.periods.find(p=>p.sourcePrice?.extra).sourcePrice.extra;
  assert.equal(returned.self,returned);
  try{returned.self.label='changed';}catch(error){assert.equal(error.name,'TypeError');}
  assert.equal(returned.label,'original');extra.label='caller-change';assert.equal(returned.label,'original');
});
for(const [name,make]of [['Map',()=>new Map([['x',1]])],['Set',()=>new Set([1])],['Date',()=>new Date(generated)],['typed array',()=>new Uint8Array([1])]])
  test(`mutable ${name} internals cannot escape under a misleading freeze`,()=>{
    const m=model();m.versions[0].rates[0].price.extra=make();const r=run(m);assert.equal(r.status,'invalid');
    assert.ok(r.signal.import.every(w=>w.price===null));unchangedAfterMutation(r,()=>{r.diagnostics[0]='changed';});
  });
