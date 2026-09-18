import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

function load(path, globals, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(name) {
    assert.ok(name in dependencies, `Forbidden dependency: ${name}`);
    return dependencies[name];
  }, ...globals });
  return exports;
}
function timers() {
  const pending = new Map(); let id = 0;
  return { pending, setTimeout(fn, ms) { pending.set(++id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    setInterval(fn, ms) { pending.set(++id, { fn, ms }); return id; },
    clearInterval(id) { pending.delete(id); } };
}
function fixture(env = { HOME_ASSISTANT_URL: 'http://ha.test', HOME_ASSISTANT_TOKEN: 'secret-token' }) {
  const sockets = []; const clock = timers();
  class Socket {
    sent = []; closed = false;
    constructor(url) { this.url = String(url); sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.closed = true; }
    receive(data) { this.onmessage({ data: JSON.stringify(data) }); }
  }
  const liveModule = load('src/lib/home-assistant/live.ts', {
    ...clock, WebSocket: Socket, ReadableStream, TextEncoder, URL, process: { env },
  }, { 'server-only': {} });
  const config = { enabled: true, assets: [{ id: 'one', metrics: [{ entityId: 'sensor.a' }] },
    { id: 'two', metrics: [{ entityId: 'sensor.b' }, { entityId: 'sensor.a' }] }] };
  const abort = new AbortController();
  const stream = liveModule.createHomeAssistantStream(config, abort.signal);
  const reader = stream.getReader();
  return { sockets, clock, abort, reader, liveModule, config, async read() {
    const result = await reader.read(); return result.done ? null : new TextDecoder().decode(result.value);
  } };
}
function authenticate(ws) {
  ws.receive({ type: 'auth_required' }); ws.receive({ type: 'auth_ok' });
  ws.receive({ type: 'result', id: 1, success: true });
}

test('authenticates server-side, filters snapshot/events, resyncs and handles deleted sensors', async () => {
  const f = fixture(); const ws = f.sockets[0];
  assert.equal(ws.url, 'ws://ha.test/api/websocket'); authenticate(ws);
  assert.equal(ws.sent[0].access_token, 'secret-token');
  assert.deepEqual(ws.sent.map(x => x.type), ['auth', 'subscribe_events', 'get_states']);
  const event = (id, state) => ws.receive({ type: 'event', id: 1, event: {
    event_type: 'state_changed', data: { entity_id: id, new_state: state === null ? null : { state } },
  } });
  event('sensor.a', '9');
  ws.receive({ type: 'result', id: 2, success: true, result: [
    { entity_id: 'sensor.a', state: '1', attributes: { secret: 'private' } },
    { entity_id: 'sensor.b', state: 'unavailable' }, { entity_id: 'unconfigured', state: '77' },
  ] });
  assert.equal(await f.read(), 'event: metrics\ndata: {"sensor.a":9,"sensor.b":null}\n\n');
  assert.match(await f.read(), /live/);
  event('unconfigured', '99'); event('sensor.b', '-2.5');
  assert.match(await f.read(), /"sensor.b":-2.5/);
  event('sensor.a', null); assert.match(await f.read(), /"sensor.a":null/);
  f.abort.abort(); assert.equal(ws.closed, true); assert.equal(f.clock.pending.size, 0);
  assert.equal(await f.read(), null);
});

test('missing configuration/auth failure is terminal and emits no secrets', async () => {
  for (const missing of [true, false]) {
    const f = fixture(missing ? {} : undefined);
    if (!missing) f.sockets[0].receive({ type: 'auth_invalid', message: 'secret-token' });
    assert.equal(await f.read(), 'event: status\ndata: {"state":"unavailable"}\n\n');
    assert.equal(await f.read(), null); assert.equal(f.clock.pending.size, 0);
  }
});

test('handshake timeout, malformed messages, cancellation and silent socket all clean up', async () => {
  for (const mode of ['timeout', 'malformed', 'cancel', 'heartbeat', 'error']) {
    const f = fixture(); const ws = f.sockets[0];
    if (mode === 'timeout') [...f.clock.pending.values()][0].fn();
    if (mode === 'malformed') ws.onmessage({ data: '{' });
    if (mode === 'cancel') await f.reader.cancel();
    if (mode === 'error') ws.onerror();
    if (mode === 'heartbeat') {
      authenticate(ws); ws.receive({ type: 'result', id: 2, success: true, result: [] });
      await f.read(); await f.read();
      const beat = [...f.clock.pending.values()][0].fn;
      beat(); assert.equal(ws.sent.at(-1).type, 'ping'); beat();
    }
    assert.equal(ws.closed, true); assert.equal(f.clock.pending.size, 0);
  }
});

test('disabled and empty sites create no WebSocket', async () => {
  const f = fixture(); f.abort.abort();
  for (const config of [{ enabled: false, assets: f.config.assets }, { enabled: true }]) {
    const reader = f.liveModule.createHomeAssistantStream(config, new AbortController().signal).getReader();
    await reader.read(); assert.equal((await reader.read()).done, true);
  }
  assert.equal(f.sockets.length, 1);
});

test('browser retries with capped backoff, closes native retry, stops on terminal failure/unmount', () => {
  const clock = timers(); const sources = []; const statuses = []; const values = [];
  class Source {
    handlers = {}; closed = false;
    constructor(url) { assert.equal(url, '/api/home-assistant-stream'); sources.push(this); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    close() { this.closed = true; }
    emit(type, data) { this.handlers[type]({ data: JSON.stringify(data) }); }
  }
  const { watchHomeAssistant } = load('src/lib/home-assistant/browser-stream.ts', {
    ...clock, EventSource: Source, Math: { ...Math, min: Math.min, random: () => 0 }, Date,
  });
  const stop = watchHomeAssistant(v => values.push(v), s => statuses.push(s));
  sources[0].emit('metrics', { 'sensor.a': 4 }); assert.equal(values[0]['sensor.a'], 4);
  for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    const source = sources.at(-1); source.onerror(); assert.equal(source.closed, true);
    assert.equal(clock.pending.size, 1);
    const [id, timer] = [...clock.pending][0]; assert.equal(timer.ms, delay);
    clock.pending.delete(id); timer.fn();
  }
  sources.at(-1).emit('status', { state: 'unavailable' });
  assert.equal(clock.pending.size, 0); assert.equal(statuses.at(-1), 'unavailable'); stop();
  const stop2 = watchHomeAssistant(() => {}, () => {}); sources.at(-1).onerror(); stop2();
  assert.equal(clock.pending.size, 0);
});

test('route rejects cross-origin access and resolves configuration without site state or Kraken', async () => {
  let streams = 0; let enabled = true;
  const { GET } = load('src/app/api/home-assistant-stream/route.ts', { URL, Response }, {
    '../../../lib/site/repository': { getCurrentSite: async () => ({ integrations: {
      homeAssistant: { enabled, assets: [{ metrics: [{}] }] },
    } }) },
    '../../../lib/home-assistant/live': { createHomeAssistantStream() { streams++; return 'stream'; } },
  });
  assert.equal((await GET(new Request('http://app.test/api', { headers: { origin: 'http://evil.test' } }))).status, 403);
  assert.equal(streams, 0); enabled = false;
  assert.equal((await GET(new Request('http://app.test/api'))).status, 204);
  assert.equal(streams, 0); enabled = true;
  const response = await GET(new Request('http://app.test/api', { headers: { 'sec-fetch-site': 'same-origin' } }));
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform'); assert.equal(streams, 1);
});


test('HA cards render the initial server snapshot before any browser connection', () => {
  const { default: Cards } = load('src/components/HomeEnergyTelemetry.tsx', {}, {
    react: React, 'react/jsx-runtime': jsxRuntime,
    '../lib/site/home-assistant-metrics': load('src/lib/site/home-assistant-metrics.ts', {}),
    '../lib/home-assistant/browser-stream': { watchHomeAssistant() { throw new Error('No connection during SSR'); } },
  });
  const html = renderToStaticMarkup(React.createElement(Cards, { initial: { assets: [
    { id: 'a', name: 'Meter', metrics: [{ entityId: 'sensor.a', label: 'Import', unit: 'kW', decimals: 2, value: 1.25 }] },
    { id: 'b', name: 'Other asset', metrics: [{ entityId: 'sensor.b', label: 'Reading', unit: '%', decimals: 0, value: null }] },
  ] } }));
  assert.match(html, /1.25 kW/); assert.match(html, /Other asset/); assert.match(html, /Unavailable/);
});
