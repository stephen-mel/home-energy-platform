import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/kraken/export-tariff.ts','utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports,Date,Object,Array,Number,Error,structuredClone});
const {validateKrakenExportTariff}=exports;
const expected={accountRef:'export-account-a',observedAt:'2026-10-12T12:00:00.000Z',
  productCode:'NEXT_EXPORT_PREMIUM_V3',tariffCode:'E-1R-NEXT_EXPORT_PREMIUM_V3-G'};
const response=()=>({accountRef:'export-account-a',rateUnit:'p/kWh',electricityAgreements:[{
  validFrom:'2026-10-01T23:00:00+00:00',validTo:'2027-10-01T23:00:00+00:00',isRevoked:false,
  meterPoint:{direction:'EXPORT'},tariff:{__typename:'StandardTariff',productCode:'NEXT_EXPORT_PREMIUM_V3',
    tariffCode:'E-1R-NEXT_EXPORT_PREMIUM_V3-G',displayName:'Next Export Premium v3',isExport:true,
    unitRate:17.5,preVatUnitRate:17.5}}]});

test('verified StandardTariff export rate is converted exactly from p/kWh to GBP/kWh',()=>{
  const result=validateKrakenExportTariff(response(),expected);
  assert.equal(result.status,'available');
  assert.deepEqual(JSON.parse(JSON.stringify(result.price)),{amount:0.175,currency:'GBP',unit:'kWh'});
  assert.equal(result.agreement.productCode,'NEXT_EXPORT_PREMIUM_V3');
  assert.equal(result.agreement.tariffCode,'E-1R-NEXT_EXPORT_PREMIUM_V3-G');
  assert.equal(result.agreement.validFrom,'2026-10-01T23:00:00.000Z');
  assert.equal(result.agreement.validTo,'2027-10-01T23:00:00.000Z');
});

test('wrong account and contradictory tariff identities fail closed',()=>{
  assert.equal(validateKrakenExportTariff(response(),{...expected,accountRef:'another'}).code,'EXPORT_ACCOUNT_MISMATCH');
  const wrong=response();wrong.electricityAgreements[0].tariff.tariffCode='OTHER';
  assert.equal(validateKrakenExportTariff(wrong,expected).code,'EXPORT_TARIFF_IDENTITY_MISMATCH');
  const importSide=response();importSide.electricityAgreements[0].meterPoint.direction='IMPORT';
  assert.equal(validateKrakenExportTariff(importSide,expected).code,'NOT_EXPORT_AGREEMENT');
  assert.equal(validateKrakenExportTariff(response(),{...expected,importAccountRef:expected.accountRef}).code,'EXPORT_ACCOUNT_NOT_DISTINCT');
});

test('expired or revoked export agreement is unavailable',()=>{
  const expired=response();expired.electricityAgreements[0].validTo='2026-10-02T00:00:00Z';
  assert.equal(validateKrakenExportTariff(expired,expected).code,'EXPORT_AGREEMENT_INACTIVE');
  const revoked=response();revoked.electricityAgreements[0].isRevoked=true;
  assert.equal(validateKrakenExportTariff(revoked,expected).code,'EXPORT_AGREEMENT_INACTIVE');
});

test('rate units and numeric values are validated before projection',()=>{
  const unit=response();unit.rateUnit='GBP/kWh';
  assert.equal(validateKrakenExportTariff(unit,expected).code,'EXPORT_RATE_UNIT_UNSUPPORTED');
  const value=response();value.electricityAgreements[0].tariff.unitRate='17.5';
  assert.equal(validateKrakenExportTariff(value,expected).code,'EXPORT_RATE_INVALID');
});

test('missing export identity is explicit and independent from import economics',()=>{
  assert.equal(validateKrakenExportTariff(response(),{...expected,tariffCode:undefined}).code,'SITE_EXPORT_TARIFF_IDENTITY_UNCONFIGURED');
});
