import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, dependencies, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, Buffer, console: { error() {} },
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    }, ...globals,
  });
  return exports;
}
const decimal = load('src/lib/tariff/economic-decimal.ts', {});
const resolver = load('src/lib/tariff/resolve-economic-model.ts', { './economic-decimal': decimal });
const dispatchResponse = load('src/lib/kraken/dispatch-response.ts', { '../tariff/resolve-economic-model': resolver });
async function fixture(t, override = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'kraken-cache-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = load('src/lib/site/kraken-state-store.ts', {
    '../kraken/dispatch-response': dispatchResponse,
    'server-only': {}, 'node:fs/promises': { ...fs, ...override }, 'node:path': path, 'node:crypto': crypto,
  }, { process: { cwd: () => root } });
  return { store, root, file: path.join(root, '.cache/home-energy-platform/kraken-state.json') };
}
function state() {
  return { lastSuccessfulUpdate: '2026-09-18T10:00:00.000Z', stale: false, vehicles: [{
    id: 'vehicle', name: 'Example', deviceType: 'EV', provider: 'Example',
    vehicleBatterySize: '60', chargePointPowerOutput: null,
    preferences: { schedules: [{ dayOfWeek: 'MONDAY', time: '07:00', min: null, max: 80, upperLimit: 100 }] },
    preferenceSetting: { scheduleSettings: [{ timeFrom: '00:00', timeTo: '23:30', timeStep: 30, min: '10', max: '100', step: '5' }] },
    plannedDispatches: [{ start: '2026-09-18T01:00:00Z', end: '2026-09-18T02:00:00Z', type: 'SMART', energyAddedKwh: '7' }],
    status: { currentState: 'SMART_CONTROL_NOT_AVAILABLE', isSuspended: false,
      stateOfCharge: { value: 42 }, activePower: { value: 0 } },
  }] };
}
function tariff() {
  return { status:'available',accountRef:'account',observedAt:'2026-09-18T10:00:00.000Z',exportStatus:'unknown',
    agreement:{validFrom:'2026-01-17T00:00:00.000Z',validTo:'2027-01-17T00:00:00.000Z',
      productCode:'NEXT_DRIVE_SMART_V5_2',tariffCode:'E-TOU-NEXT_DRIVE_SMART_V5_2-G',meterPointRef:'meter-a'},
    version:{id:'next_drive_smart_v5_2',name:'Next Drive Smart V5.2',provider:'eon-next-kraken',
      effectiveFrom:'2026-09-18T00:00:00.000Z',effectiveTo:'2026-09-19T00:00:00.000Z',pricesIncludeVat:true,
      normalImport:{amount:0.23978,currency:'GBP',unit:'kWh'},export:null,
      scheduledChargingImport:{amount:0.0285,currency:'GBP',unit:'kWh'},standingCharge:null,
      dailyImportWindows:[{start:'00:00',end:'06:00',kind:'guaranteed-off-peak',price:{amount:0.0285,currency:'GBP',unit:'kWh'}}]}};
}
function exportTariff() {
  return {status:'available',accountRef:'export-account',observedAt:'2026-09-18T10:00:00.000Z',
    agreement:{validFrom:'2026-10-01T23:00:00.000Z',validTo:'2027-10-01T23:00:00.000Z',
      productCode:'NEXT_EXPORT_PREMIUM_V3',tariffCode:'E-1R-NEXT_EXPORT_PREMIUM_V3-G'},
    price:{amount:0.175,currency:'GBP',unit:'kWh'}};
}
const plain = value => JSON.parse(JSON.stringify(value));
const scopeId = '["site","account"]';

test('missing, corrupt, unsupported or invalid persisted data is a safe cache miss', async t => {
  const { store, file } = await fixture(t);
  assert.equal(await store.readLastKnownKrakenState(scopeId), null);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const badVehicle = state(); badVehicle.vehicles[0].status.isSuspended = 'false';
  const badSchedule = state(); badSchedule.vehicles[0].preferences.schedules[0].max = '80';
  const invalid = [
    '{broken', 'null', '{}', JSON.stringify({ version: 3, state: state() }), JSON.stringify({ version: 1, state: state() }),
    JSON.stringify({ version: 3, scopeId, state: { ...state(), lastSuccessfulUpdate: 'yesterday' } }),
    JSON.stringify({ version: 3, scopeId, state: { ...state(), vehicles: [{}] } }),
    JSON.stringify({ version: 3, scopeId, state: badVehicle }),
    JSON.stringify({ version: 3, scopeId, state: badSchedule }),
    JSON.stringify({ version: 2, state: { ...state(), lastSuccessfulUpdate: 'yesterday' } }),
    JSON.stringify({ version: 2, state: { ...state(), vehicles: [{}] } }),
    JSON.stringify({ version: 2, state: badVehicle }), JSON.stringify({ version: 2, state: badSchedule }),
  ];
  for (const contents of invalid) {
    await fs.writeFile(file, contents);
    assert.equal(await store.readLastKnownKrakenState(scopeId), null);
  }
});

