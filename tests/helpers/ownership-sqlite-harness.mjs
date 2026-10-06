// TEST ONLY: VM source instrumentation exposes the private commit function.
// No test switch/export exists in the application module.
import fs from 'node:fs';
import io from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import assert from 'node:assert/strict';
if(process.versions.node!=='26.8.2')throw Error('OWNERSHIP_NODE_26_8_2_REQUIRED');
const sqlite=await import('node:sqlite');
export function loadStore(hooks = {}, version = process.versions.node) {
  const cache = new Map();
  class ControlledDatabase extends sqlite.DatabaseSync {
    exec(sql) { hooks.beforeExec?.(sql); const out=super.exec(sql); hooks.afterExec?.(sql); return out; }
    prepare(sql) {
      const statement=super.prepare(sql);
      return new Proxy(statement,{get:(target,key)=>{const value=target[key];
        return typeof value==='function' ? (...args)=>{hooks.beforeStatement?.(sql,key,this);const out=value.apply(target,args);hooks.afterStatement?.(sql,key,this);return out;} : value;}});
    }
    close() { super.close(); hooks.afterClose?.(); }
  }
  function load(file) {
    file=path.resolve(file); if(cache.has(file))return cache.get(file);
    let source=fs.readFileSync(file,'utf8');
    if(file.endsWith('/ownership-sqlite.ts'))source+='\nexport { commitOwnership as testCommit };';
    const exports={}; cache.set(file,exports);
    vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
      {exports,Error,structuredClone,Date,process:{versions:{node:version},cwd:()=>hooks.cwd ?? process.cwd(),getBuiltinModule(name){
        assert.equal(name,'node:sqlite');return {...sqlite,DatabaseSync:ControlledDatabase};}}, require(name){
        if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.ts'));
        const allowed={'node:fs':fs,'node:fs/promises':io,'node:path':path,'node:crypto':crypto};
        assert.ok(name in allowed,`Unexpected native dependency (no network transport): ${name}`);return allowed[name];
      }});return exports;
  }
  return {load,...load('src/lib/tesla-tariff/ownership-sqlite.ts')};
}
export const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function evidence(empty=false) {
  return {version:1,energySiteId:'12345',timeZone:'Europe/London',createdAt:'2026-09-23T08:00:00Z',updatedAt:'2026-09-23T08:00:02Z',validUntil:'2026-09-23T23:00:00Z',basis:'confirmed-write-readback',
    baselineFingerprint:'a'.repeat(64),readbackFingerprint:'b'.repeat(64),proposalFingerprint:'c'.repeat(64),smartEvidenceFingerprint:'d'.repeat(64),
    intervals:empty?[]:[{start:'2026-09-23T08:00:00Z',end:'2026-09-23T10:00:00Z',restoreBaselineFingerprint:'e'.repeat(64),applied:{amount:0.0299,currency:'GBP',unit:'kWh'},restore:{amount:0.25177,currency:'GBP',unit:'kWh'}}]};
}
export function input(id='mutation-1',expected={status:'missing'},value=evidence()) {
  return {site:'12345',expected,evidence:value,mutationId:id,issuanceKey:hash('issuance:'+id),receiptKey:hash('receipt:'+id)};
}
