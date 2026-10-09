import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {fixture,horizon,generatedAt} from './fixtures/eon-offline-evidence.mjs';
function load(path,dependencies={}) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,
    {exports,Object,structuredClone,require(name){assert.ok(Object.hasOwn(dependencies,name),`Forbidden dependency: ${name}`);return dependencies[name];}});
  return exports;
}
const decimal=load('src/lib/tariff/economic-decimal.ts');
const resolver=load('src/lib/tariff/resolve-economic-model.ts',{'./economic-decimal':decimal});
const adapter=load('src/lib/tariff/eon-offline-evidence.ts',{'./economic-decimal':decimal,'./resolve-economic-model':resolver});
const view=load('src/components/home-energy-plan-view.ts');
const selection=load('src/components/selected-home-energy-plan.ts',{'../lib/tariff/resolve-economic-model':resolver,'../lib/tariff/economic-decimal':decimal,'./home-energy-plan-view':view});
const localTime=load('src/lib/presentation/local-time.ts');
const curve=load('src/lib/tariff/price-signal.ts');
const effective=load('src/lib/tariff/effective-tariff.ts',{'./price-signal':curve});
const dispatches=load('src/lib/tariff/kraken-dispatches.ts',{'./price-signal':curve});
const legacy=load('src/lib/site/get-site-price-signal.ts',{'../tariff/price-signal':curve,'../tariff/kraken-dispatches':dispatches,'../tariff/effective-tariff':effective});
const currentSite=load('src/lib/site/current-site.ts').currentSite;
const adapted=()=>adapter.adaptEonOfflineEvidence(fixture(),horizon,generatedAt);
const option=()=>({id:'offline',label:'Supplied E.ON snapshot',timeZone:'Europe/London',source:{kind:'eon-offline',result:adapted()}});
// Explicit synthetic configured prices, independent of immutable production dates.
const plan=()=>legacy.getSitePriceSignal({integrations:{kraken:{enabled:false}},tariff:{timeZone:'Europe/London',normalImport:{amount:0.42,currency:'GBP',unit:'kWh'},export:{amount:0.17,currency:'GBP',unit:'kWh'}}},null,horizon.start);
function nodes(root,predicate) {
  if(!root||typeof root!=='object')return [];
  if(Array.isArray(root))return root.flatMap(n=>nodes(n,predicate));
  return [...(predicate(root)?[root]:[]),...nodes(root.props?.children,predicate)];
}
// Controlled React hooks exercise actual event handlers and memo dependencies;
// React's renderer renders every returned element/nested presentation component.
function mount(props) {
  let cells=[],cursor=0,tree,clock,wrapperCalls=0;
  const hooks={
    useState(initial){const index=cursor++;if(!(index in cells))cells[index]=initial;return [cells[index],next=>{cells[index]=next;}];},
    useMemo(fn,deps){const index=cursor++,old=cells[index];if(!old||!deps.every((d,i)=>Object.is(d,old.deps[i])))cells[index]={deps,value:fn()};return cells[index].value;},
  };
  const {default:Component}=load('src/components/HomeEnergyPlan.tsx',{react:hooks,'react/jsx-runtime':jsxRuntime,
    './use-dashboard-time':{useDashboardTime:initial=>clock??initial},'./home-energy-plan-view':view,'../lib/presentation/local-time':localTime,
    './selected-home-energy-plan':{selectedHomeEnergyPlan(...args){wrapperCalls++;return selection.selectedHomeEnergyPlan(...args);}},
  });
  const api={
    draw(){cursor=0;tree=Component(props);return renderToStaticMarkup(tree);},
    choose(id){const select=nodes(tree,n=>n.type==='select')[0];assert.ok(select);select.props.onChange({target:{value:id}});return api.draw();},
    returnToConfigured(){const button=nodes(tree,n=>n.type==='button')[0];assert.ok(button);button.props.onClick();return api.draw();},
    update(next){props=next;return api.draw();},tick(at){clock=at;return api.draw();},calls:()=>wrapperCalls,
    tree:()=>tree,
  };
  api.draw();return api;
}
const previewNotice='Home Energy Plan preview only; other dashboard insights retain their current source.';

