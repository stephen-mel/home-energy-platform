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
localRequire('../src/lib/tesla-tariff/supervised-local.ts').runLocalExperiment(process.argv.slice(2)).catch(error => {
  const safeCodes = new Set(['INTERACTIVE_SUPERVISION_REQUIRED', 'EXACT_SELECTION_REQUIRED', 'INVALID_ARGUMENTS',
    'FRESH_CAPTURE_AND_EVIDENCE_REQUIRED', 'CURRENT_SMART_DISPATCH_REQUIRED', 'TARGET_MISMATCH',
    'STRUCTURALLY_VALID_BOUND_PROPOSAL_REQUIRED', 'EXACT_HUMAN_APPROVAL_REQUIRED', 'STALE_APPROVAL_OR_EVIDENCE',
    'TESLA_BEFORE_STATE_CHANGED', 'SMART_EVIDENCE_CHANGED', 'CURRENT_PROPOSAL_CHANGED', 'CURRENT_SAFETY_GATE_BLOCKED',
    'APPROVAL_EXPIRED', 'APPROVAL_EXPIRED_AFTER_CLAIM', 'SUPERVISED_EXPERIMENT_GATE_BLOCKED', 'COMMON_DOMAIN_UNAVAILABLE']);
  console.error(error.code === 'EEXIST' ? 'SITE_ATTEMPT_ALREADY_RECORDED' : safeCodes.has(error.message) ? error.message : 'READ_OR_EXECUTION_FAILED');
  console.error('Experiment stopped. No retry was made. If an attempt journal exists, inspect it and the Tesla app before any further action.');
  process.exitCode = 1;
});
