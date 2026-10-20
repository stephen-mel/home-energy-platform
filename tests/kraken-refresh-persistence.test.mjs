import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";
import { loadStore } from "./helpers/kraken-schedule-store.mjs";

function loadCoordinator() {
  const historicalExports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/lib/kraken/historical-import-rates.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: historicalExports, Date, Object, Array, Number, Error, Set, structuredClone });
  const source = ts.transpileModule(fs.readFileSync("src/lib/site/kraken-refresh.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(`${source}\nexports.__testError = message => new Error(message);`, {
    exports, Buffer, structuredClone, console: { error() {} }, process,
    require(name) {
      if (name === "server-only") return {};
      if (name === "node:path") return path;
      if (name === "../kraken/client") return {
        createKrakenReadSession() { throw Error("not used"); },
        getKrakenAccountReference() { throw Error("not used"); },
      };
      if (name === "../kraken/dispatch-response") return { requireCompleteDispatches(result) {
        if (result.status !== "complete") throw Error(result.code);
        return result.dispatches;
      } };
      if (name === "../kraken/import-tariff") return { validateKrakenImportTariff(_raw, expected) {
        return { status: "available", accountRef: expected.accountRef, observedAt: expected.observedAt,
          agreement: { validFrom: "2026-01-17T00:00:00.000Z", validTo: "2027-01-17T00:00:00.000Z",
            productCode: "NEXT_DRIVE_SMART_V5_2", tariffCode: "E-TOU-NEXT_DRIVE_SMART_V5_2-G", meterPointRef: "meter-a" },
          version: { normalImport: { amount: 0.23978, currency: "GBP", unit: "kWh" },
            scheduledChargingImport: { amount: 0.0285, currency: "GBP", unit: "kWh" } }, exportStatus: "unknown" };
      } };
      if (name === "../kraken/export-tariff") return { validateKrakenExportTariff(_raw, expected) {
        if (expected.accountRef === expected.importAccountRef)
          return { status: "unavailable", code: "EXPORT_ACCOUNT_NOT_DISTINCT" };
        return { status: "available", accountRef: expected.accountRef, observedAt: expected.observedAt,
          agreement: { validFrom: "2026-10-01T23:00:00Z", validTo: "2027-10-01T23:00:00Z",
            productCode: "NEXT_EXPORT_PREMIUM_V3", tariffCode: "E-1R-NEXT_EXPORT_PREMIUM_V3-G" },
          price: { amount: 0.175, currency: "GBP", unit: "kWh" } };
      } };
      if (name === "../kraken/historical-import-rates") return historicalExports;
      if (name === "../kraken/schedule-store") return {
        scheduleObservationStore() { throw Error("not used"); },
        scheduleScopeId(scope) { return JSON.stringify([scope.siteId, scope.accountRef]); },
      };
      if (name === "./kraken-state-store") return {
        readLastKnownKrakenState: async () => null, writeLastKnownKrakenState: async () => {},
      };
      throw Error(`Unexpected dependency ${name}`);
    },
  });
  return exports;
}
const api = loadCoordinator();
const plain = value => JSON.parse(JSON.stringify(value));
const slot = (start = "2026-10-11T12:00:00+01:00", end = "2026-10-11T12:30:00+01:00") =>
  ({ start, end, type: "SMART", energyAddedKwh: "-2.3000" });
const device = (id = "ev-a", name = "EV A") => ({ id, name, deviceType: "EV", provider: "kraken",
  vehicleBatterySize: "77.0", chargePointPowerOutput: "7.2", preferences: null, preferenceSetting: null });
const vehicleStatus = () => ({ currentState: "SMART_CHARGING", isSuspended: false,
  stateOfCharge: { value: "42.00" }, activePower: { value: "7.1" }, stateOfChargeLimit: null });