test('default actual configured plan remains unchanged, no selector or wrapper invocation',()=>{
  const p=legacy.getSitePriceSignal(currentSite,null,'2026-09-25T12:00:00Z'),before=JSON.stringify(p),m=mount({plan:p}),html=m.draw();
  assert.match(html,/25.18p\/kWh/);assert.match(html,/2.99p\/kWh/);assert.match(html,/17.5p\/kWh/);
  assert.doesNotMatch(html,/<select|preview only|Supplied coverage/);assert.equal(m.calls(),0);assert.equal(JSON.stringify(p),before);
  const expired=legacy.getSitePriceSignal(currentSite,null,'2026-10-07T12:00:00Z');assert.ok(expired.signal.import.every(w=>w.price===null));
  assert.doesNotMatch(m.update({plan:expired}),/25.18p\/kWh|2.99p\/kWh/);
});
test('supplying an alternative does not select it; explicit selection and return are local',()=>{
  const p=plan(),a=option(),before=JSON.stringify({p,a}),m=mount({plan:p,alternatives:[a]});
  assert.match(m.draw(),/42p\/kWh/);assert.doesNotMatch(m.draw(),/2.85p\/kWh/);assert.equal(m.calls(),0);
  const selected=m.choose(a.id);assert.ok(selected.includes(previewNotice));assert.match(selected,/2.85p\/kWh/);assert.doesNotMatch(selected,/42p\/kWh|17p\/kWh/);
  assert.match(selected,/Supplied E.ON snapshot/);assert.match(selected,/Offline E.ON evidence/);assert.match(selected,/supplier-rates:rates-0 \(E.ON Next\)/);
  assert.match(selected,/Price not configured \/ unknown/);assert.doesNotMatch(selected,/Kraken schedule snapshot|Next 48 hours/);
  assert.match(selected,/Supplied coverage/);
  const back=m.choose('');assert.match(back,/42p\/kWh/);assert.ok(!back.includes(previewNotice));
  assert.equal(JSON.stringify({p,a}),before);assert.doesNotMatch(mount({plan:p,alternatives:[a]}).draw(),/preview only/);
});
test('same-ID snapshot update keeps price, selector and notice current; removal retains selection context',()=>{
  const p=plan(),a={...option(),label:'Supplier snapshot A'},m=mount({plan:p,alternatives:[a]});
  const initial=m.choose(a.id);
  assert.match(initial,/2.85p\/kWh/);assert.match(initial,/Source: Supplier snapshot A/);
  const data=fixture();data.windows[0].energy.price.amount='0.123';
  const b={...a,label:'Updated supplied snapshot B',source:{kind:'eon-offline',result:adapter.adaptEonOfflineEvidence(data,horizon,generatedAt)}};
  assert.equal(b.source.result.status,'partial'); // Fixture deliberately includes gaps and unknown export.
  const updated=m.update({plan:p,alternatives:[b]});
  const summary=nodes(m.tree(),n=>n.props?.['aria-label']==='Electricity price summary')[0];
  assert.match(renderToStaticMarkup(summary),/12.3p\/kWh/);
  assert.doesNotMatch(renderToStaticMarkup(summary),/2.85p\/kWh/);
  const selected=nodes(m.tree(),n=>n.type==='option'&&n.props.value===a.id)[0];
  assert.equal(selected.props.children,b.label);
  assert.match(updated,/Source: Updated supplied snapshot B/);assert.doesNotMatch(updated,/Supplier snapshot A/);
  const removed=m.update({plan:p,alternatives:[]});
  assert.match(removed,/Source: Supplier snapshot A/);assert.match(removed,/no longer supplied/);
  assert.doesNotMatch(removed,/p\/kWh|24-hour import prices|Electricity price summary/);
  assert.match(m.returnToConfigured(),/42p\/kWh/);
  const defaultMount=mount({plan:p,alternatives:[a]}),defaultBefore=defaultMount.draw();
  const defaultAfter=defaultMount.update({plan:p,alternatives:[b]});
  assert.match(defaultAfter,/42p\/kWh/);assert.doesNotMatch(defaultAfter,/12.3p\/kWh|Source: Updated supplied snapshot B|preview only/);
  assert.equal(defaultMount.calls(),0);
  assert.equal(defaultAfter,defaultBefore.replaceAll(a.label,b.label));
});
test('unavailable result shows safe explanation and no price, timeline or fallback',()=>{
  const a=structuredClone(option());a.source.result.status='invalid';const m=mount({plan:plan(),alternatives:[a]});const html=m.choose(a.id);
  assert.match(html,/Price presentation unavailable/);assert.match(html,/Supplied E.ON snapshot/);
  assert.doesNotMatch(html,/p\/kWh|24-hour import prices|Electricity price summary|Next cheap period|Whole-home price signal/);
  assert.match(html,/configured plan has not been substituted/);
});
test('removed selection stays unavailable; return requires explicit action even without a selector',()=>{
  const p=plan(),a=option(),m=mount({plan:p,alternatives:[a]});m.choose(a.id);
  const removed=m.update({plan:p,alternatives:[]});assert.match(removed,/no longer supplied/);assert.doesNotMatch(removed,/<select|42p\/kWh/);
  assert.match(m.returnToConfigured(),/42p\/kWh/);
});
test('ambiguous IDs and invalid timezone cannot silently select or display configured rates',()=>{
  const p=plan(),a=option();assert.doesNotMatch(mount({plan:p,alternatives:[a,{...a}]}).draw(),/<select/);
  const m=mount({plan:p,alternatives:[a]});m.choose(a.id);
  assert.match(m.update({plan:p,alternatives:[a,{...a}]}),/no longer supplied/);
  const b={...a,timeZone:'invalid/timezone'},bad=mount({plan:p,alternatives:[b]});assert.match(bad.choose(b.id),/Price presentation unavailable/);
  const mismatched={...a,timeZone:'UTC'},other=mount({plan:p,alternatives:[mismatched]});assert.match(other.choose(a.id),/Price presentation unavailable/);
});
for(const defect of ['kind','unknown','price','export','overlap']) test(`all summary/timeline/Details fields use validated windows: ${defect}`,()=>{
  const a=option(),r=structuredClone(a.source.result.resolution),bad=r.signal.import[0];
  if(defect==='kind')bad.kind='guaranteed-off-peak';
  if(defect==='unknown'){bad.kind='guaranteed-off-peak';bad.price=null;bad.priceStatus='unknown';}
  if(defect==='price')bad.price.amount=999;
  if(defect==='export'){r.signal.export[0].priceStatus='known';r.signal.export[0].price={amount:999,currency:'GBP',unit:'kWh'};}
  if(defect==='overlap')r.signal.import.splice(1,0,structuredClone(bad));
  a.source={kind:'canonical',resolution:r};
  const m=mount({plan:plan(),alternatives:[a]}),html=m.choose(a.id);
  assert.doesNotMatch(html,/99900p|Cheap rate · Guaranteed|Guaranteed off-peak tariff|42p\/kWh/);
  if(defect==='overlap')assert.doesNotMatch(html,/24-hour import prices|p\/kWh/);
  else {
    assert.match(html,/24-hour import prices/);assert.match(html,/Rate unknown/);
    if(defect!=='export'){
      const list=nodes(m.tree(),n=>n.type==='ol'&&n.props['aria-label']==='24-hour import prices')[0];
      assert.match(renderToStaticMarkup(list.props.children[0]),/Rate unknown/);
    }else assert.match(html,/2.85p\/kWh/);
  }
});
function conditionalOption() {
  const model=structuredClone(adapted().model),v=model.versions[0],period=v.validity;
  v.schedule[0].overlayPolicy='replace';
  v.conditionalRules=[{id:'smart',rateId:v.rates[0].id,validity:period,evidenceIds:['rule'],dispatchType:'SMART',provider:'kraken',qualification:'physical-charging-required',compatibility:'drive-smart'}];
  const e={...structuredClone(model.evidence[1]),id:'rule',claims:[{role:'conditional-rule-definition',versionId:v.id,ruleId:'smart'}]};model.evidence.push(e);
  model.evidence.push({...structuredClone(e),id:'dispatch',provider:'kraken',kind:'authenticated-dispatch',claims:[{role:'conditional-dispatch-occurrence',ruleId:'smart',assetId:'synthetic-ev',dispatchType:'SMART',...period}]});
  const intervals=[{...period,ruleId:'smart',agreementId:v.agreementId,evidenceId:'dispatch',cause:{kind:'ev-dispatch',assetId:'synthetic-ev',assetName:'Test EV',dispatchType:'SMART',...period}}];
  const resolution=resolver.resolveEconomicModel(model,horizon,generatedAt,intervals);assert.equal(resolution.status,'resolved');
  return {id:'canonical',label:'Synthetic supplied canonical snapshot',timeZone:'Europe/London',source:{kind:'canonical',resolution}};
}
test('supported SMART retains conditional labels, original vehicle attribution and evidence',()=>{
  const a=conditionalOption(),m=mount({plan:plan(),alternatives:[a]}),html=m.choose(a.id);
  assert.match(html,/Smart charge · Conditional/);assert.match(html,/Planned \/ conditional/);assert.match(html,/planned-conditional/);
  assert.match(html,/Test EV/);assert.match(html,/Dispatch type: SMART/);assert.match(html,/not confirmed billed rates/);
  assert.doesNotMatch(html,/Cheap rate · Guaranteed|Guaranteed off-peak tariff/);
});
test('same props do not revalidate on unrelated renders; clock advances only within supplied coverage',()=>{
  const p=plan(),a=option(),alternatives=[a],m=mount({plan:p,alternatives});m.choose(a.id);const count=m.calls();
  m.draw();m.update({plan:p,alternatives});assert.equal(m.calls(),count);
  const html=m.tick('2026-11-01T00:00:00Z');assert.equal(m.calls(),count+1);
  const summary=nodes(m.tree(),n=>n.props?.['aria-label']==='Electricity price summary')[0];
  assert.match(renderToStaticMarkup(summary),/Price not configured \/ unknown/);assert.doesNotMatch(renderToStaticMarkup(summary),/2.85p\/kWh|42p\/kWh/);
  assert.match(html,/Supplied coverage/);
});
test('server seed/timezone are explicit and deterministic, with no shared consumer mutation',()=>{
  const p=plan(),a=option(),otherConsumerSignal=p.signal,before=JSON.stringify(p);
  const first=mount({plan:p,alternatives:[a]}),second=mount({plan:p,alternatives:[a]});assert.equal(first.draw(),second.draw());
  const html=first.choose(a.id);assert.match(html,/UTC\+01:00/);
  assert.equal(JSON.stringify(p),before);assert.equal(p.signal,otherConsumerSignal);assert.match(second.draw(),/42p\/kWh/);
});
