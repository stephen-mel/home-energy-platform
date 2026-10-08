// Sanitised representative half-hours clipped from verified 7–8 October rate
// observations. All identifiers are synthetic; no customer/supply identifiers.
export const horizon = { start:'2026-10-06T23:00:00Z', end:'2026-10-08T23:00:00Z' };
export const generatedAt = '2026-10-09T00:00:00Z';
export function fixture() {
  const agreement = { id:'synthetic-import',supplyRef:'synthetic-supply',supplier:'E.ON Next',direction:'import',
    productCode:'NEXT_DRIVE_SMART_V5_2',tariffCode:'E-TOU-NEXT_DRIVE_SMART_V5_2-G',
    validFrom:'2026-01-17T00:00:00Z',validTo:'2027-01-17T00:00:00Z',status:'active',invalidatedAt:null,evidenceIds:['agreement'] };
  const subject = { agreementId:agreement.id,supplyRef:agreement.supplyRef,supplier:agreement.supplier,direction:agreement.direction,productCode:agreement.productCode,tariffCode:agreement.tariffCode };
  const evidence = (id,kind,coverage,claims) => ({id,kind,coverage,claims,subject:{...subject},provider:'E.ON Next',observedAt:'2026-10-08T23:00:00Z',freshness:'fresh'});
  const data={agreements:[agreement],agreementMetadata:[{agreementId:agreement.id,productName:"Next Drive Smart V5.2",ratesAgreedAt:null}],evidence:[evidence('agreement','supplier-agreement',[{start:agreement.validFrom,end:agreement.validTo}],[{role:'agreement-identity'},{role:'agreement-validity'}])],taxes:[],windows:[],transport:[],observations:[
    {id:'synthetic-export-observation',kind:'incomplete-export',supplier:'E.ON Next',productName:'Next Export Premium v3',coverage:[],observedAt:'2026-10-08T23:00:00Z',amount:'0.175',currency:'GBP',unit:'kWh'},
    {id:'synthetic-bill-observation',kind:'historical-smart-bill',supplier:'E.ON Next',productName:'Next Drive Smart V5.2',coverage:[{start:'2026-09-05T23:00:00Z',end:'2026-10-05T23:00:00Z'}],observedAt:'2026-10-08T23:00:00Z',amount:null,currency:'GBP',unit:'kWh'},
  ]};
  for (const [i,start,end,amount] of [
    [0,'2026-10-06T23:00:00Z','2026-10-06T23:30:00Z','0.0285'],
    [1,'2026-10-07T05:00:00Z','2026-10-07T05:30:00Z','0.23978'],
    [2,'2026-10-07T23:00:00Z','2026-10-07T23:30:00Z','0.0285'],
    [3,'2026-10-08T05:00:00Z','2026-10-08T05:30:00Z','0.23978'],
  ]) {
    const versionId=`window-${i}`,rateId=`energy-${i}`,id=`rates-${i}`,period={start,end};
    data.windows.push({versionId,agreementId:agreement.id,period,evidenceIds:[id],rateType:'STANDARD',standing:null,
      energy:{id:rateId,validity:period,price:{amount,currency:'GBP',unit:'kWh',basis:'tax-inclusive'},evidenceIds:[id]}});
    data.evidence.push(evidence(id,'supplier-rates',[period],[{role:'economic-version',versionId},{role:'schedule-definition',versionId},{role:'energy-rate',versionId,rateId}]));
  }
  data.transport=data.evidence.map(e=>({evidenceId:e.id,via:'kraken'}));
  return data;
}
// Synthetic independent bounded supplier schedule attestation permits testing
// historical bill prices/tax without pretending the bill proves a schedule.
export function historicalFixture(fraction, inclusive=false) {
  const d=fixture(),w=d.windows[0];
  d.windows=[w];d.evidence=d.evidence.filter(e=>['agreement','rates-0'].includes(e.id));
  d.transport=d.transport.filter(t=>['agreement','rates-0'].includes(t.evidenceId));
  w.period={start:fraction==='0.05'?'2026-09-08T08:00:00Z':'2026-10-02T08:00:00Z',end:fraction==='0.05'?'2026-09-08T08:30:00Z':'2026-10-02T08:30:00Z'};
  w.energy.validity=w.period;w.energy.price={amount:'0.0285',currency:'GBP',unit:'kWh',basis:inclusive?'tax-inclusive':'tax-exclusive',taxId:'vat'};
  w.standing={id:'standing',validity:w.period,price:{amount:'0.57143',currency:'GBP',unit:'day',basis:'tax-exclusive',taxId:'vat'},evidenceIds:['bill']};
  const rates=d.evidence[1];rates.coverage=[w.period];rates.claims=rates.claims.filter(c=>c.role!=='energy-rate');
  w.energy.evidenceIds=['bill'];
  d.evidence.push({...structuredClone(rates),id:'bill',kind:'supplier-bill',claims:[{role:'energy-rate',versionId:w.versionId,rateId:w.energy.id},{role:'standing-charge',versionId:w.versionId,rateId:'standing'},{role:'tax-treatment',taxId:'vat'}]});
  d.taxes=[{id:'vat',validity:w.period,fraction,evidenceIds:['bill']}];
  d.transport.push({evidenceId:'bill',via:'supplier-document'});
  return d;
}
