import {loadStore} from './ownership-sqlite-harness.mjs';
const crash=process.argv[2]==='crash';
const store=loadStore({beforeExec(sql){if(crash&&sql==='COMMIT')process.kill(process.pid,'SIGKILL');}});
process.send({ready:true});
process.once('message',({file,input})=>{
  const result=store.testCommit(file,input);
  process.send(JSON.parse(JSON.stringify(result)),()=>process.disconnect());
});