test('writes only allowlisted fields; permissions are private; stale and invalid writes preserve good cache', async t => {
  const { store, file } = await fixture(t);
  const input = state(); input.token = 'SECRET'; input.vehicles[0].auth = { token: 'SECRET' };
  input.vehicles[0].status.stateOfCharge.accessToken = 'SECRET';
  await store.writeLastKnownKrakenState(scopeId, input);
  const raw = await fs.readFile(file, 'utf8');
  assert.equal(raw.includes('SECRET'), false);
  assert.equal(raw.includes('stale'), false);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(plain(await store.readLastKnownKrakenState(scopeId)), { ...state(), stale: true });
  await store.writeLastKnownKrakenState(scopeId, { ...state(), stale: true });
  await store.writeLastKnownKrakenState(scopeId, { ...state(), vehicles: [{}] });
  assert.equal(await fs.readFile(file, 'utf8'), raw);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['kraken-state.json']);
});

test('canonical tariff evidence and vehicle data round-trip together', async t => {
  const {store}=await fixture(t);const input={...state(),importTariff:tariff(),exportTariff:exportTariff()};
  await store.writeLastKnownKrakenState(scopeId,input);
  const recovered=await store.readLastKnownKrakenState(scopeId);
  assert.equal(recovered.stale,true);assert.deepEqual(plain(recovered.importTariff),tariff());
  assert.deepEqual(plain(recovered.exportTariff),exportTariff());
  assert.deepEqual(plain(recovered.vehicles),state().vehicles);
});

test('disk write/rename/read failures do not hide live data or damage the previous file', async t => {
  let deny = false;
  const { store, file } = await fixture(t, { rename: async (...args) => {
    if (deny) throw new Error('Disk failure'); return fs.rename(...args);
  } });
  await store.writeLastKnownKrakenState(scopeId, state());
  const before = await fs.readFile(file, 'utf8'); deny = true;
  const changed = state(); changed.lastSuccessfulUpdate = '2026-09-18T10:01:00.000Z';
  await store.writeLastKnownKrakenState(scopeId, changed);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['kraken-state.json']);
  deny = false;
  await store.writeLastKnownKrakenState(scopeId, changed);
  assert.equal((await store.readLastKnownKrakenState(scopeId)).lastSuccessfulUpdate, changed.lastSuccessfulUpdate);
  const failed = await fixture(t, {
    readFile: async () => { throw new Error('Permission denied'); },
    mkdir: async () => { throw new Error('Read-only filesystem'); },
  });
  assert.equal(await failed.store.readLastKnownKrakenState(scopeId), null);
  await failed.store.writeLastKnownKrakenState(scopeId, state());
});

 test('v3 scoped cache rejects incomplete schedules and never upgrades unbound v1/v2 evidence', async t => {
  const { store, file } = await fixture(t);const good=state();await store.writeLastKnownKrakenState(scopeId,good);
  const before=await fs.readFile(file,'utf8');assert.equal(JSON.parse(before).version,3);
  for (const value of [null, undefined, [{...good.vehicles[0].plannedDispatches[0],start:'2026-02-30T01:00:00Z'}]]) {
    const bad=state();bad.vehicles[0].plannedDispatches=value;await store.writeLastKnownKrakenState(scopeId,bad);
    assert.equal(await fs.readFile(file,'utf8'),before);
    await fs.writeFile(file,JSON.stringify({version:3,scopeId,state:bad}));assert.equal(await store.readLastKnownKrakenState(scopeId),null);
    await fs.writeFile(file,before);
  }
  const empty=state();empty.vehicles[0].plannedDispatches=[];
  for (const version of [1,2]) { await fs.writeFile(file,JSON.stringify({version,state:empty}));assert.equal(await store.readLastKnownKrakenState(scopeId),null); }
  await store.writeLastKnownKrakenState(scopeId,empty);const recovered=await store.readLastKnownKrakenState(scopeId);
  assert.equal(recovered.stale,true);assert.equal(recovered.lastSuccessfulUpdate,empty.lastSuccessfulUpdate);assert.equal(recovered.vehicles[0].plannedDispatches.length,0);
  assert.equal(await store.readLastKnownKrakenState('["other","account"]'),null);
});
