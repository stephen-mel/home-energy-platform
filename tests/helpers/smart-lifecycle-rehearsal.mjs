// Test-only environment for unchanged production modules. No private commit
// export, capability fabrication, production flag or real network fallback.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import io from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import * as sqlite from 'node:sqlite';
import ts from 'typescript';

const repo=path.resolve(import.meta.dirname,'../..');
const fixture=JSON.parse(fs.readFileSync(path.join(repo,'tests/fixtures/tesla-q7-sept23.json'),'utf8'));
const compiled=new Map();
export const SITE='12345';
export const DEVICE='rehearsal-ev';
export const databaseRelative='.cache/home-energy-platform/tesla-smart-ownership/ownership.sqlite';
export const journalRelative=`.cache/home-energy-platform/tesla-experiments/site-${SITE}.jsonl`;
export const copy=value=>structuredClone(value);
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
export const dispatch=(start='2026-09-23T08:00:00Z',end='2026-09-23T10:00:00Z')=>({start,end,type:'SMART',energyAddedKwh:'-4.6'});
// Synthetic site, never load the application's real site identity/configuration.
const site={id:'rehearsal',name:'Rehearsal',integrations:{
  kraken:{enabled:true,wholeHomeDispatchRate:{enabled:true,importPrice:null}},
  tesla:{enabled:true,energySiteId:SITE},homeAssistant:{enabled:false,assets:[]},
},tariff:{timeZone:'Europe/London',normalImport:null,export:null,versions:[{
  id:'rehearsal-september',name:'September fixture',provider:'eon-next',
  effectiveFrom:'2026-09-22T00:00:00+01:00',effectiveTo:'2026-10-01T00:00:00+01:00',pricesIncludeVat:true,
  normalImport:{amount:0.2518,currency:'GBP',unit:'kWh'},export:{amount:0.175,currency:'GBP',unit:'kWh'},
  scheduledChargingImport:{amount:0.0299,currency:'GBP',unit:'kWh'},standingCharge:{amount:0.6,currency:'GBP',unit:'day'},
  dailyImportWindows:[{start:'00:00',end:'06:00',kind:'guaranteed-off-peak',price:{amount:0.0299,currency:'GBP',unit:'kWh'}}],
}]}};

