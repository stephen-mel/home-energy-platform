import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/lib/financial/home-assistant-energy.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, structuredClone, Object, Array, Map, Date, Number, Error, Promise,
  require(name) { if (name === "server-only") return {}; if (name.includes("home-assistant/client")) return {}; throw Error(name); } });
const { getMeasuredGridEnergy: load } = exports;
const ids = ["sensor.grid_import", "sensor.grid_export"];
const period = { start: "2026-10-12T21:00:00.000Z", end: "2026-10-12T22:00:00.000Z" };
const start = Date.parse(period.start) - 300_000;
const rows = (delta = 0.1) => Array.from({ length: 13 }, (_, index) => ({ start: start + index * 300_000,
  end: start + (index + 1) * 300_000, change: delta, sum: (index + 1) * delta, state: 100 + (index + 1) * delta }));
const metadata = id => ({ entity_id: id, state: "101.2", attributes: { unit_of_measurement: "kWh", device_class: "energy", state_class: "total_increasing" } });
const history = () => ids.map((id, index) => [{ entity_id: id, state: "100", last_changed: new Date(start).toISOString() },
  { entity_id: id, state: index ? "100.65" : "101.3", last_changed: period.end }]);
const ports = (mutate = value => value) => ({ state: async id => metadata(id), statistics: async () => mutate({ [ids[0]]: rows(0.1), [ids[1]]: rows(0.05) }), history: async () => history() });

test("validates five-minute change/sum semantics and aggregates exactly six buckets", async () => {
  const result = await load({ importEntityId: ids[0], exportEntityId: ids[1], period }, ports());
  assert.equal(result.diagnostics.length, 0); assert.equal(result.readings.length, 2);
  assert.ok(Math.abs(result.readings[0].importKwh - 0.6) < 1e-12);
  assert.ok(Math.abs(result.readings[0].exportKwh - 0.3) < 1e-12);
  assert.equal(result.readings[0].quality, "measured");
});

test("matches cumulative history to the 20:55 guard start and bucket-end statistics", async () => {
  const result = await load({ importEntityId: ids[0], exportEntityId: ids[1], period }, ports());
  assert.equal(new Date(start).toISOString(), "2026-10-12T20:55:00.000Z");
  assert.equal(result.diagnostics.length, 0); assert.equal(result.readings.length, 2);
});

test("missing bucket produces partial channel coverage, never invented energy", async () => {
  const result = await load({ importEntityId: ids[0], exportEntityId: ids[1], period }, ports(raw => {
    raw[ids[0]].splice(3, 1); return raw;
  }));
  assert.equal(result.diagnostics.length, 0); assert.equal(result.readings.length, 2);
  assert.equal(result.readings[0].importKwh, null); assert.notEqual(result.readings[0].exportKwh, null);
  assert.notEqual(result.readings[1].importKwh, null);
});

for (const [name, mutate, code] of [
  ["duplicate", raw => { raw[ids[0]].push({ ...raw[ids[0]][2] }); return raw; }, "DUPLICATE_ENERGY_BUCKET"],
  ["overlap", raw => { raw[ids[0]][3].start = raw[ids[0]][2].start; return raw; }, "INVALID_ENERGY_STATISTICS"],
  ["negative delta", raw => { raw[ids[0]][4].change = -1; return raw; }, "INVALID_ENERGY_STATISTICS"],
  ["inconsistent sum", raw => { raw[ids[0]][4].sum += 1; return raw; }, "INCONSISTENT_CUMULATIVE_STATISTICS"],
]) test(`${name} statistics fail closed`, async () => {
  const result = await load({ importEntityId: ids[0], exportEntityId: ids[1], period }, ports(mutate));
  assert.equal(result.readings.length, 2); assert.equal(result.diagnostics[0], `IMPORT_${code}`);
  assert.ok(result.readings.every(reading => reading.importKwh === null && reading.exportKwh !== null));
});

