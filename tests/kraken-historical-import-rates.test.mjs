import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/kraken/historical-import-rates.ts','utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports,Date,Object,Array,Number,Error,structuredClone});
const {validateHistoricalImportRates}=exports;
const period={start:'2026-10-13T10:00:00.000Z',end:'2026-10-14T10:00:00.000Z'};
const expected={accountRef:'account-a',meterPointRef:'meter-a',observedAt:'2026-10-14T10:01:00.000Z',period,
  agreement:{validFrom:'2026-01-17T00:00:00.000Z',validTo:'2027-01-17T00:00:00.000Z'},
  corroboratingValues:[2.85,23.978]};
let cursor=0;
const row=(validFrom,validTo,value)=>({cursor:`cursor-${++cursor}`,node:{validFrom,validTo,value}});
const response=()=>({accountRef:'account-a',meterPointRef:'meter-a',complete:true,edges:[
  row(period.start,'2026-10-13T23:00:00.000Z','23.97800'),
  row('2026-10-13T23:00:00.000Z','2026-10-14T05:00:00.000Z','2.85000'),
  row('2026-10-14T05:00:00.000Z',period.end,'23.97800'),
]});

test('trailing period crossing London midnight has complete exact cheap and peak coverage',()=>{
 const result=validateHistoricalImportRates(response(),expected);assert.equal(result.status,'available');
 assert.equal(result.windows[0].price.amount,0.23978);assert.equal(result.windows[1].price.amount,0.0285);
 assert.deepEqual(JSON.parse(JSON.stringify(result.period)),period);assert.equal(result.vatBasis,'corroborated-not-independent');
});

test('ordering is ignored but gaps overlaps and incomplete pagination fail closed',()=>{
 const reordered=response();reordered.edges.reverse();assert.equal(validateHistoricalImportRates(reordered,expected).status,'available');
 const gap=response();gap.edges[1].node.validFrom='2026-10-13T23:30:00.000Z';assert.equal(validateHistoricalImportRates(gap,expected).code,'HISTORICAL_RATE_GAP');
 const overlap=response();overlap.edges[1].node.validFrom='2026-10-13T22:30:00.000Z';assert.equal(validateHistoricalImportRates(overlap,expected).code,'HISTORICAL_RATE_OVERLAP');
 const partial=response();partial.complete=false;assert.equal(validateHistoricalImportRates(partial,expected).code,'HISTORICAL_RATE_PAGINATION_INCOMPLETE');
});

test('malformed values and contradiction with trusted current tariff fail closed',()=>{
 for(const value of [23.978, 'NaN', '-1', '23.978x']) { const input=response();input.edges[0].node.value=value;
   assert.equal(validateHistoricalImportRates(input,expected).status,'unavailable'); }
 const conflict=response();conflict.edges[0].node.value='99.000';
 assert.equal(validateHistoricalImportRates(conflict,expected).code,'HISTORICAL_RATE_VALUE_CONTRADICTION');
});

test('agreement/DST-shaped 23-hour and 25-hour periods use absolute contiguous boundaries',()=>{
 for(const [p,edges] of [
  [{start:'2026-03-28T23:00:00.000Z',end:'2026-03-29T22:00:00.000Z'},[
    row('2026-03-28T23:00:00.000Z','2026-03-29T05:00:00.000Z','2.85000'),row('2026-03-29T05:00:00.000Z','2026-03-29T22:00:00.000Z','23.97800')]],
  [{start:'2026-10-24T23:00:00.000Z',end:'2026-10-26T00:00:00.000Z'},[
    row('2026-10-24T23:00:00.000Z','2026-10-25T06:00:00.000Z','2.85000'),row('2026-10-25T06:00:00.000Z','2026-10-26T00:00:00.000Z','23.97800')]],
 ]) { const result=validateHistoricalImportRates({...response(),edges},{...expected,period:p});assert.equal(result.status,'available'); }
});

test('identity and exact requested boundaries are mandatory',()=>{
 const wrong=response();wrong.meterPointRef='other';assert.equal(validateHistoricalImportRates(wrong,expected).code,'HISTORICAL_RATE_IDENTITY_MISMATCH');
 const outside=response();outside.edges[0].node.validFrom='2026-10-13T09:30:00.000Z';
 assert.equal(validateHistoricalImportRates(outside,expected).code,'HISTORICAL_RATE_OVERLAP');
});

test('missing nodes, malformed edges and repeated cursors fail closed without accepting alternate shapes',()=>{
 const direct=response();direct.edges[0]={cursor:'direct',validFrom:period.start,validTo:'2026-10-13T23:00:00.000Z',value:'23.97800'};
 assert.equal(validateHistoricalImportRates(direct,expected).code,'HISTORICAL_RATE_ROW_INVALID');
 const missing=response();delete missing.edges[0].node;assert.equal(validateHistoricalImportRates(missing,expected).code,'HISTORICAL_RATE_ROW_INVALID');
 const repeated=response();repeated.edges[1].cursor=repeated.edges[0].cursor;
 assert.equal(validateHistoricalImportRates(repeated,expected).code,'HISTORICAL_RATE_ROW_INVALID');
 const accessor=response();let invoked=false;Object.defineProperty(accessor.edges[0].node,'value',{enumerable:true,get(){invoked=true;return '23.97800';}});
 assert.equal(validateHistoricalImportRates(accessor,expected).code,'HISTORICAL_RATE_ROW_INVALID');assert.equal(invoked,false);
});

test('requested evidence cannot cross its independently verified agreement boundary',()=>{
 assert.equal(validateHistoricalImportRates(response(),{...expected,agreement:{...expected.agreement,validTo:'2026-10-14T09:30:00.000Z'}}).code,
  'HISTORICAL_RATE_OUTSIDE_AGREEMENT');
});

test('strict ISO timestamps canonicalise Z and explicit offsets without false gaps',()=>{
 const p={start:'2026-10-10T12:00:00Z',end:'2026-10-10T13:00:00+00:00'};
 const input={accountRef:'account-a',meterPointRef:'meter-a',complete:true,edges:[
  row('2026-10-10T13:00:00+01:00','2026-10-10T12:30:00Z','23.97800'),
  row('2026-10-10T13:30:00+01:00','2026-10-10T14:00:00+01:00','23.97800'),
 ]};
 const result=validateHistoricalImportRates(input,{...expected,period:p});assert.equal(result.status,'available');
 assert.deepEqual(JSON.parse(JSON.stringify(result.period)),{start:'2026-10-10T12:00:00.000Z',end:'2026-10-10T13:00:00.000Z'});
 assert.equal(result.windows[0].end,result.windows[1].start);
});

test('impossible dates, missing zones, excess precision, invalid offsets and non-minute boundaries fail closed',()=>{
 for(const invalid of ['2026-02-30T12:00:00Z','2026-10-10T12:00:00','2026-10-10T12:00:00.0001Z',
  '2026-10-10T12:00:00+24:00','2026-10-10T12:00:00+01:60','2026-10-10T12:00:00.500Z']) {
  const input=response();input.edges[0].node.validFrom=invalid;assert.equal(validateHistoricalImportRates(input,expected).status,'unavailable');
 }
});