export async function rehearsal(workspace,options={}) {
  assert.equal(process.versions.node,'26.8.2');
  const root=path.resolve(workspace);
  await io.mkdir(root,{recursive:true,mode:0o700});
  const home=path.resolve(root,options.subdirectory??'.');
  let cwd=home, clock=Date.parse(options.at??'2026-09-23T07:30:00Z');
  let currentDispatch=copy(options.dispatch??dispatch()), tariff=copy(options.tariff??fixture.before.tariff);
  const trace={events:[],posts:[],requests:[],prompts:[],approvals:[],output:[],contexts:[],initial:[],classified:[],
    capabilities:[],results:[],issuances:[],finalisations:[],persistence:[],persistenceCalls:0,ownershipReads:0,runs:0,violations:[]};
  function deny(message){trace.violations.push(message);throw Error(message);}
  function scoped(file){
    if(typeof file!=='string')return deny('REHEARSAL_UNSUPPORTED_PATH');
    const resolved=path.resolve(file);
    if(resolved!==root&&!resolved.startsWith(root+path.sep))return deny('REHEARSAL_PATH_ESCAPE');
    // Do not allow a symlink to turn a scoped pathname into a real-store access.
    let part=resolved;
    while(part!==path.dirname(root)){
      try{assert.equal(fs.lstatSync(part).isSymbolicLink(),false,'REHEARSAL_SYMLINK');}
      catch(error){if(error.code!=='ENOENT')throw error;}
      part=path.dirname(part);
    }
    return resolved;
  }
  await io.mkdir(scoped(home),{recursive:true,mode:0o700});
  await io.writeFile(scoped(path.join(home,'.tesla-tokens.json')),JSON.stringify({access_token:'SYNTHETIC_REHEARSAL_ONLY'}),{mode:0o600});
  const advance=()=>{clock+=1000;};
  class ControlledDate extends Date {
    constructor(...args){super(...(args.length?args:[clock]));}
    static now(){return clock;}
  }
  const scopedIO={
    mkdir:(file,...args)=>io.mkdir(scoped(file),...args),
    readFile:(file,...args)=>io.readFile(scoped(file),...args),
    writeFile:(file,...args)=>io.writeFile(scoped(file),...args),
    async open(file,mode,...args){
      const handle=await io.open(scoped(file),mode,...args);
      const phase=mode==='wx'?'initial':mode==='a'?'classified':'directory';
      trace.events.push(`${phase}:open`);
      return Object.fromEntries(['writeFile','sync','close'].map(method=>[method,async(...values)=>{
        const result=await handle[method](...values);
        trace.events.push(`${phase}:${method}`);
        if(phase==='classified'&&method==='close'&&options.journalCloseFailure)throw Error('INJECTED_CLASSIFIED_CLOSE');
        return result;
      }]));
    },
  };
  const scopedFS={lstatSync:(file)=>fs.lstatSync(scoped(file)),mkdirSync:(file,...args)=>fs.mkdirSync(scoped(file),...args),
    openSync:(file,...args)=>fs.openSync(scoped(file),...args),closeSync:fs.closeSync};
  class ScopedDatabase extends sqlite.DatabaseSync {
    constructor(file,...args){super(scoped(file),...args);}
    exec(sql){const result=super.exec(sql);trace.events.push(`sqlite:${sql}`);return result;}
    close(){super.close();trace.events.push('sqlite:close');}
  }
  const processView={versions:process.versions,cwd:()=>cwd,env:{},stdin:{isTTY:true},stdout:{isTTY:true},stderr:{isTTY:true},
    getBuiltinModule(name){if(name!=='node:sqlite')return deny('REHEARSAL_NATIVE_DENIED');return {...sqlite,DatabaseSync:ScopedDatabase};}};
  async function simulatedFetch(url,request){
    const base=`https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/energy_sites/${SITE}/`;
    const isRead=url===base+'site_info'&&request?.method==='GET'&&request.body===undefined;
    const isWrite=url===base+'time_of_use_settings'&&request?.method==='POST'&&typeof request.body==='string';
    if(!isRead&&!isWrite)return deny('REHEARSAL_NETWORK_DENIED');
    assert.equal(request.headers.Authorization,'Bearer SYNTHETIC_REHEARSAL_ONLY');
    assert.equal(request.redirect,'manual');assert.equal(request.cache,'no-store');
    trace.requests.push({method:request.method,url});advance();
    if(isWrite){
      assert.equal(trace.posts.length,0,'Only one simulated POST is allowed');
      assert.equal(trace.approvals.at(-1).payloadJson,request.body);
      trace.posts.push(request.body);trace.events.push('tesla:post');
      const submitted=JSON.parse(request.body);
      assert.deepEqual(Object.keys(submitted),['tou_settings']);
      assert.deepEqual(Object.keys(submitted.tou_settings),['tariff_content_v2']);
      if(options.outcome!=='rejected')tariff=copy(submitted.tou_settings.tariff_content_v2);
      if(options.outcome==='transformed'){
        for(const charge of Object.values(tariff.energy_charges))if(charge.rates?.hour_9_minute_0!==undefined)charge.rates.hour_9_minute_0=0.04;
      }
      const status=options.outcome==='rejected'?400:200;
      return {status,ok:status===200,async json(){return {response:options.outcome==='unknown'?{}:{result:status===200}};}};
    }
    trace.events.push(trace.posts.length?'tesla:readback':'tesla:capture');
    return {ok:true,status:200,async json(){return {response:{energy_site_id:SITE,installation_time_zone:'Europe/London',
      ...(options.outcome==='insufficient'&&trace.posts.length?{}:{tariff_content_v2:copy(tariff)})}};}};
  }
  const readline={createInterface(){
    let question=0,approvedReview;
    return {async question(prompt){
      trace.prompts.push(prompt);
      if(question++===0){
        const display=trace.output.at(-1),match=/^Exact review saved: ([^\n]+)/.exec(display);
        assert.ok(match);approvedReview=JSON.parse(await io.readFile(scoped(match[1]),'utf8'));
        assert.ok(display.includes(`Payload SHA-256: ${sha(approvedReview.payloadJson)}`));
        assert.ok(display.includes(`Proposal SHA-256: ${sha(approvedReview.proposal.fingerprint)}`));
        assert.ok(display.includes(`Exact payload:\n${approvedReview.payloadJson}\nProduction blockers remain:`));
        assert.deepEqual(JSON.parse(approvedReview.payloadJson),{tou_settings:{tariff_content_v2:approvedReview.proposal.bound.representation}});
        assert.equal(prompt,'Type AUTOMATIC ROLLBACK IS UNPROVEN: ');
        return 'AUTOMATIC ROLLBACK IS UNPROVEN';
      }
      if(question===2){assert.equal(prompt,'Type MANUAL TESLA APP RECOVERY MAY BE REQUIRED: ');return 'MANUAL TESLA APP RECOVERY MAY BE REQUIRED';}
      assert.equal(question,3);
      const match=/^Approve this exact payload by typing:\n(EXECUTE 12345 [a-f0-9]{64})\n> $/.exec(prompt);
      assert.ok(match);trace.approvals.push(approvedReview);advance();return match[1];
    },close(){trace.events.push('terminal:close');}};
  }};
  const modules=new Map();
  let readSnapshot, trustedPersist;
  function observe(exports,name,wrapper){const original=exports[name];exports[name]=(...args)=>wrapper(original,args);}
  function load(file){
    file=path.resolve(file);
    if(modules.has(file))return modules.get(file);
    assert.ok(file.startsWith(path.join(repo,'src')+path.sep)&&file.endsWith('.ts'));
    if(file===path.join(repo,'src/lib/site/current-site.ts'))return {currentSite:copy(site)};
    const exports={};modules.set(file,exports);
    if(!compiled.has(file))compiled.set(file,ts.transpileModule(fs.readFileSync(file,'utf8'),{
      compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
    }).outputText);
    vm.runInNewContext(compiled.get(file),{exports,Error,structuredClone,Date:ControlledDate,process:processView,fetch:simulatedFetch,
      AbortSignal,console:{log(value){trace.output.push(value);}},require(name){
        if(name==='../kraken/client')return {
          async getKrakenDevices(){trace.events.push('kraken:devices');return [{id:DEVICE,name:'Rehearsal EV'}];},
          async getKrakenPlannedDispatches(id){assert.equal(id,DEVICE);trace.events.push('kraken:dispatches');return [copy(currentDispatch)];},
        };
        if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.ts'));
        const natives={'node:fs':scopedFS,'node:fs/promises':scopedIO,'node:path':path,'node:crypto':crypto,
          'node:readline/promises':readline,'@next/env':{loadEnvConfig(directory){assert.equal(directory,cwd);trace.events.push('environment:synthetic');}}};
        if(!(name in natives))return deny('REHEARSAL_DEPENDENCY_DENIED');
        return natives[name];
      }});
    const moduleName=path.basename(file);
    if(moduleName==='prepared-mutation-context.ts')observe(exports,'prepareMutationContext',async(fn,args)=>{const result=await fn(...args);trace.contexts.push(result);return result;});
    if(moduleName==='linked-experiment-records.ts'){
      for(const [name,key] of [['createLinkedInitialRecord','initial'],['createLinkedClassifiedRecord','classified']])
        observe(exports,name,(fn,args)=>{const result=fn(...args);trace[key].push(result);return result;});
      observe(exports,'preflightOwnershipDomain',(fn,args)=>{const result=fn(...args);trace.events.push(`preflight:${result.status}`);return result;});
    }
    if(moduleName==='supervised-journal.ts')observe(exports,'claimExperimentJournal',async(fn,args)=>{
      trace.events.push('journal:claim');const claimed=await fn(...args);
      return {async finish(record){const capability=await claimed.finish(record);trace.events.push('b2:complete');trace.capabilities.push(capability);return capability;}};
    });
    if(moduleName==='supervised-experiment.ts')observe(exports,'runSupervisedExperiment',async(fn,args)=>{
      trace.runs++;const result=await fn(...args);trace.results.push(result);return result;
    });
    if(moduleName==='confirmed-smart-receipt-issuer.ts')observe(exports,'issueConfirmedSmartReceipt',(fn,args)=>{
      const result=fn(...args);trace.issuances.push(result);return result;
    });
    if(moduleName==='ownership-finalisation.ts')observe(exports,'finaliseConfirmedSmartOwnership',(fn,args)=>{
      const result=fn(...args);trace.finalisations.push(result);return result;
    });
    if(moduleName==='ownership-sqlite.ts'){
      readSnapshot=exports.readOwnership;trustedPersist=exports.persistConfirmedSmart;
      observe(exports,'readOwnership',(fn,args)=>{trace.ownershipReads++;return fn(...args);});
      observe(exports,'persistConfirmedSmart',(fn,args)=>{
        trace.persistenceCalls++;trace.events.push('persistence:enter');
        options.beforePersistence?.();
        if(options.persistenceThrow==='before')throw Error('INJECTED_PRE_COMMIT_SECRET');
        const result=fn(...args);trace.persistence.push(result);
        if(options.persistenceThrow==='after'){assert.equal(result.status,'persisted');throw Error('INJECTED_POST_COMMIT_ACK_FAILURE');}
        return result;
      });
    }
    return exports;
  }
  const local=load(path.join(repo,'src/lib/tesla-tariff/supervised-local.ts'));
  return {root:home,trace,simulatedFetch,
    get tariff(){return copy(tariff);},
    get summary(){const value=trace.output.at(-1);return value?.startsWith('{')?JSON.parse(value):null;},
    setDispatch(value){currentDispatch=copy(value);},
    snapshot(){return readSnapshot(scoped(path.join(home,databaseRelative)),SITE);},
    completion(){const r=trace.results.at(-1);return load(path.join(repo,'src/lib/tesla-tariff/supervised-journal.ts')).journalCompletionForRecords(r.journalCompletion,r.initialRecord,r.record);},
    // Evidence-only replay; no executor invocation. Used also for a competing
    // genuine append into an explicitly isolated parent case directory.
    replay(destination=home){
      const previous=cwd;cwd=scoped(destination);
      try{const r=trace.results.at(-1);return trustedPersist(r.journalCompletion,r.initialRecord,r.record);}
      finally{cwd=previous;}
    },
    async run(){
      try{return await local.runLocalExperiment(['--site',SITE,'--vehicle',DEVICE,'--dispatch-start',currentDispatch.start,'--execute-supervised']);}
      finally{assert.deepEqual(trace.violations,[],'Isolation guard fired (including failures caught by production code)');}
    },
  };
}
