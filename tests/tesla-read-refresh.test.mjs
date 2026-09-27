import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const NOW=Date.parse('2026-09-27T11:00:00Z');
const original={access_token:'private-access',refresh_token:'private-refresh',created_at:NOW,expires_in:28800};
const replacement={access_token:'new-private-access',refresh_token:'new-private-refresh',expires_in:28800,token_type:'Bearer'};
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function harness({stored=original,respond,writeFails=false,beforeRename,renameFails=false}={}){
  let clock=NOW,sequence=0;
  const files=new Map([['/mock/.tesla-tokens.json',JSON.stringify(stored)]]),timers=new Map(),calls=[],writes=[],events=[];
  class Clock extends Date {constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
  const io={
    async readFile(name){if(!files.has(name))throw Error('private filesystem contents');return files.get(name);},
    async writeFile(name,value,options){if(writeFails)throw Error('private write failure');assert.equal(options.mode,0o600);assert.equal(options.flag,'wx');files.set(name,value);writes.push(name);},
    async rename(from,to){if(beforeRename)await beforeRename();if(renameFails)throw Error('private rename failure');assert.ok(files.has(from));files.set(to,files.get(from));files.delete(from);events.push('persist');},
    async unlink(name){files.delete(name);},
  };
  const globals={globalThis:{},Error,Date:Clock,AbortController,URLSearchParams,
    process:{cwd:()=>'/mock',env:{TESLA_CLIENT_ID:'test-client',TESLA_CLIENT_SECRET:'unused-private-secret'}},
    console:{error(){assert.fail('No logging');},log(){assert.fail('No logging');}},
    setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,at:clock+ms});return id;},clearTimeout(id){timers.delete(id);},
    async fetch(url,options){
      calls.push({url,options});
      assert.equal(options.redirect,'error');
      if(url.includes('fleet-auth')){
        assert.equal(url,'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token');assert.equal(options.method,'POST');
        assert.deepEqual([...options.body.keys()].sort(),['client_id','grant_type','refresh_token']);
        assert.equal(options.body.get('grant_type'),'refresh_token');
      }else{assert.equal(options.method,'GET');assert.match(url,/\/api\/1\/(products|energy_sites\/123\/site_info)$/);events.push('read');}
      return respond?respond(url,options,calls):{ok:true,json:async()=>url.includes('fleet-auth')?replacement:{response:{ok:true}}};
    },
  };
  function load(file,deps,extra={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{
    fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText,{...globals,...extra,exports,require(name){assert.ok(name in deps,`Unexpected import ${name}`);return deps[name];}});return exports;}
  const tokens=load('src/lib/tesla/tokens.ts',{'fs/promises':io,path:{default:{join:(...parts)=>parts.join('/')}},'node:crypto':{randomUUID:()=>String(++sequence)}});
  const callbackTokens=load('src/lib/tesla/tokens.ts',{'fs/promises':io,path:{default:{join:(...parts)=>parts.join('/')}},'node:crypto':{randomUUID:()=>String(++sequence)}});
  const client=load('src/lib/tesla/client.ts',{'./tokens':tokens});
  const reconnect=async(next)=>{
    const route=load('src/app/api/tesla/callback/route.ts',{
      '../../../../lib/tesla/oauth-state':{consumeTeslaOAuthState:()=>true,TESLA_STATE_COOKIE:'state'},
      '../../../../lib/tesla/tokens':callbackTokens,
      'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status??200})}},
    },{fetch:async()=>({ok:true,json:async()=>next})});
    return route.GET({nextUrl:{searchParams:{get:field=>field==='error'?null:'test'}},cookies:{get:()=>({value:'test'})}});
  };
  return {client,tokens,calls,writes,events,files,timers,reconnect,stored:()=>JSON.parse(files.get('/mock/.tesla-tokens.json')),
    tick(ms){clock+=ms;for(const [id,t]of [...timers])if(t.at<=clock){timers.delete(id);t.fn();}}};
}
for(const [label,remaining,expected]of [['valid',28800,0],['just outside margin',61,0],['at margin',60,1],['near expiry',20,1],['expired',-1,1]]){
  test(`${label} access token: ${expected} refresh before read`,async()=>{
    const h=harness({stored:{...original,created_at:NOW-(28800-remaining)*1000}});
    assert.equal((await h.client.getTeslaSiteInfo(123)).response.ok,true);
    assert.equal(h.calls.filter(c=>c.options.method==='POST').length,expected);
    assert.equal(h.calls.filter(c=>c.options.method==='GET').length,1);
    assert.equal(h.timers.size,0);
    if(expected){assert.deepEqual(h.events,['persist','read']);assert.equal(h.stored().refresh_token,replacement.refresh_token);assert.equal(h.stored().created_at,NOW);assert.equal(h.stored().expires_in,28800);}
  });
}
test('missing expiry metadata uses bounded auth recovery instead of inventing expiry',async()=>{
  const h=harness({stored:{access_token:original.access_token,refresh_token:original.refresh_token}});
  await h.client.getTeslaProducts();assert.equal(h.calls.length,1);
});
test('missing, empty and invalid replacement refresh tokens fail without altering credentials',async()=>{
  for(const refresh_token of [undefined,null,'','   ',123]){
    const h=harness({stored:{...original,expires_in:1,created_at:NOW-1000},respond:async()=>({ok:true,json:async()=>({...replacement,refresh_token})})});
    const before=h.stored();
    await assert.rejects(h.client.getTeslaSiteInfo(123),/^Error: TESLA_READ_UNAVAILABLE$/);
    assert.deepEqual(h.stored(),before);assert.equal(h.writes.length,0);assert.equal(h.calls.length,1);
    assert.equal(h.files.size,1);
  }
});
for(const status of [401])test(`${status} causes one refresh and one GET retry, with rejected body aborted`,async()=>{
  let reads=0,firstSignal;
  const h=harness({respond:async(url,options)=>{
    if(url.includes('fleet-auth'))return {ok:true,json:async()=>replacement};
    if(++reads===1){firstSignal=options.signal;return {ok:false,status,text(){assert.fail('No sensitive error bodies');}};}
    return {ok:true,json:async()=>({response:{ok:true}})};
  }});
  await h.client.getTeslaSiteInfo(123);assert.equal(reads,2);assert.equal(firstSignal.aborted,true);
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
});
test('rejected retry stops; proactive refresh also cannot loop on rejection',async()=>{
  for(const expired of [false,true]){
    const h=harness({stored:expired?{...original,expires_in:1,created_at:NOW-1000}:original,
      respond:async url=>url.includes('fleet-auth')?{ok:true,json:async()=>replacement}:{ok:false,status:401}});
    await assert.rejects(h.client.getTeslaSiteInfo(123),/^Error: Tesla Fleet API site info HTTP error 401$/);
    assert.equal(h.calls.filter(c=>c.options.method==='GET').length,expired?1:2);
    assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
    assert.equal(h.timers.size,0);
  }
});
test('concurrent expired reads share one refresh and persist before reading',async()=>{
  let release;
  const h=harness({stored:{...original,expires_in:1,created_at:NOW-1000},respond:async url=>url.includes('fleet-auth')
    ?new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>replacement});}):{ok:true,json:async()=>({response:{ok:true}})}});
  const a=h.client.getTeslaSiteInfo(123),b=h.client.getTeslaProducts();await flush();
  assert.equal(h.calls.length,1);release();await Promise.all([a,b]);
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);assert.equal(h.writes.length,1);
});
test('late rejection of a superseded token reuses the persisted token without another exchange',async()=>{
  let release,reads=0;
  const h=harness({respond:async url=>{
    if(url.includes('fleet-auth'))return {ok:true,json:async()=>replacement};
    reads++;if(reads===1)return new Promise(resolve=>{release=()=>resolve({ok:false,status:401});});
    return reads===2?{ok:false,status:401}:{ok:true,json:async()=>({response:{ok:true}})};
  }});
  const a=h.client.getTeslaSiteInfo(123);await flush();await h.client.getTeslaProducts();release();await a;
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
});
test('refresh failures and malformed responses remain fixed errors, preserve file and never leak secrets',async()=>{
  for(const response of [{ok:false,status:401}, {ok:true,json:async()=>{throw Error('private OAuth raw body');}},
    {ok:true,json:async()=>({access_token:'private',expires_in:null})},
    {ok:true,json:async()=>({...replacement,refresh_token:null})}]){
    const h=harness({stored:{...original,expires_in:1,created_at:NOW-1000},respond:async()=>response});
    const before=h.stored();await assert.rejects(h.client.getTeslaSiteInfo(123),/^Error: TESLA_READ_UNAVAILABLE$/);
    assert.deepEqual(h.stored(),before);assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.signal.aborted,true);
    assert.equal(h.timers.size,0);
  }
});
test('atomic persistence failure never uses unpersisted access token or replaces the old file',async()=>{
  const h=harness({stored:{...original,expires_in:1,created_at:NOW-1000},writeFails:true});
  const before=h.stored();await assert.rejects(h.client.getTeslaSiteInfo(123),/TESLA_READ_UNAVAILABLE/);
  assert.deepEqual(h.stored(),before);assert.equal(h.calls.length,1);assert.equal(h.files.size,1);
});
for(const stall of ['headers','body'])test(`refresh ${stall} stall stays inside the total 5-second read budget`,async()=>{
  const h=harness({stored:{...original,expires_in:1,created_at:NOW-1000},respond:async()=>stall==='headers'?new Promise(()=>{}):{ok:true,json:()=>new Promise(()=>{})}});
  const outcome=h.client.getTeslaSiteInfo(123).catch(e=>e.message);await flush();h.tick(5000);
  assert.equal(await outcome,'TESLA_READ_UNAVAILABLE');await flush();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.signal.aborted,true);assert.equal(h.writes.length,0);assert.equal(h.timers.size,0);
});


