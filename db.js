/* Simple sql.js wrapper that works from file:// when DB is fetched via HTTPS */
window.DB = (function(){
  let SQL, db;

  async function init(dbUrl){
    if (db) return;
    SQL = await initSqlJs({
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}`
    });
    const buf = await fetch(dbUrl).then(r => {
      if (!r.ok) throw new Error(`Failed to fetch DB: ${r.status}`);
      return r.arrayBuffer();
    });
    db = new SQL.Database(new Uint8Array(buf));
  }

  function queryAll(sql, params=[]){
    if (!db) throw new Error("DB not initialised");
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()){
        const row = stmt.getAsObject();
        rows.push(row);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  // Optional convenience if a standard schema exists
  function getVenues(){
    const rows = queryAll("SELECT * FROM venues");
    return rows;
  }

  return { init, queryAll, getVenues };
})();