test('independently configured import account rejects runtime substitution before cache recovery',async()=>{
 const intended='a'.repeat(64),other='b'.repeat(64),h=harness({accountRef:other,compatible:{vehicles:[],lastSuccessfulUpdate:'2026-10-11T10:00:00.000Z',stale:false}});
 await assert.rejects(()=>h.coordinator.get('site-a',{accountRef:intended,tariffCode:'tariff',meterPointRef:'meter-a'}),/KRAKEN_CONFIGURED_IMPORT_ACCOUNT_MISMATCH/);
 const diagnostic=await h.coordinator.inspect('site-a',{accountRef:intended,tariffCode:'tariff',meterPointRef:'meter-a'});
 assert.equal(diagnostic.state,null);assert.deepEqual(plain(diagnostic.acquisition),{attempted:false,
  freshEvidenceObtained:false,staleFallbackUsed:false,code:'KRAKEN_CONFIGURED_IMPORT_ACCOUNT_MISMATCH'});
 assert.equal(h.counts().sessions,0);
});
function harness(options = {}) {
  let now = options.now ?? Date.parse("2026-10-11T10:00:00Z");
  let afterNextNow = null;
  let sessions = 0, deviceCalls = 0, statusCalls = 0, dispatchCalls = 0, records = 0, writes = 0;
  let compatible = options.compatible ?? null;
  const storeResults = [...(options.storeResults ?? [{ status: "persisted", change: "initial", ledger: {} }])];
  const sessionsByDevice = options.sessionsByDevice ?? { "ev-a": [slot()] };
  const coordinator = api.createKrakenRefreshCoordinator({
    now: () => { const value = now; const after = afterNextNow; afterNextNow = null; after?.(); return value; },
    accountRef: () => options.accountRef ?? "account-a",
    exportAccountRef: () => typeof options.expectedExportAccountRef === 'function'
      ? options.expectedExportAccountRef() : options.expectedExportAccountRef ?? "export-account-a",
    createSession: () => {
      sessions++;
      if (options.credentialFailure?.()) throw options.credentialErrorFromModule
        ? api.__testError(options.credentialError ?? "E.ON credentials are not configured")
        : Error(options.credentialError ?? "E.ON credentials are not configured");
      const exportAccountRef = typeof options.sessionExportAccountRef === 'function'
        ? options.sessionExportAccountRef() : options.sessionExportAccountRef ?? "export-account-a";
      return { accountRef: options.accountRef ?? "account-a",
        exportAccountRef,
        async getImportTariff() { if (options.tariffFailure) throw Error("tariff failed"); return {}; },
        async getExportTariff() { if (options.exportTariffFailure) throw Error("export tariff failed"); return {}; },
        async getHistoricalImportRates(period) { if (options.historicalFailure) throw Error("historical failed");
          options.onHistorical?.(period); return options.historicalResponse ?? { accountRef: options.accountRef ?? "account-a",
            meterPointRef: "meter-a", complete: true, edges: [{ cursor: "history-1",
              node: { value: "23.97800", validFrom: period.start, validTo: period.end } }] }; },
        async getDevices() { deviceCalls++; return options.devices ?? [device()]; },
        async getVehicleStatus() { statusCalls++; if (options.statusFailure) throw Error("status failed"); return options.vehicleStatus ?? vehicleStatus(); },
        async getPlannedDispatchResponse(id) { dispatchCalls++;
          const response = await (options.dispatchResponse?.(id) ?? { status: "complete", explicitlyEmpty: !sessionsByDevice[id]?.length,
            dispatches: sessionsByDevice[id] ?? [] });
          return { ...response, deviceId: options.responseDeviceId ?? id };
        } };
    },
    record(scope, read) { records++; options.onRecord?.(scope, read); return storeResults.shift() ?? { status: "persisted", change: "unchanged", ledger: {} }; },
    async readCompatibility(scopeId) {
      if (options.compatibleScope !== undefined && options.compatibleScope !== scopeId) return null;
      return compatible;
    },
    async writeCompatibility(scopeId, state) {
      writes++;
      await options.onWrite?.(scopeId, state, { advance: ms => { now += ms; } });
      compatible = structuredClone(state);
    },
  });
  return { coordinator, advance: ms => { now += ms; }, advanceAfterNextNow: ms => {
    afterNextNow = () => { now += ms; };
  }, counts: () => ({ sessions, deviceCalls, statusCalls, dispatchCalls, records, writes }), compatible: () => compatible };
}

test("complete and explicit-empty refreshes create detached reads with exact values", async () => {
  const captured = [];
  const h = harness({ devices: [device("ev-a", "A"), device("ev-b", "B")], sessionsByDevice: {
    "ev-a": [slot()], "ev-b": [],
  }, onRecord: (scope, read) => captured.push({ scope, read }) });
  const result = await h.coordinator.get("site-a");
  assert.equal(result.scheduleRecording.status, "persisted");
  assert.equal(result.vehicles[0].plannedDispatches[0].energyAddedKwh, "-2.3000");
  assert.equal(result.vehicles[1].plannedDispatches.length, 0);
  assert.deepEqual(plain(captured[0].scope), { siteId: "site-a", accountRef: "account-a" });
  assert.equal(captured[0].read.status, "complete");
  assert.equal(captured[0].read.provenance, "authenticated-query");
  assert.equal(captured[0].read.vehicles[0].plannedDispatches[0].start, slot().start);
  assert.deepEqual(h.counts(), { sessions: 1, deviceCalls: 1, statusCalls: 2, dispatchCalls: 2, records: 1, writes: 1 });
});

