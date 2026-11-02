process.env.WORKLY_DATA_DIR='/tmp/wprobe3';
const {init,db}=require('./server/db');
const seed=require('./server/seed');
const {importF1Data}=require('./server/f1-data');
(async()=>{
  init(); seed.seedAll(); await importF1Data({log:()=>{}});
  const base=`FROM drivers d
 LEFT JOIN driver_statistics s ON s.driver_id = d.id
 LEFT JOIN featured_drivers f ON f.driver_id = d.id
 LEFT JOIN countries ct ON ct.id = d.country_id
    `;
  try { console.log('count', db.prepare(`SELECT COUNT(*) AS n ${base}`).get({})); } catch(e){ console.log('ERR1', e.message); }
  console.log('plain', db.prepare('SELECT COUNT(*) n FROM drivers').get());
  console.log('stats rows', db.prepare('SELECT COUNT(*) n FROM driver_statistics').get());
  console.log('featured rows', db.prepare('SELECT COUNT(*) n FROM featured_drivers').get());
  console.log('countries rows', db.prepare('SELECT COUNT(*) n FROM countries').get());
  console.log('distinct country ids used', db.prepare('SELECT COUNT(DISTINCT country_id) n FROM drivers').get());
})();
