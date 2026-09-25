#!/usr/bin/env node
/* Local-only bootstrap: no app route or background registration. */
import fs from 'node:fs';
import ts from 'typescript';
import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
localRequire.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  module._compile(compiled, filename);
};
const { runLocalExperiment, safeExperimentFailureCode, safeExperimentFreshnessDetails } = localRequire('../src/lib/tesla-tariff/supervised-local.ts');
runLocalExperiment(process.argv.slice(2)).catch(error => {
  console.error(safeExperimentFailureCode(error));
  for (const detail of safeExperimentFreshnessDetails(error)) console.error(detail);
  console.error('Experiment stopped. No retry was made. If an attempt journal exists, inspect it and the Tesla app before any further action.');
  process.exitCode = 1;
});