test("inspection acquisition result is transient, sanitized and distinguishes fresh from stale fallback", async () => {
  const fresh = harness();
  const acquired = await fresh.coordinator.getWithAcquisition("site-a");
  assert.equal(acquired.state.stale, false);
  assert.deepEqual(plain(acquired.acquisition), { attempted: true, freshEvidenceObtained: true,
    staleFallbackUsed: false, code: null });
  assert.equal(Object.hasOwn(acquired.state, "acquisition"), false);

  const compatible = structuredClone(acquired.state);
  const failed = harness({ compatible, credentialFailure: () => true,
    credentialError: "private-token upstream detail" });
  const recovered = await failed.coordinator.getWithAcquisition("site-a");
  assert.equal(recovered.state.stale, true);
  assert.deepEqual(plain(recovered.acquisition), { attempted: true, freshEvidenceObtained: false,
    staleFallbackUsed: true, code: "KRAKEN_REFRESH_UNAVAILABLE" });
  assert.equal(Object.hasOwn(recovered.state, "acquisition"), false);
  assert.doesNotMatch(JSON.stringify(recovered), /private-token/);
  assert.equal(failed.counts().writes, 0);

  const stagedFailure = harness({ compatible, credentialFailure: () => true,
    credentialError: "KRAKEN_AUTH_HTTP_FAILURE", credentialErrorFromModule: true });
  const stagedRecovery = await stagedFailure.coordinator.getWithAcquisition("site-a");
  assert.equal(stagedRecovery.state.stale, true);
  assert.deepEqual(plain(stagedRecovery.acquisition), { attempted: true, freshEvidenceObtained: false,
    staleFallbackUsed: true, code: "KRAKEN_AUTH_HTTP_FAILURE" });
  assert.equal(Object.hasOwn(stagedRecovery.state, "acquisition"), false);
});

test("one refresh session carries exact bounded historical evidence without another session", async () => {
  const period={start:"2026-10-10T10:00:00.000Z",end:"2026-10-11T10:00:00.000Z"};let captured;
  const h=harness({onHistorical:value=>{captured=value;}});
  const result=await h.coordinator.get("site-a",{tariffCode:"tariff",meterPointRef:"meter-a"},undefined,period);
  assert.deepEqual(plain(captured),period);assert.equal(result.historicalImportRates.status,"available");
  assert.deepEqual(h.counts(),{sessions:1,deviceCalls:1,statusCalls:1,dispatchCalls:1,records:1,writes:1});
});

test("client-shaped 48-interval Relay history passes the real validator; malformed coverage stays unavailable",async()=>{
 const period={start:"2026-10-10T10:00:00.000Z",end:"2026-10-11T10:00:00.000Z"},start=Date.parse(period.start);
 const edges=Array.from({length:48},(_,index)=>({cursor:`edge-${index}`,node:{value:index<26?"23.97800":"2.85000",
  validFrom:new Date(start+index*1800000).toISOString(),validTo:new Date(start+(index+1)*1800000).toISOString()}}));
 const h=harness({historicalResponse:{accountRef:"account-a",meterPointRef:"meter-a",complete:true,edges}});
 const result=await h.coordinator.get("site-a",{tariffCode:"tariff",meterPointRef:"meter-a"},undefined,period);
 assert.equal(result.historicalImportRates.status,"available");assert.equal(result.historicalImportRates.windows.length,48);
 for(const mutate of [
  value=>{delete value.edges[0].node;},
  value=>{value.edges[1].node.validFrom=new Date(start+45*60000).toISOString();},
  value=>{value.edges[1].node.validFrom=new Date(start+15*60000).toISOString();},
 ]) { const broken=structuredClone({accountRef:"account-a",meterPointRef:"meter-a",complete:true,edges});mutate(broken);
   const check=harness({historicalResponse:broken});const state=await check.coordinator.get("site-a",{tariffCode:"tariff",meterPointRef:"meter-a"},undefined,period);
   assert.equal(state.historicalImportRates,undefined);assert.equal(state.historicalImportRatesDiagnostic.status,"unavailable"); }
});

test("real coordinator and validator accept equivalent client timestamps without milliseconds and offsets",async()=>{
 const period={start:"2026-10-10T10:00:00.000Z",end:"2026-10-11T10:00:00.000Z"},start=Date.parse(period.start);
 const format=(instant,index)=>index%2===0?new Date(instant).toISOString().replace('.000Z','Z'):
  new Date(instant+3600000).toISOString().replace('.000Z','+01:00');
 const edges=Array.from({length:48},(_,index)=>({cursor:`offset-${index}`,node:{value:index<26?"23.97800":"2.85000",
  validFrom:format(start+index*1800000,index),validTo:format(start+(index+1)*1800000,index)}}));
 const h=harness({historicalResponse:{accountRef:"account-a",meterPointRef:"meter-a",complete:true,edges}});
 const result=await h.coordinator.get("site-a",{tariffCode:"tariff",meterPointRef:"meter-a"},undefined,period);
 assert.equal(result.historicalImportRates.status,"available");assert.equal(result.historicalImportRates.windows.length,48);
 assert.equal(result.historicalImportRates.windows[0].start,period.start);
 assert.equal(result.historicalImportRates.windows.at(-1).end,period.end);
});

test("observed Kraken decimal-string status metrics become finite internal numbers", async () => {
  const h = harness({ vehicleStatus: { currentState: "SMART_CONTROL_IN_PROGRESS", isSuspended: false,
    stateOfCharge: { value: "78.00" }, activePower: { value: "0.0" }, stateOfChargeLimit: null } });
  const result = await h.coordinator.get("site-a");
  assert.equal(result.vehicles[0].status.stateOfCharge.value, 78);
  assert.equal(result.vehicles[0].status.activePower.value, 0);
});