test("invalid units and state class fail closed", async () => {
  const bad = ports(); bad.state = async id => ({ ...metadata(id), attributes: { ...metadata(id).attributes, unit_of_measurement: "Wh" } });
  const result = await load({ importEntityId: ids[0], exportEntityId: ids[1], period }, bad);
  assert.equal(result.diagnostics[0], "IMPORT_INVALID_ENERGY_SENSOR_METADATA");
});

for (const failed of ["import", "export"]) test(`invalid ${failed} preserves the other measured channel`, async () => {
  const bad = ports(); bad.state = async id => id === ids[failed === "import" ? 0 : 1]
    ? { ...metadata(id), attributes: { ...metadata(id).attributes, unit_of_measurement: "Wh" } } : metadata(id);
  const result = await load({ importEntityId: ids[0], exportEntityId: ids[1], period }, bad);
  assert.equal(result.readings.length, 2);
  for (const reading of result.readings) {
    assert.equal(reading[failed === "import" ? "importKwh" : "exportKwh"], null);
    assert.notEqual(reading[failed === "import" ? "exportKwh" : "importKwh"], null);
  }
});

for (const failed of ["import", "export"]) test(`missing ${failed} sensor preserves the other measured channel`, async () => {
  const bad = ports(); bad.state = async id => {
    if (id === ids[failed === "import" ? 0 : 1]) throw Error("missing");
    return metadata(id);
  };
  const result = await load({ importEntityId: ids[0], exportEntityId: ids[1], period }, bad);
  assert.equal(result.readings.length, 2); assert.equal(result.diagnostics[0], `${failed.toUpperCase()}_ENERGY_SENSOR_UNAVAILABLE`);
  for (const reading of result.readings) {
    assert.equal(reading[failed === "import" ? "importKwh" : "exportKwh"], null);
    assert.notEqual(reading[failed === "import" ? "exportKwh" : "importKwh"], null);
  }
});

test("cumulative counter reset fails closed", async () => {
  const bad = ports(); bad.history = async () => ids.map(id => [{ entity_id: id, state: "101" }, { entity_id: id, state: "99" }]);
  const result = await load({ importEntityId: ids[0], exportEntityId: ids[1], period }, bad);
  assert.equal(result.diagnostics[0], "IMPORT_COUNTER_RESET_OR_INVALID");
});

test("absolute bucket boundaries remain exact across the London autumn DST fold", async () => {
  const fold = { start: "2026-10-25T00:00:00.000Z", end: "2026-10-25T01:00:00.000Z" };
  const foldStart = Date.parse(fold.start) - 300_000;
  const stats = Object.fromEntries(ids.map(id => [id, Array.from({ length: 13 }, (_, index) => ({ start: foldStart + index * 300_000,
    end: foldStart + (index + 1) * 300_000, change: 0.1, sum: (index + 1) * 0.1, state: 20 + (index + 1) * 0.1 }))]));
  const result = await load({ importEntityId: ids[0], exportEntityId: ids[1], period: fold }, { state: async id => metadata(id),
    statistics: async () => stats, history: async () => ids.map(id => [{ entity_id: id, state: "20" }, { entity_id: id, state: "21.3" }]) });
  assert.equal(result.readings.length, 2); assert.equal(result.readings[1].start, "2026-10-25T00:30:00.000Z");
});

test("production millisecond timestamps are accepted while seconds and misaligned instants fail closed", async () => {
  const valid = await load({ importEntityId: ids[0], exportEntityId: ids[1], period }, ports());
  assert.equal(valid.readings.length, 2);
  for (const mutate of [
    raw => { for (const row of raw[ids[0]]) { row.start /= 1000; row.end /= 1000; } return raw; },
    raw => { raw[ids[0]][2].start += 1; raw[ids[0]][2].end += 1; return raw; },
  ]) {
    const rejected = await load({ importEntityId: ids[0], exportEntityId: ids[1], period }, ports(mutate));
    assert.ok(rejected.readings.every(reading => reading.importKwh === null));
    assert.equal(rejected.diagnostics[0], "IMPORT_INVALID_ENERGY_STATISTICS");
  }
});
