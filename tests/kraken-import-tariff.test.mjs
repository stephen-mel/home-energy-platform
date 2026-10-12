import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/kraken/import-tariff.ts','utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports,Date,Intl,Object,Reflect,Array,Number,Error,structuredClone});
const {validateKrakenImportTariff}=exports;
const expected={accountRef:'account-a',observedAt:'2026-10-11T12:00:00.000Z',timeZone:'Europe/London',
  tariffCode:'E-TOU-NEXT_DRIVE_SMART_V5_2-G',meterPointRef:'meter-a'};
const rate=(validFrom,validTo,value)=>({validFrom,validTo,value,preVatValue:value,rateType:'STANDARD'});
const response=()=>({accountRef:'account-a',electricityAgreements:[{
  validFrom:'2026-01-17T00:00:00+00:00',validTo:'2027-01-17T00:00:00+00:00',isRevoked:false,
  meterPoint:{direction:'IMPORT',meterPointRef:'meter-a'},tariff:{__typename:'HalfHourlyTariff',productCode:'NEXT_DRIVE_SMART_V5_2',
    tariffCode:'E-TOU-NEXT_DRIVE_SMART_V5_2-G',displayName:'Next Drive Smart V5.2',fullName:'E.ON Next Drive Smart V5.2',
    isExport:false,standingCharge:57.143,preVatStandingCharge:57.143,unitRates:[
      rate('2026-10-10T23:00:00+00:00','2026-10-11T05:00:00+00:00',2.85),
      rate('2026-10-11T05:00:00+00:00','2026-10-11T23:00:00+00:00',23.978),
      rate('2026-10-11T23:00:00+00:00','2026-10-12T05:00:00+00:00',2.85),
      rate('2026-10-12T05:00:00+00:00','2026-10-12T23:00:00+00:00',23.978),
    ]}}
]});

test('valid account tariff yields bounded import economics and unknown export',()=>{
  const result=validateKrakenImportTariff(response(),expected);
  assert.equal(result.status,'available');
  assert.equal(result.version.normalImport.amount,0.23978);
  assert.equal(result.version.scheduledChargingImport.amount,0.0285);
  assert.equal(result.version.dailyImportWindows[0].price.amount,0.0285);
  assert.equal(result.version.standingCharge,null);
  assert.equal(result.version.effectiveFrom,'2026-10-10T23:00:00.000Z');
  assert.equal(result.version.effectiveTo,'2026-10-12T23:00:00.000Z');
  assert.equal(result.version.export,null);assert.equal(result.exportStatus,'unknown');
});

test('expired, wrong-account and wrong-product agreements fail closed',()=>{
  const expired=response();expired.electricityAgreements[0].validTo='2026-10-01T00:00:00Z';
  assert.equal(validateKrakenImportTariff(expired,expected).status,'unavailable');
  assert.equal(validateKrakenImportTariff(response(),{...expected,accountRef:'other'}).code,'ACCOUNT_MISMATCH');
  const wrong=response();wrong.electricityAgreements[0].tariff.productCode='OTHER';
  assert.equal(validateKrakenImportTariff(wrong,expected).code,'TARIFF_IDENTITY_MISMATCH');
});

test('exact tariff and meter-point binding is required',()=>{
  assert.equal(validateKrakenImportTariff(response(),{...expected,tariffCode:undefined}).code,'SITE_TARIFF_IDENTITY_UNCONFIGURED');
  const wrongMeter=response();wrongMeter.electricityAgreements[0].meterPoint.meterPointRef='meter-b';
  assert.equal(validateKrakenImportTariff(wrongMeter,expected).code,'METER_POINT_MISMATCH');
  const substring=response();substring.electricityAgreements[0].tariff.tariffCode=`prefix-${expected.tariffCode}`;
  assert.equal(validateKrakenImportTariff(substring,expected).code,'TARIFF_IDENTITY_MISMATCH');
});

test('multi-day intervals are rejected and agreement validity clips rate evidence',()=>{
  const multi=response();multi.electricityAgreements[0].tariff.unitRates[0].validTo='2026-10-12T05:00:00Z';
  assert.equal(validateKrakenImportTariff(multi,expected).code,'RATE_SCHEDULE_UNSUPPORTED');
  const clipped=response();clipped.electricityAgreements[0].validTo='2026-10-12T00:00:00Z';
  const result=validateKrakenImportTariff(clipped,expected);
  assert.equal(result.status,'available');assert.equal(result.version.effectiveTo,'2026-10-12T00:00:00.000Z');
});

test('strict timestamps reject impossible dates and canonicalise accepted offsets',()=>{
  const impossible=response();impossible.electricityAgreements[0].validFrom='2026-02-30T00:00:00Z';
  assert.equal(validateKrakenImportTariff(impossible,expected).status,'unavailable');
  const result=validateKrakenImportTariff(response(),{...expected,observedAt:'2026-10-11T13:00:00+01:00'});
  assert.equal(result.status,'available');assert.equal(result.observedAt,'2026-10-11T12:00:00.000Z');
});

test('fractional-second rate boundaries cannot project whole-minute cheap coverage',()=>{
  const shifted=response();
  for(const item of shifted.electricityAgreements[0].tariff.unitRates) {
    item.validFrom=item.validFrom.replace(/(?=\+00:00$)/,'.500');
    item.validTo=item.validTo.replace(/(?=\+00:00$)/,'.500');
  }
  const result=validateKrakenImportTariff(shifted,expected);
  assert.equal(result.status,'unavailable');assert.equal(result.code,'RATE_BOUNDARY_NOT_MINUTE_ALIGNED');
});

test('23-hour and 25-hour London days retain exact local cheap/peak boundaries',()=>{
  for(const [observedAt,rates] of [
    ['2026-03-29T12:00:00Z',[rate('2026-03-29T00:00:00Z','2026-03-29T05:00:00Z',2.85),rate('2026-03-29T05:00:00Z','2026-03-29T23:00:00Z',23.978)]],
    ['2026-10-25T12:00:00Z',[rate('2026-10-24T23:00:00Z','2026-10-25T06:00:00Z',2.85),rate('2026-10-25T06:00:00Z','2026-10-26T00:00:00Z',23.978)]],
  ]) {
    const input=response();input.electricityAgreements[0].tariff.unitRates=rates;
    const result=validateKrakenImportTariff(input,{...expected,observedAt});
    assert.equal(result.status,'available');
  }
});

test('missing SMART/base coverage and malformed values fail closed',()=>{
  const missing=response();missing.electricityAgreements[0].tariff.unitRates=missing.electricityAgreements[0].tariff.unitRates.filter(r=>r.value!==2.85);
  assert.equal(validateKrakenImportTariff(missing,expected).status,'unavailable');
  const malformed=response();malformed.electricityAgreements[0].tariff.unitRates[0].value='2.85';
  assert.equal(validateKrakenImportTariff(malformed,expected).status,'unavailable');
  const malformedBasis=response();malformedBasis.electricityAgreements[0].tariff.unitRates[0].preVatValue=null;
  assert.equal(validateKrakenImportTariff(malformedBasis,expected).status,'unavailable');
});

test('missing export is accepted only as explicitly unknown',()=>{
  const result=validateKrakenImportTariff(response(),expected);
  assert.equal(result.status,'available');assert.equal(result.version.export,null);
});