test("complete previously observed production device shape validates without coercing schedule fields", async () => {
  const observed = { ...device(), preferences: { schedules: Array.from({ length: 7 }, (_, index) => ({
    dayOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"][index],
    time: "07:00:00", min: null, max: 100, upperLimit: 100,
  })) }, preferenceSetting: { scheduleSettings: [{ timeFrom: "00:00:00", timeTo: "23:30:00", timeStep: 30,
    min: "10.00", max: "100.00", step: "1.00" }] } };
  const h = harness({ devices: [observed], vehicleStatus: { currentState: "SMART_CONTROL_IN_PROGRESS", isSuspended: false,
    stateOfCharge: { value: "78.00" }, activePower: { value: "0.0" }, stateOfChargeLimit: null } });
  const result = await h.coordinator.get("site-a");
  assert.equal(result.vehicles[0].preferences.schedules[0].max, 100);
  assert.equal(result.vehicles[0].preferenceSetting.scheduleSettings[0].min, "10.00");
  assert.equal(result.vehicles[0].status.stateOfCharge.value, 78);
});

test("parser failures identify a safe field path without including raw values", async () => {
  const h = harness({ vehicleStatus: { currentState: null, isSuspended: null,
    stateOfCharge: { value: "SECRET-NOT-A-DECIMAL" }, activePower: { value: "0.0" }, stateOfChargeLimit: null } });
  await assert.rejects(h.coordinator.get("site-a"), error => {
    assert.equal(error.message, "KRAKEN_DEVICE_RESPONSE_INVALID:status.stateOfCharge.value");
    assert.doesNotMatch(error.message, /SECRET/); return true;
  });
});

for (const value of [" 78.00", "NaN", "Infinity", "1e2", true, {}, Infinity, NaN])
  test(`malformed Kraken status metric fails closed: ${String(value)}`, async () => {
    const h = harness({ vehicleStatus: { currentState: null, isSuspended: null,
      stateOfCharge: { value }, activePower: { value: "0.0" }, stateOfChargeLimit: null } });
    await assert.rejects(h.coordinator.get("site-a"), /KRAKEN_DEVICE_RESPONSE_INVALID/);
    assert.equal(h.counts().records, 0); assert.equal(h.counts().writes, 0);
  });

test("missing tariff evidence does not discard a complete vehicle refresh", async () => {
  const h = harness({ tariffFailure: true });
  const result = await h.coordinator.get("site-a");
  assert.equal(result.stale, false);assert.equal(result.vehicles.length, 1);
  assert.equal(result.importTariff, undefined);
  assert.deepEqual(plain(result.importTariffDiagnostic), { status: "unavailable", code: "TARIFF_RETRIEVAL_FAILED" });
  assert.equal(h.counts().records, 1);assert.equal(h.counts().writes, 1);
});

test("configured export tariff is independently validated without affecting complete dispatch recording", async () => {
  const h = harness();
  const result = await h.coordinator.get("site-a",
    { tariffCode: "E-TOU-NEXT_DRIVE_SMART_V5_2-G", meterPointRef: "meter-a" },
    { accountRef: "export-account-a", productCode: "NEXT_EXPORT_PREMIUM_V3", tariffCode: "E-1R-NEXT_EXPORT_PREMIUM_V3-G" });
  assert.equal(result.exportTariff.status, "available");
  assert.equal(result.exportTariff.price.amount, 0.175);
  assert.equal(result.vehicles[0].plannedDispatches.length, 1);
  assert.equal(result.scheduleRecording.status, "persisted");
});

test("changing configured export account invalidates the 60-second cache and refreshes exact account evidence", async () => {
  let exportAccount = "export-account-a";
  const h = harness({ expectedExportAccountRef: () => exportAccount, sessionExportAccountRef: () => exportAccount });
  const identity = accountRef => ({ accountRef, productCode: "NEXT_EXPORT_PREMIUM_V3", tariffCode: "E-1R-NEXT_EXPORT_PREMIUM_V3-G" });
  const first = await h.coordinator.get("site-a", undefined, identity(exportAccount));
  assert.equal(first.exportTariff.accountRef, "export-account-a");
  exportAccount = "export-account-b";
  const second = await h.coordinator.get("site-a", undefined, identity(exportAccount));
  assert.equal(second.exportTariff.accountRef, "export-account-b");
  assert.equal(h.counts().sessions, 2);
  assert.equal(h.counts().deviceCalls, 2);
});

test("failed export retrieval is cached for its captured account context but an account change refreshes", async () => {
  let exportAccount = "export-account-a";
  const h = harness({ exportTariffFailure: true, expectedExportAccountRef: () => exportAccount,
    sessionExportAccountRef: () => exportAccount });
  const identity = accountRef => ({ accountRef, productCode: "NEXT_EXPORT_PREMIUM_V3",
    tariffCode: "E-1R-NEXT_EXPORT_PREMIUM_V3-G" });
  const first = await h.coordinator.get("site-a", undefined, identity(exportAccount));
  assert.equal(first.exportTariff, undefined);
  assert.equal(first.exportTariffDiagnostic.code, "EXPORT_TARIFF_RETRIEVAL_FAILED");
  const repeated = await h.coordinator.get("site-a", undefined, identity(exportAccount));
  assert.equal(repeated, first);
  assert.equal(h.counts().sessions, 1);
  exportAccount = "export-account-b";
  const changed = await h.coordinator.get("site-a", undefined, identity(exportAccount));
  assert.equal(changed.exportTariffDiagnostic.code, "EXPORT_TARIFF_RETRIEVAL_FAILED");
  assert.equal(h.counts().sessions, 2);
});

