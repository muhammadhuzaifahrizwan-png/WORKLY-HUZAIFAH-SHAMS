process.env.WORKLY_DATA_DIR='/tmp/wprobe2';
const fs=require('fs');
const {init}=require('./server/db');
const seed=require('./server/seed');
const {importF1Data}=require('./server/f1-data');
const {app}=require('./server/index');
(async()=>{
  init(); seed.seedAll(); await importF1Data({log:()=>{}});
  const s=app.listen(0,'127.0.0.1',async()=>{
    const p=s.address().port;
    for (const u of ['/api/f1/drivers?limit=3','/api/f1/drivers?q=senna','/api/f1/drivers?sort=name&limit=3']) {
      const r=await fetch(`http://127.0.0.1:${p}${u}`);
      const txt=await r.text();
      console.log(u,'->',r.status, txt.slice(0,400));
    }
    const db=require('./server/db').db;
    console.log('count', db.prepare('SELECT COUNT(*) n FROM drivers').get());
    console.log('senna rows', db.prepare("SELECT id,name,full_name FROM drivers WHERE name LIKE '%enna%'").all());
    console.log('like param', db.prepare("SELECT COUNT(*) n FROM drivers WHERE name LIKE ?").get('%senna%'));
    s.close();
  });
})();