test('403 aborts unread body with exactly one GET, zero refresh and no auth retry',async()=>{
  const h=harness({respond:async()=>({ok:false,status:403,text(){assert.fail('No undocumented body interpretation');}})});
  await assert.rejects(h.client.getTeslaSiteInfo(123),/^Error: Tesla Fleet API site info HTTP error 403$/);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.method,'GET');assert.equal(h.calls[0].options.signal.aborted,true);
  assert.equal(h.writes.length,0);assert.equal(h.timers.size,0);
});
const generationB={access_token:'reconnect-private-access',refresh_token:'reconnect-private-refresh',expires_in:28800};
test('OAuth reconnect B committed during refresh A remains authoritative when A later attempts persistence',async()=>{
  let release;
  const h=harness({stored:{...original,expires_in:1,created_at:NOW-1000},respond:async url=>url.includes('fleet-auth')
    ?new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>replacement});}):{ok:true,json:async()=>({response:{ok:true}})}});
  const pending=h.client.getTeslaSiteInfo(123);await flush();
  assert.equal((await h.reconnect(generationB)).status,200);
  const savedB=h.stored();assert.ok(savedB.generation);assert.equal(savedB.access_token,generationB.access_token);
  release();await pending;
  assert.deepEqual(h.stored(),savedB);assert.equal(h.events.filter(e=>e==='persist').length,1);
  assert.equal(h.calls.at(-1).options.headers.Authorization,`Bearer ${generationB.access_token}`);
  assert.equal(h.files.size,1);
});
test('delayed refresh rename holds serialization after caller timeout; queued OAuth reconnect commits last',async()=>{
  let release,renames=0;
  const h=harness({stored:{...original,expires_in:1,created_at:NOW-1000},beforeRename:async()=>{
    if(++renames===1)await new Promise(resolve=>{release=resolve;});
  }});
  const pending=h.client.getTeslaSiteInfo(123).catch(e=>e.message);await flush();assert.equal(renames,1);
  h.tick(5000);assert.equal(await pending,'TESLA_READ_UNAVAILABLE');
  let reconnected=false;
  const callback=h.reconnect(generationB).then(r=>{reconnected=true;return r;});await flush();
  assert.equal(reconnected,false);assert.equal(renames,1);assert.equal(h.writes.length,1);
  assert.equal(h.stored().access_token,original.access_token);
  release();assert.equal((await callback).status,200);
  assert.equal(renames,2);assert.equal(h.stored().access_token,generationB.access_token);
  assert.equal(h.stored().refresh_token,generationB.refresh_token);assert.equal(h.files.size,1);
  assert.equal(h.calls.filter(c=>c.options.method==='GET').length,0);
});
test('failed atomic rename preserves last credentials and releases the commit queue only after cleanup',async()=>{
  const h=harness({stored:{...original,expires_in:1,created_at:NOW-1000},renameFails:true});
  const before=h.stored();await assert.rejects(h.client.getTeslaSiteInfo(123),/TESLA_READ_UNAVAILABLE/);
  assert.deepEqual(h.stored(),before);assert.equal(h.files.size,1);
  assert.equal((await h.reconnect(generationB)).status,500);assert.deepEqual(h.stored(),before);assert.equal(h.files.size,1);
});