test("recovery never launders export evidence from a previous account", async () => {
  const old = { vehicles: [], lastSuccessfulUpdate: "2026-10-11T10:00:00.000Z", stale: true,
    scheduleRecording: { status: "persisted", change: "initial", code: null },
    exportTariff: { status: "available", accountRef: "export-account-a",
    observedAt: "2026-10-11T10:00:00.000Z", agreement: { validFrom: "2026-10-01T23:00:00.000Z",
      validTo: "2027-10-01T23:00:00.000Z", productCode: "NEXT_EXPORT_PREMIUM_V3",
      tariffCode: "E-1R-NEXT_EXPORT_PREMIUM_V3-G" }, price: { amount: 0.175, currency: "GBP", unit: "kWh" } } };
  const h = harness({ compatible: old, expectedExportAccountRef: "export-account-b",
    sessionExportAccountRef: "export-account-b", credentialFailure: () => true });
  const recovered = await h.coordinator.get("site-a", undefined, { accountRef: "export-account-b",
    productCode: "NEXT_EXPORT_PREMIUM_V3", tariffCode: "E-1R-NEXT_EXPORT_PREMIUM_V3-G" });
  assert.equal(recovered.stale, true);
  assert.equal(recovered.exportTariff, undefined);
  assert.equal(recovered.exportTariffDiagnostic.code, "EXPORT_ACCOUNT_CONTEXT_CHANGED");
});

test("missing, null, malformed and partial dispatch reads never record or publish", async () => {
  for (const response of [
    { status: "incomplete", code: "DISPATCH_FIELD_MISSING" },
    { status: "incomplete", code: "DISPATCH_FIELD_NULL" },
    { status: "incomplete", code: "DISPATCH_RESPONSE_MALFORMED" },
    { status: "failed", code: "DISPATCH_RETRIEVAL_FAILED" },
  ]) {
    const h = harness({ devices: [device("ev-a"), device("ev-b")], dispatchResponse: id =>
      id === "ev-b" ? response : { status: "complete", explicitlyEmpty: false, dispatches: [slot()] } });
    await assert.rejects(h.coordinator.get("site-a"));
    assert.equal(h.counts().records, 0); assert.equal(h.counts().writes, 0);
  }
});

test("invalid and duplicate device enumeration fails before per-vehicle reads", async () => {
  for (const devices of [[device(), device()], [{ ...device(), id: "" }], [{ ...device(), name: null }]]) {
    const h = harness({ devices });
    await assert.rejects(h.coordinator.get("site-a"), /KRAKEN_DEVICE_RESPONSE_INVALID/);
    assert.deepEqual(h.counts(), { sessions: 1, deviceCalls: 1, statusCalls: 0, dispatchCalls: 0, records: 0, writes: 0 });
  }
});

test("device accessors and unsupported objects fail closed without invocation or caller mutation", async () => {
  let invoked = 0;
  const accessor = device();
  Object.defineProperty(accessor, "id", { enumerable: true, get() { invoked++; return "ev-a"; } });
  for (const value of [accessor, new Date(), Object.assign(Object.create({ inherited: true }), device())]) {
    const h = harness({ devices: [value] });
    await assert.rejects(h.coordinator.get("site-a"), /KRAKEN_DEVICE_RESPONSE_INVALID/);
    assert.equal(h.counts().records, 0);
  }
  assert.equal(invoked, 0);
  assert.equal(Object.isFrozen(accessor), false);
});

test("scope-keyed single flight covers retrieval, recording and cache publication", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  // Block the first refresh inside its only dispatch call.
  const delayed = harness({ dispatchResponse: async () => { await gate; return { status: "complete", explicitlyEmpty: false, dispatches: [slot()] }; } });
  const first = delayed.coordinator.get("site-a");
  const second = delayed.coordinator.get("site-a");
  release();
  assert.equal(await first, await second);
  assert.deepEqual(delayed.counts(), { sessions: 1, deviceCalls: 1, statusCalls: 1, dispatchCalls: 1, records: 1, writes: 1 });
});

test("60-second memory cache introduces no retrieval, recording or publication calls", async () => {
  const h = harness();
  const first = await h.coordinator.get("site-a");
  h.advance(59_999);
  assert.equal(await h.coordinator.get("site-a"), first);
  assert.deepEqual(h.counts(), { sessions: 1, deviceCalls: 1, statusCalls: 1, dispatchCalls: 1, records: 1, writes: 1 });
  h.advance(2);
  await h.coordinator.get("site-a");
  assert.deepEqual(h.counts(), { sessions: 2, deviceCalls: 2, statusCalls: 2, dispatchCalls: 2, records: 2, writes: 2 });
});

