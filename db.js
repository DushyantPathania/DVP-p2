/* db.js
   Lightweight wrapper around sql.js to load a SQLite DB from a URL and run queries.
   Exposes: DB.init(dbUrl), DB.queryAll(sql, params), DB.getVenues()
*/
window.DB = (function () {
  let SQL = null;     // sql.js module
  let db  = null;     // sql.js Database instance
  let ready = null;   // Promise to gate init

  // Init sql.js and open the database from a URL (served with CORS)
  async function init(dbUrl) {
    if (!ready) {
      ready = (async () => {
        // Load sql.js and its wasm from CDNJS
        SQL = await initSqlJs({
          locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
        });
        // Fetch DB bytes
        const resp = await fetch(dbUrl, { cache: "no-store" });
        if (!resp.ok) throw new Error(`Failed to fetch DB: ${resp.status}`);
        const bytes = new Uint8Array(await resp.arrayBuffer());
        db = new SQL.Database(bytes);
      })();
    }
    return ready;
  }

  // Return all rows as array of objects
  async function queryAll(sql, params = []) {
    await ready;
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // Convenience: fetch venues for markers
  async function getVenues() {
    // Adjust column names if your table differs
    const sql = `
      SELECT venue, CAST(longitude AS REAL) AS longitude, CAST(latitude AS REAL) AS latitude
      FROM venues
      WHERE longitude IS NOT NULL AND latitude IS NOT NULL
    `;
    return queryAll(sql);
  }

  // Optional: expose the raw db if you need transactions/exec/etc.
  function _raw() { return db; }

  return { init, queryAll, getVenues, _raw };
})();
