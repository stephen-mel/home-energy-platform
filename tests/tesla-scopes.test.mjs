import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';
function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Buffer, TextDecoder, Response, ...globals,
    console: { log() { assert.fail('No logging'); }, error() { assert.fail('No logging'); } },
    require(name) { assert.ok(name in dependencies, `Forbidden dependency: ${name}`); return dependencies[name]; } });
  return exports;
}
const inspection = load('src/lib/tesla/inspect-scopes.ts');
const token = payload => `${Buffer.from('{"alg":"test"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const expected = ['openid', 'offline_access', 'energy_device_data', 'energy_cmds'];
const marker = 'PRIVATE_ACCOUNT_AND_TOKEN_MATERIAL';

test('locally inspects array/string scp only, including energy permission and no-permission cases', () => {
  for (const scp of [expected, expected.join(' ')]) {
    const result = inspection.inspectTeslaScopes(token({ scp, sub: marker, account_id: marker, refresh_token: marker }));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: true, scopes: expected, hasEnergyCommands: true });
    assert.ok(!JSON.stringify(result).includes(marker));
  }
  assert.equal(inspection.inspectTeslaScopes(token({ scp: ['energy_device_data'] })).hasEnergyCommands, false);
  assert.equal(inspection.inspectTeslaScopes(token({ scp: [] })).hasEnergyCommands, false);
});

test('invalid JWTs and missing/malformed/unrecognized scp return only fixed safe diagnostics', () => {
  for (const value of [undefined, null, 42, marker, 'a.b.c', 'a.@@.c', token({}).replace(/\.[^.]+$/, '')]) {
    assert.deepEqual(JSON.parse(JSON.stringify(inspection.inspectTeslaScopes(value))), { success: false, diagnostic: 'TOKEN_UNDECODABLE' });
  }
  for (const scp of [undefined, null, '', 42, {}, [42], ['energy_cmds', marker], marker]) {
    const result = inspection.inspectTeslaScopes(token({ scp, sub: marker }));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: false, diagnostic: 'SCOPES_ABSENT_OR_MALFORMED' });
    assert.ok(!JSON.stringify(result).includes(marker));
  }
});

function route(readFile) {
  return load('src/app/api/tesla/scopes/route.ts', {
    'node:fs/promises': { readFile }, 'node:path': { default: path },
    '../../../../lib/tesla/inspect-scopes': inspection,
  }, { process: { cwd: () => '/fixture' } });
}

test('endpoint reads only local stored token and returns only allowlisted response with no-store', async () => {
  const accessToken = token({ scp: expected, sub: marker, account_id: marker, exp: 0 });
  let reads = 0;
  const api = route(async (file, encoding) => {
    reads++; assert.equal(file, '/fixture/.tesla-tokens.json'); assert.equal(encoding, 'utf8');
    return JSON.stringify({ access_token: accessToken, refresh_token: marker });
  });
  const response = await api.GET();
  assert.equal(reads, 1); assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { success: true, scopes: expected, hasEnergyCommands: true });
  for (const secret of [accessToken, marker, 'access_token', 'refresh_token', 'account_id', 'sub', 'exp']) assert.ok(!body.includes(secret));
  // Expiry is deliberately not inspected: this endpoint reports scp, not validity.
});

test('file/parser/decode failures do not reflect error, file contents, token, payload or other claims', async () => {
  for (const read of [
    async () => { throw new Error(marker); }, async () => marker,
    async () => JSON.stringify({ access_token: marker, refresh_token: marker }),
    async () => JSON.stringify({ access_token: token({ scp: [marker], sub: marker }) }),
    async () => JSON.stringify({ refresh_token: marker }),
  ]) {
    const response = await route(read).GET(); const body = await response.text();
    assert.ok([422, 503].includes(response.status));
    assert.deepEqual(Object.keys(JSON.parse(body)), ['success', 'diagnostic']);
    assert.equal(JSON.parse(body).success, false); assert.ok(!body.includes(marker));
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});