test("memory-cache freshness and acquisition diagnostics share delivery-time classification", async () => {
  const h = harness();
  await h.coordinator.getWithAcquisition("site-a");
  h.advance(59_999);

  const fresh = await h.coordinator.getWithAcquisition("site-a");
  assert.equal(fresh.state.stale, false);
  assert.deepEqual(plain(fresh.acquisition), { attempted: false, freshEvidenceObtained: true,
    staleFallbackUsed: false, code: null });

  h.advanceAfterNextNow(2);
  const expired = await h.coordinator.getWithAcquisition("site-a");
  assert.equal(expired.state.stale, true);
  assert.deepEqual(plain(expired.acquisition), { attempted: false, freshEvidenceObtained: false,
    staleFallbackUsed: false, code: "KRAKEN_EVIDENCE_EXPIRED_BEFORE_DELIVERY" });
  assert.deepEqual(h.counts(), { sessions: 1, deviceCalls: 1, statusCalls: 1,
    dispatchCalls: 1, records: 1, writes: 1 });
});

test("slow compatibility publication cannot renew authenticated retrieval freshness", async () => {
  const successful = harness({ onWrite: async (_scope, _state, clock) => clock.advance(60_001) });
  const expired = await successful.coordinator.getWithAcquisition("site-a");
  assert.equal(expired.state.stale, true);
  assert.deepEqual(plain(expired.acquisition), { attempted: true, freshEvidenceObtained: false,
    staleFallbackUsed: false, code: "KRAKEN_EVIDENCE_EXPIRED_BEFORE_DELIVERY" });
  await successful.coordinator.get("site-a");
  assert.equal(successful.counts().deviceCalls, 2);
  assert.equal(successful.counts().records, 2);

  let fail = true;
  const failed = harness({ onWrite: async (_scope, _state, clock) => {
    clock.advance(60_001);
    if (fail) { fail = false; throw Error("delayed JSON failure"); }
  } });
  await assert.rejects(failed.coordinator.get("site-a"), /delayed JSON failure/);
  await failed.coordinator.get("site-a");
  assert.equal(failed.counts().deviceCalls, 2);
  assert.equal(failed.counts().records, 2);
  assert.equal(failed.counts().writes, 2);
});

async function joinedPublicationScenario({ publicationFailure }) {
  let releasePublication;
  let publicationStarted;
  const publicationGate = new Promise(resolve => { releasePublication = resolve; });
  const enteredPublication = new Promise(resolve => { publicationStarted = resolve; });
  let failureObserved = false;
  const h = harness({ onWrite: async () => {
    publicationStarted();
    await publicationGate;
    // The production compatibility adapter contains its own best-effort failure
    // boundary, so a failed rename resolves after recording that it occurred.
    if (publicationFailure) failureObserved = true;
  } });
  const original = h.coordinator.getWithAcquisition("site-a");
  await enteredPublication;
  h.advance(60_001);
  const joined = [h.coordinator.getWithAcquisition("site-a"), h.coordinator.getWithAcquisition("site-a"),
    h.coordinator.getWithAcquisition("site-a")];
  releasePublication();
  const results = await Promise.all([original, ...joined]);
  return { h, results, failureObserved };
}

test("all callers joining delayed successful publication receive delivery-time stale classification", async () => {
  const { h, results } = await joinedPublicationScenario({ publicationFailure: false });
  assert.ok(results.every(result => result.state.stale === true));
  assert.ok(results.every(result => result.state.lastSuccessfulUpdate === results[0].state.lastSuccessfulUpdate));
  assert.ok(results.every(result => result.acquisition.freshEvidenceObtained === false
    && result.acquisition.staleFallbackUsed === false
    && result.acquisition.code === "KRAKEN_EVIDENCE_EXPIRED_BEFORE_DELIVERY"));
  assert.deepEqual(h.counts(), { sessions: 1, deviceCalls: 1, statusCalls: 1, dispatchCalls: 1, records: 1, writes: 1 });
});

test("all callers joining delayed failed publication receive delivery-time stale classification", async () => {
  const { h, results, failureObserved } = await joinedPublicationScenario({ publicationFailure: true });
  assert.equal(failureObserved, true);
  assert.ok(results.every(result => result.state.stale === true));
  assert.ok(results.every(result => result.acquisition.code === "KRAKEN_EVIDENCE_EXPIRED_BEFORE_DELIVERY"));
  assert.deepEqual(h.counts(), { sessions: 1, deviceCalls: 1, statusCalls: 1, dispatchCalls: 1, records: 1, writes: 1 });
});

test("callers joining publication inside the deadline remain fresh", async () => {
  let releasePublication;
  let publicationStarted;
  const gate = new Promise(resolve => { releasePublication = resolve; });
  const entered = new Promise(resolve => { publicationStarted = resolve; });
  const h = harness({ onWrite: async () => { publicationStarted(); await gate; } });
  const original = h.coordinator.getWithAcquisition("site-a");
  await entered;
  h.advance(59_999);
  const joined = [h.coordinator.getWithAcquisition("site-a"), h.coordinator.getWithAcquisition("site-a")];
  releasePublication();
  const results = await Promise.all([original, ...joined]);
  assert.ok(results.every(result => result.state.stale === false));
  assert.ok(results.every(result => result.acquisition.freshEvidenceObtained === true
    && result.acquisition.code === null));
  assert.deepEqual(h.counts(), { sessions: 1, deviceCalls: 1, statusCalls: 1, dispatchCalls: 1, records: 1, writes: 1 });
});

