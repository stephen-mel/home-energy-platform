import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
import path from 'node:path';
function load(file, dependencies, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, URLSearchParams, ...globals, require(name) { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return exports;
}
const state = load('src/lib/tesla/oauth-state.ts', { 'node:crypto': crypto });
test('OAuth state rejects missing, mismatch, expiry, wrong browser and replay', () => {
  const a = state.issueTeslaOAuthState(1000), b = state.issueTeslaOAuthState(1000);
  assert.equal(state.consumeTeslaOAuthState(null, a.binding, 1001), false);
  assert.equal(state.consumeTeslaOAuthState(a.state, null, 1001), false);
  assert.equal(state.consumeTeslaOAuthState(a.state, b.binding, 1001), false);
  assert.equal(state.consumeTeslaOAuthState(b.state, a.binding, 1001), false);
  assert.equal(state.consumeTeslaOAuthState(a.state, a.binding, 1001), true);
  assert.equal(state.consumeTeslaOAuthState(a.state, a.binding, 1001), false);
  assert.equal(state.consumeTeslaOAuthState(b.state, b.binding, 301000), false);
});
test('callback validates and consumes state before exchange or token replacement, including failed exchange', async () => {
  let calls = 0, writes = 0;
  const route = load('src/app/api/tesla/callback/route.ts', {
    '../../../../lib/tesla/oauth-state': state,
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    'fs/promises': { writeFile: async () => { writes++; } }, path: { default: path },
  }, { process: { env: { TESLA_CLIENT_ID: 'test-client', TESLA_CLIENT_SECRET: 'test-only' }, cwd: () => '/unused' },
    fetch: async () => { calls++; return { ok: false, status: 500 }; } });
  const req = (s, binding) => ({ nextUrl: new URL(`http://localhost/api/tesla/callback?code=test${s ? `&state=${s}` : ''}`), cookies: { get: () => binding ? { value: binding } : undefined } });
  assert.equal((await route.GET(req(null, null))).status, 400);
  const a = state.issueTeslaOAuthState();
  assert.equal((await route.GET(req(a.state, 'bad'))).status, 400);
  assert.equal(calls, 0); assert.equal(writes, 0);
  assert.equal((await route.GET(req(a.state, a.binding))).status, 500); assert.equal(calls, 1);
  assert.equal((await route.GET(req(a.state, a.binding))).status, 400); assert.equal(calls, 1); assert.equal(writes, 0);
});
test('login binds state to HttpOnly short-lived SameSite cookie without adding scopes', async () => {
  const route = load('src/app/api/tesla-login/route.ts', {
    '../../../lib/tesla/oauth-state': state,
    'next/server': { NextResponse: { redirect: url => ({ url, cookies: { set: (...args) => { captured = args; } }, headers: { set() {} } }) } },
  }, { process: { env: { TESLA_CLIENT_ID: 'test-client' } } });
  let captured;
  const result = await route.GET({ nextUrl: new URL('https://localhost/api/tesla-login') });
  const url = new URL(result.url);
  assert.equal(url.searchParams.get('scope'), 'openid offline_access energy_device_data');
  assert.equal(captured[2].httpOnly, true); assert.equal(captured[2].sameSite, 'lax'); assert.equal(captured[2].secure, true);
  assert.equal(captured[2].maxAge, 300);
  assert.equal(state.consumeTeslaOAuthState(url.searchParams.get('state'), captured[1]), true);
});
