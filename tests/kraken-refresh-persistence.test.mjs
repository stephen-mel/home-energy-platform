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
  const source = ts.transpileModule(fs.readFileSync("src/lib/site/kraken-refresh.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {
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
          agreement: { validFrom: "2026-01-17T00:00:00Z", validTo: "2027-01-17T00:00:00Z",
            productCode: "NEXT_DRIVE_SMART_V5_2", tariffCode: "E-TOU-NEXT_DRIVE_SMART_V5_2-G", meterPointRef: "meter-a" },
          version: {}, exportStatus: "unknown" };
      } };
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
  stateOfCharge: { value: 42 }, activePower: { value: 7.1 }, stateOfChargeLimit: null });
function harness(options = {}) {
  let now = options.now ?? Date.parse("2026-10-11T10:00:00Z");
  let sessions = 0, deviceCalls = 0, statusCalls = 0, dispatchCalls = 0, records = 0, writes = 0;
  let compatible = options.compatible ?? null;
  const storeResults = [...(options.storeResults ?? [{ status: "persisted", change: "initial", ledger: {} }])];
  const sessionsByDevice = options.sessionsByDevice ?? { "ev-a": [slot()] };
  const coordinator = api.createKrakenRefreshCoordinator({
    now: () => now,
    accountRef: () => options.accountRef ?? "account-a",
    createSession: () => {
      sessions++;
      if (options.credentialFailure?.()) throw Error("E.ON credentials are not configured");
      return { accountRef: options.accountRef ?? "account-a",
        async getImportTariff() { if (options.tariffFailure) throw Error("tariff failed"); return {}; },
        async getDevices() { deviceCalls++; return options.devices ?? [device()]; },
        async getVehicleStatus() { statusCalls++; if (options.statusFailure) throw Error("status failed"); return vehicleStatus(); },
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
  return { coordinator, advance: ms => { now += ms; }, counts: () => ({ sessions, deviceCalls, statusCalls, dispatchCalls, records, writes }), compatible: () => compatible };
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

test("missing tariff evidence does not discard a complete vehicle refresh", async () => {
  const h = harness({ tariffFailure: true });
  const result = await h.coordinator.get("site-a");
  assert.equal(result.stale, false);assert.equal(result.vehicles.length, 1);
  assert.equal(result.importTariff, undefined);
  assert.deepEqual(plain(result.importTariffDiagnostic), { status: "unavailable", code: "TARIFF_RETRIEVAL_FAILED" });
  assert.equal(h.counts().records, 1);assert.equal(h.counts().writes, 1);
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

test("slow compatibility publication cannot renew authenticated retrieval freshness", async () => {
  const successful = harness({ onWrite: async (_scope, _state, clock) => clock.advance(60_001) });
  assert.equal((await successful.coordinator.get("site-a")).stale, true);
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
  const original = h.coordinator.get("site-a");
  await enteredPublication;
  h.advance(60_001);
  const joined = [h.coordinator.get("site-a"), h.coordinator.get("site-a"), h.coordinator.get("site-a")];
  releasePublication();
  const results = await Promise.all([original, ...joined]);
  return { h, results, failureObserved };
}

test("all callers joining delayed successful publication receive delivery-time stale classification", async () => {
  const { h, results } = await joinedPublicationScenario({ publicationFailure: false });
  assert.ok(results.every(result => result.stale === true));
  assert.ok(results.every(result => result.lastSuccessfulUpdate === results[0].lastSuccessfulUpdate));
  assert.deepEqual(h.counts(), { sessions: 1, deviceCalls: 1, statusCalls: 1, dispatchCalls: 1, records: 1, writes: 1 });
});

test("all callers joining delayed failed publication receive delivery-time stale classification", async () => {
  const { h, results, failureObserved } = await joinedPublicationScenario({ publicationFailure: true });
  assert.equal(failureObserved, true);
  assert.ok(results.every(result => result.stale === true));
  assert.deepEqual(h.counts(), { sessions: 1, deviceCalls: 1, statusCalls: 1, dispatchCalls: 1, records: 1, writes: 1 });
});

test("callers joining publication inside the deadline remain fresh", async () => {
  let releasePublication;
  let publicationStarted;
  const gate = new Promise(resolve => { releasePublication = resolve; });
  const entered = new Promise(resolve => { publicationStarted = resolve; });
  const h = harness({ onWrite: async () => { publicationStarted(); await gate; } });
  const original = h.coordinator.get("site-a");
  await entered;
  h.advance(59_999);
  const joined = [h.coordinator.get("site-a"), h.coordinator.get("site-a")];
  releasePublication();
  const results = await Promise.all([original, ...joined]);
  assert.ok(results.every(result => result.stale === false));
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