test("credential failures recover only the matching scoped in-memory snapshot", async () => {
  let missing = false;
  const h = harness({ credentialFailure: () => missing });
  const live = await h.coordinator.get("site-a");
  h.advance(60_001); missing = true;
  const recovered = await h.coordinator.get("site-a");
  assert.equal(recovered.stale, true);
  assert.equal(recovered.lastSuccessfulUpdate, live.lastSuccessfulUpdate);
  assert.equal(h.counts().records, 1);
  assert.equal(h.counts().writes, 1);
});

test("credential failures recover a matching v3 restart snapshot but never another scope", async () => {
  const previous = { vehicles: [], lastSuccessfulUpdate: "2026-10-10T09:00:00.000Z", stale: true,
    scheduleRecording: { status: "persisted", change: "initial", code: null } };
  const matchingScope = JSON.stringify(["site-a", "account-a"]);
  const matching = harness({ compatible: previous, compatibleScope: matchingScope, credentialFailure: () => true });
  assert.equal((await matching.coordinator.get("site-a")).lastSuccessfulUpdate, previous.lastSuccessfulUpdate);
  assert.equal(matching.counts().records, 0);

  const wrong = harness({ compatible: previous, compatibleScope: JSON.stringify(["site-a", "account-b"]),
    credentialFailure: () => true });
  await assert.rejects(wrong.coordinator.get("site-a"), /credentials are not configured/);
  assert.equal(wrong.counts().records, 0);
});

test("database path is injectable, absolute-only, and defaults beneath the working directory", () => {
  assert.equal(api.krakenObservationDatabasePath(undefined, "/srv/hep"),
    path.join("/srv/hep", ".cache/home-energy-platform/kraken-observations.sqlite"));
  assert.equal(api.krakenObservationDatabasePath("/data/kraken/observations.sqlite", "/ignored"),
    "/data/kraken/observations.sqlite");
  assert.throws(() => api.krakenObservationDatabasePath("relative.sqlite", "/srv/hep"), /KRAKEN_OBSERVATION_PATH_INVALID/);
  assert.throws(() => api.krakenObservationDatabasePath("", "/srv/hep"), /KRAKEN_OBSERVATION_PATH_INVALID/);
});

test("store outcomes remain separate from live freshness", async () => {
  const outcomes = [
    { status: "persisted", change: "changed", ledger: {} }, { status: "already-recorded", ledger: {} },
    { status: "rejected", code: "CAPACITY_EXCEEDED" }, { status: "busy" }, { status: "invalid" },
    { status: "store-failed" }, { status: "indeterminate" },
  ];
  for (const outcome of outcomes) {
    const h = harness({ storeResults: [outcome] });
    const state = await h.coordinator.get("site-a");
    assert.equal(state.stale, false); assert.equal(state.scheduleRecording.status, outcome.status);
    assert.equal(state.scheduleRecording.code, outcome.status === "rejected" ? outcome.code : null);
    assert.equal(h.counts().writes, 1);
  }
});

test("out-of-order rejection cannot replace an accepted compatibility snapshot", async () => {
  const h = harness({ storeResults: [{ status: "persisted", change: "initial", ledger: {} },
    { status: "rejected", code: "OVERLAPPING_OR_OUT_OF_ORDER" }] });
  const first = await h.coordinator.get("site-a"); h.advance(60_001);
  const second = await h.coordinator.get("site-a");
  assert.equal(second.stale, true); assert.equal(second.lastSuccessfulUpdate, first.lastSuccessfulUpdate);
  assert.equal(h.counts().writes, 1);
});

test("indeterminate commit is not retried or reported as durable success", async () => {
  const h = harness({ storeResults: [{ status: "indeterminate" }] });
  const state = await h.coordinator.get("site-a");
  assert.equal(state.scheduleRecording.status, "indeterminate");
  assert.deepEqual(h.counts(), { sessions: 1, deviceCalls: 1, statusCalls: 1, dispatchCalls: 1, records: 1, writes: 1 });
});

