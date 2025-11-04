/* db.js — sql.js helper (works from file://)
   Exposes: DB.init(dbUrl), DB.all(sql, params), DB.getVenues()
*/
window.DB = (() => {
  let SQL = null;
  let db = null;

  async function init(dbUrl) {
    if (!SQL) {
      SQL = await initSqlJs({
        locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}`
      });
    }
    const buf = await fetch(dbUrl, { cache: "no-store" }).then(r => {
      if (!r.ok) throw new Error(`Failed to fetch DB: ${r.status}`);
      return r.arrayBuffer();
    });
    db = new SQL.Database(new Uint8Array(buf));
  }

  function all(sql, params = []) {
    if (!db) throw new Error("DB not initialized. Call DB.init(url) first.");
    const stmt = db.prepare(sql);
    const rows = [];
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  async function getVenues() {
    return all(`
      SELECT venue, longitude, latitude
      FROM venues
      WHERE longitude IS NOT NULL AND latitude IS NOT NULL
    `);
  }

  return { init, all, getVenues };
})();
