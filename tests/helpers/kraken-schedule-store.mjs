import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
export function loadStore(sqliteOverride) {
 const cache=new Map();
 function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
 exports,Buffer,structuredClone,process:{versions:process.versions,cwd:process.cwd,getBuiltinModule:name=>{if(name!=='node:sqlite')throw Error('Forbidden builtin');return sqliteOverride??process.getBuiltinModule(name);}},
 require:name=>{if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.ts'));if(!['node:fs','node:path','node:crypto','node:url'].includes(name))throw Error('Forbidden dependency');return require(name);}});return exports;}
 return load('src/lib/kraken/schedule-store.ts');
}
export const scope={siteId:'synthetic-site',accountRef:'synthetic-account'};
export function read(index=0, endHour=14) {
 const startedAt=new Date(Date.UTC(2026,9,9,12)+index*10000).toISOString();
 return {scopeId:JSON.stringify([scope.siteId,scope.accountRef]),startedAt,retrievedAt:new Date(Date.parse(startedAt)+1000).toISOString(),status:'complete',provenance:'authenticated-query',vehicles:[{id:'ev-a',name:'EV A',plannedDispatches:[{start:'2026-10-09T13:00:00Z',end:`2026-10-09T${endHour}:00:00Z`,type:'SMART',energyAddedKwh:'-2.3000'}]}]};
}