test("a genuine SQLite COMMIT followed by an exception remains indeterminate without retry", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kraken-refresh-commit-ack-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = path.join(directory, "observations.sqlite");
  const normal = loadStore().scheduleObservationStore(database);
  const initialRead = { scopeId: JSON.stringify(["site-a", "account-a"]),
    startedAt: "2026-10-11T09:00:00.000Z", retrievedAt: "2026-10-11T09:00:01.000Z",
    status: "complete", provenance: "authenticated-query", vehicles: [{ id: "ev-a", name: "EV A",
      plannedDispatches: [slot()] }] };
  assert.equal(normal.record({ siteId: "site-a", accountRef: "account-a" }, initialRead).status, "persisted");
  class CommitThenThrowDatabase extends DatabaseSync {
    exec(sql) {
      if (sql === "COMMIT") { super.exec(sql); throw Error("INJECTED_POST_COMMIT_ACK_FAILURE"); }
      return super.exec(sql);
    }
  }
  const uncertain = loadStore({ DatabaseSync: CommitThenThrowDatabase }).scheduleObservationStore(database);
  // This exercises the real commit exactly once through the refresh boundary.
  let recordCalls = 0;
  const coordinator = api.createKrakenRefreshCoordinator({
    now: () => Date.parse("2026-10-11T10:02:00Z"), accountRef: () => "account-a",
    createSession: () => ({ accountRef: "account-a", getDevices: async () => [device()],
      getImportTariff: async () => ({}),
      getVehicleStatus: async () => vehicleStatus(), getPlannedDispatchResponse: async id => ({ status: "complete",
        explicitlyEmpty: false, dispatches: [slot(undefined, "2026-10-11T13:00:00+01:00")], deviceId: id }) }),
    record: (scope, read) => { recordCalls++; return uncertain.record(scope, read); }, readCompatibility: async () => null,
    writeCompatibility: async () => {},
  });
  const state = await coordinator.get("site-a");
  assert.equal(state.scheduleRecording.status, "indeterminate");
  assert.equal(recordCalls, 1);
  const recovered = normal.read({ siteId: "site-a", accountRef: "account-a" });
  assert.equal(recovered.status, "available");
  assert.equal(recovered.ledger.latest.vehicles[0].sessions[0].end, "2026-10-11T13:00:00+01:00");
});

test("failure after SQLite recording and before JSON publication leaves prior compatibility stale", async () => {
  const previous = { vehicles: [], lastSuccessfulUpdate: "2026-10-10T09:00:00.000Z", stale: false,
    scheduleRecording: { status: "persisted", change: "initial", code: null } };
  const h = harness({ compatible: previous, onWrite: () => { throw Error("injected crash boundary"); } });
  const state = await h.coordinator.get("site-a");
  assert.equal(state.stale, true); assert.equal(state.lastSuccessfulUpdate, previous.lastSuccessfulUpdate);
  assert.equal(h.counts().records, 1); assert.equal(h.counts().writes, 1);
});

test("restart cache recovery stays stale and is never submitted to observation storage", async () => {
  const previous = { vehicles: [], lastSuccessfulUpdate: "2026-10-10T09:00:00.000Z", stale: true,
    scheduleRecording: { status: "persisted", change: "initial", code: null } };
  const h = harness({ compatible: previous, statusFailure: true });
  const state = await h.coordinator.get("site-a");
  assert.equal(state.stale, true); assert.equal(state.lastSuccessfulUpdate, previous.lastSuccessfulUpdate);
  assert.equal(h.counts().records, 0); assert.equal(h.counts().writes, 0);
});

test("site and opaque account identity isolate flights and persisted scopes", async () => {
  const scopes = [];
  const a = harness({ accountRef: "opaque-a", onRecord: scope => scopes.push(scope) });
  const b = harness({ accountRef: "opaque-b", onRecord: scope => scopes.push(scope) });
  await Promise.all([a.coordinator.get("site-a"), a.coordinator.get("site-b"), b.coordinator.get("site-a")]);
  assert.deepEqual(plain(scopes), [
    { siteId: "site-a", accountRef: "opaque-a" }, { siteId: "site-b", accountRef: "opaque-a" },
    { siteId: "site-a", accountRef: "opaque-b" },
  ]);
});

test("real SQLite integration records initial, replay, unchanged and revised schedules", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kraken-refresh-integration-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = loadStore().scheduleObservationStore(path.join(directory, "observations.sqlite"));
  let compatible = null;
  const run = async (now, dispatches) => api.createKrakenRefreshCoordinator({
    now: () => now,
    accountRef: () => "account-a",
    createSession: () => ({ accountRef: "account-a", getDevices: async () => [device()],
      getImportTariff: async () => ({}),
      getVehicleStatus: async () => vehicleStatus(), getPlannedDispatchResponse: async id =>
        ({ status: "complete", explicitlyEmpty: dispatches.length === 0, dispatches, deviceId: id }) }),
    record: (scope, read) => store.record(scope, read),
    readCompatibility: async () => compatible,
    writeCompatibility: async (_scope, state) => { compatible = structuredClone(state); },
  }).get("site-a");
  const initialTime = Date.parse("2026-10-11T10:00:00Z");
  assert.equal((await run(initialTime, [slot()])).scheduleRecording.change, "initial");
  assert.equal((await run(initialTime, [slot()])).scheduleRecording.status, "already-recorded");
  assert.equal((await run(initialTime + 70_000, [slot()])).scheduleRecording.change, "unchanged");
  const revised = await run(initialTime + 140_000, [slot(undefined, "2026-10-11T13:00:00+01:00")]);
  assert.equal(revised.scheduleRecording.change, "changed");
  const ledger = store.read({ siteId: "site-a", accountRef: "account-a" }).ledger;
  assert.equal(ledger.revisions.length, 1);
  assert.equal(ledger.latest.vehicles[0].sessions[0].energyAddedKwh, "-2.3000");
  assert.equal(ledger.latest.vehicles[0].sessions[0].end, "2026-10-11T13:00:00+01:00");
});
