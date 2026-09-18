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
async function fixture(t, override = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'kraken-cache-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = load('src/lib/site/kraken-state-store.ts', {
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
const plain = value => JSON.parse(JSON.stringify(value));

test('restart recovery uses persisted state only after live failure; success replaces it and keeps 60-second cache', async t => {
  const { store, file } = await fixture(t);
  let now = Date.parse(state().lastSuccessfulUpdate); let fail = false; let calls = 0;
  let vehicle = state().vehicles[0];
  const client = {
    getKrakenDevices: async () => { calls++; if (fail) throw new Error('Timeout'); return [vehicle]; },
    getKrakenVehicleStatus: async () => vehicle.status,
    getKrakenPlannedDispatches: async () => vehicle.plannedDispatches,
  };
  const boot = () => load('src/lib/site/kraken-state.ts', {
    '../kraken/client': client, './kraken-state-store': store,
  }, { Date: class extends Date { static now() { return now; } } });
  const firstProcess = boot();
  const first = await firstProcess.getKrakenState();
  assert.equal(first.stale, false);
  assert.equal((JSON.parse(await fs.readFile(file, 'utf8'))).state.lastSuccessfulUpdate, first.lastSuccessfulUpdate);
  now += 59_999;
  await firstProcess.getKrakenState(); assert.equal(calls, 1);

  // Fresh module = empty process-memory cache, while retaining the file on disk.
  fail = true; const restarted = boot();
  const recovered = await restarted.getKrakenState();
  assert.equal(calls, 2); assert.equal(recovered.stale, true);
  assert.equal(recovered.lastSuccessfulUpdate, first.lastSuccessfulUpdate);
  assert.deepEqual(plain(recovered.vehicles), plain(first.vehicles));
  const stillStale = await restarted.getKrakenState();
  assert.equal(calls, 3); assert.equal(stillStale.stale, true);

  fail = false; now += 1;
  vehicle = { ...vehicle, status: { ...vehicle.status, stateOfCharge: { value: 65 } } };
  const fresh = await restarted.getKrakenState();
  assert.equal(fresh.stale, false); assert.equal(calls, 4);
  assert.equal(fresh.lastSuccessfulUpdate, new Date(now).toISOString());
  assert.equal(fresh.vehicles[0].status.stateOfCharge.value, 65);
  assert.equal((await store.readLastKnownKrakenState()).vehicles[0].status.stateOfCharge.value, 65);
  now += 59_999; await restarted.getKrakenState(); assert.equal(calls, 4);
  now += 1; await restarted.getKrakenState(); assert.equal(calls, 5);
  fail = true;
  assert.equal((await boot().getKrakenState()).stale, true);
});

test('missing, corrupt, unsupported or invalid persisted data is a safe cache miss', async t => {
  const { store, file } = await fixture(t);
  assert.equal(await store.readLastKnownKrakenState(), null);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const badVehicle = state(); badVehicle.vehicles[0].status.isSuspended = 'false';
  const badSchedule = state(); badSchedule.vehicles[0].preferences.schedules[0].max = '80';
  const invalid = [
    '{broken', 'null', '{}', JSON.stringify({ version: 2, state: state() }),
    JSON.stringify({ version: 1, state: { ...state(), lastSuccessfulUpdate: 'yesterday' } }),
    JSON.stringify({ version: 1, state: { ...state(), vehicles: [{}] } }),
    JSON.stringify({ version: 1, state: badVehicle }), JSON.stringify({ version: 1, state: badSchedule }),
  ];
  for (const contents of invalid) {
    await fs.writeFile(file, contents);
    assert.equal(await store.readLastKnownKrakenState(), null);
    const kraken = load('src/lib/site/kraken-state.ts', {
      './kraken-state-store': store,
      '../kraken/client': { getKrakenDevices: async () => { throw new Error('Offline'); } },
    });
    await assert.rejects(kraken.getKrakenState(), /Offline/);
  }
});

test('writes only allowlisted fields; permissions are private; stale and invalid writes preserve good cache', async t => {
  const { store, file } = await fixture(t);
  const input = state(); input.token = 'SECRET'; input.vehicles[0].auth = { token: 'SECRET' };
  input.vehicles[0].status.stateOfCharge.accessToken = 'SECRET';
  await store.writeLastKnownKrakenState(input);
  const raw = await fs.readFile(file, 'utf8');
  assert.equal(raw.includes('SECRET'), false);
  assert.equal(raw.includes('stale'), false);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(plain(await store.readLastKnownKrakenState()), { ...state(), stale: true });
  await store.writeLastKnownKrakenState({ ...state(), stale: true });
  await store.writeLastKnownKrakenState({ ...state(), vehicles: [{}] });
  assert.equal(await fs.readFile(file, 'utf8'), raw);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['kraken-state.json']);
});

test('disk write/rename/read failures do not hide live data or damage the previous file', async t => {
  let deny = false;
  const { store, file } = await fixture(t, { rename: async (...args) => {
    if (deny) throw new Error('Disk failure'); return fs.rename(...args);
  } });
  await store.writeLastKnownKrakenState(state());
  const before = await fs.readFile(file, 'utf8'); deny = true;
  const kraken = load('src/lib/site/kraken-state.ts', {
    './kraken-state-store': store,
    '../kraken/client': {
      getKrakenDevices: async () => [],
      getKrakenVehicleStatus: async () => {}, getKrakenPlannedDispatches: async () => [],
    },
  });
  assert.equal((await kraken.getKrakenState()).stale, false);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['kraken-state.json']);
  const failed = await fixture(t, {
    readFile: async () => { throw new Error('Permission denied'); },
    mkdir: async () => { throw new Error('Read-only filesystem'); },
  });
  assert.equal(await failed.store.readLastKnownKrakenState(), null);
  await failed.store.writeLastKnownKrakenState(state());
});
