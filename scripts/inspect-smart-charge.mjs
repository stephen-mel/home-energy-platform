#!/usr/bin/env node
/* Local server-side inspection bootstrap. No executor or mutation imports. */
import fs from 'node:fs';
import Module from 'node:module';
import ts from 'typescript';
import { createRequire } from 'node:module';

const localRequire = createRequire(import.meta.url);
localRequire.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  module._compile(compiled, filename);
};

// Next resolves this marker during server builds. This dedicated local command is
// itself the server boundary, so retain the marker while resolving it locally.
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {};
  return Reflect.apply(originalLoad, this, [request, parent, isMain]);
};

let inspectSmartCharge;
let currentSite;
try {
  const { loadEnvConfig } = localRequire('@next/env');
  loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  ({ currentSite } = localRequire('../src/lib/site/current-site.ts'));
  ({ inspectSmartCharge } = localRequire('../src/lib/site/inspect-smart-charge.ts'));
} catch {
  console.error('SMART_INSPECTION_STARTUP_FAILED');
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  try {
    const result = await inspectSmartCharge(currentSite);
    if (!result || typeof result.text !== 'string') throw new Error('INVALID_INSPECTION_RESULT');
    console.log(result.text);
  } catch {
    console.error('SMART_INSPECTION_FAILED');
    process.exitCode = 1;
  }
}

Module._load = originalLoad;
