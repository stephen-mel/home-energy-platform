import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/lib/financial/electricity-overview.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, structuredClone, Object, Map, Date, Number, Error, require() { throw Error("No dependencies"); } });
const { calculateElectricityFinancialOverview: calculate } = exports;
const price = amount => ({ amount, currency: "GBP", unit: "kWh" });
const source = { provider: "eon-next-kraken", description: "verified", observedAt: "2026-10-12T18:00:00Z", stale: false };
const window = (start, end, amount, condition = "none", state = null) => ({ start, end, price: price(amount), priceStatus: "known",
  kind: condition === "none" ? "standard" : "cheap-opportunity", condition, stale: false, sources: [source], eligibilityPeriods: state ? [{ start, end,
    assessmentPeriod: { start, end }, state, sources: [source] }] : [] });
const period = { start: "2026-10-12T21:00:00Z", end: "2026-10-12T23:00:00Z" };
const signal = (state = "observed-qualified") => ({ scope: "whole-home", generatedAt: period.start, horizon: period,
  import: [window(period.start, "2026-10-12T22:00:00Z", 0.23978), window("2026-10-12T22:00:00Z", period.end, 0.0285, "scheduled-ev-charging", state)],
  export: [window(period.start, period.end, 0.175)] });
const reading = (start, end, imported, exported, quality = "measured") => ({ start, end, importKwh: imported, exportKwh: exported, quality });

test("calculates measured import, export and net cost exactly across rate boundaries", () => {
  const result = calculate({ period, signal: signal(), readings: [reading(period.start, "2026-10-12T22:00:00Z", 2, 0.5),
    reading("2026-10-12T22:00:00Z", period.end, 4, 1.5)] });
  assert.equal(result.importCost.status, "calculated");
  assert.equal(result.importCost.amount, 0.59356);
  assert.equal(result.exportEarnings.amount, 0.35);
  assert.equal(result.netCost.amount, 0.24356);
  assert.deepEqual(JSON.parse(JSON.stringify(result.coverage)), { importPercent: 100, exportPercent: 100, measured: true, complete: true });
});

test("qualified daytime SMART dispatch receives the off-peak rate", () => {
  const result = calculate({ period, signal: signal("observed-qualified"), readings: [reading(period.start, "2026-10-12T22:00:00Z", 0, 0),
    reading("2026-10-12T22:00:00Z", period.end, 10, 0)] });
  assert.equal(result.importCost.amount, 0.285);
  assert.equal(result.importCost.status, "calculated");
});

test("planned conditional SMART economics are clearly estimates, never actual", () => {
  const result = calculate({ period, signal: signal("planned-conditional"), readings: [reading(period.start, "2026-10-12T22:00:00Z", 0, 0),
    reading("2026-10-12T22:00:00Z", period.end, 10, 0)] });
  assert.equal(result.importCost.amount, 0.285);
  assert.equal(result.importCost.status, "estimated");
  assert.equal(result.netCost.status, "estimated");
});

test("a reading spanning different rate boundaries is unavailable rather than apportioned", () => {
  const result = calculate({ period, signal: signal(), readings: [reading(period.start, period.end, 6, 2)] });
  assert.equal(result.importCost.status, "unavailable");
  assert.equal(result.exportEarnings.status, "calculated");
  assert.equal(result.netCost.status, "unavailable");
});

for (const [name, order] of [["A/B/C", [0, 1, 2]], ["B/A/C", [1, 0, 2]]]) test(`overlapping readings fail closed before rate filtering: ${name}`, () => {
  const supplied = [reading(period.start, period.end, 100, null),
    reading(period.start, "2026-10-12T22:00:00Z", 2, 0),
    reading("2026-10-12T22:00:00Z", period.end, 4, 0)];
  const result = calculate({ period, signal: signal(), readings: order.map(index => supplied[index]) });
  assert.equal(result.importCost.status, "unavailable"); assert.equal(result.importCost.amount, null);
  assert.equal(result.exportEarnings.status, "unavailable"); assert.equal(result.netCost.status, "unavailable");
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.importPercent, 0);
  assert.ok(result.limitations.some(value => value.includes("Overlapping energy readings conflict")));
});

test("valid adjacent readings remain accepted after global overlap validation", () => {
  const result = calculate({ period, signal: signal(), readings: [
    reading(period.start, "2026-10-12T22:00:00Z", 2, 0),
    reading("2026-10-12T22:00:00Z", period.end, 4, 0),
  ] });
  assert.equal(result.importCost.status, "calculated"); assert.equal(result.importCost.amount, 0.59356);
  assert.equal(result.exportEarnings.status, "calculated"); assert.equal(result.coverage.complete, true);
});

test("missing and partial energy data report coverage without invented totals", () => {
  const empty = calculate({ period, signal: signal(), readings: [] });
  assert.equal(empty.importCost.amount, null); assert.equal(empty.exportEarnings.amount, null); assert.equal(empty.netCost.amount, null);
  assert.equal(empty.coverage.complete, false); assert.equal(empty.coverage.importPercent, 0);
  const partial = calculate({ period, signal: signal(), readings: [reading(period.start, "2026-10-12T22:00:00Z", 2, null)] });
  assert.equal(partial.importCost.status, "partial"); assert.equal(partial.importCost.amount, 0.47956);
  assert.equal(partial.exportEarnings.status, "unavailable"); assert.equal(partial.netCost.status, "unavailable");
  assert.equal(partial.coverage.importPercent, 50); assert.equal(partial.coverage.exportPercent, 0);
});

test("estimated energy remains labelled estimate and future savings stay unset", () => {
  const result = calculate({ period, signal: signal(), readings: [reading(period.start, "2026-10-12T22:00:00Z", 2, 0.5, "estimated"),
    reading("2026-10-12T22:00:00Z", period.end, 4, 1.5, "estimated")] });
  assert.equal(result.importCost.status, "estimated"); assert.equal(result.exportEarnings.status, "estimated");
  assert.deepEqual(JSON.parse(JSON.stringify(result.future)), { solarSavings: null, batterySavings: null, investmentPayback: null });
});

test("dashboard card reports unavailable totals, coverage and verified rates honestly", () => {
  const result = calculate({ period, signal: signal(), readings: [] });
  const local = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/lib/presentation/local-time.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: local, Intl, Date, RangeError });
  const component = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/components/FinancialOverview.tsx", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports: component, Intl, require(name) {
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "../lib/presentation/local-time") return local;
    throw Error(`Unexpected dependency: ${name}`);
  } });
  const html = renderToStaticMarkup(component.default({ overview: result, timeZone: "Europe/London" }));
  assert.match(html, /Financial overview/); assert.match(html, /Grid import cost/);
  assert.equal((html.match(/Unavailable/g) ?? []).length, 3);
  assert.match(html, /Import data coverage:.*0%/); assert.match(html, /Export data coverage:.*0%/);
  assert.match(html, /23\.978p\/kWh/); assert.match(html, /2\.85p\/kWh/); assert.match(html, /17\.5p\/kWh/);
  assert.match(html, /Complete interval import and export energy readings are unavailable/);
  result.limitations.splice(0, result.limitations.length, "REPEATED_SAFE_DIAGNOSTIC", "REPEATED_SAFE_DIAGNOSTIC");
  const errors = [], original = console.error; console.error = (...values) => errors.push(values.join(" "));
  try { renderToStaticMarkup(component.default({ overview: result, timeZone: "Europe/London" })); }
  finally { console.error = original; }
  assert.equal(errors.some(value => value.includes("same key")), false);
});
