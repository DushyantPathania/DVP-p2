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

  // Helper: list columns for a table (lowercased)
  async function getTableColumns(table) {
    const rows = await queryAll(`PRAGMA table_info(${table})`);
    return rows.map(r => String(r.name).toLowerCase());
  }

  // Convenience: fetch venues for markers
  // Supports either (longitude, latitude) OR (lon, lat) + optional country/city/names.
  async function getVenues() {
    const cols = await getTableColumns('venues');
    const has = (c) => cols.includes(c);

    // Pick coordinate columns (prefer lon/lat if present)
    const lonCol = has('lon') ? 'lon' : (has('longitude') ? 'longitude' : null);
    const latCol = has('lat') ? 'lat' : (has('latitude') ? 'latitude' : null);
    if (!lonCol || !latCol) throw new Error('venues table must have lon/lat or longitude/latitude columns');

    // Optional attributes
    const selCountry = has('country') ? ', country' : '';
    const selCity    = has('city')    ? ', city'    : '';
    const selNames   = has('names')   ? ', names'   : '';

    const sql = `
      SELECT
        venue
        ${selCountry}
        ${selCity}
        ${selNames},
        CAST(${lonCol} AS REAL) AS longitude,
        CAST(${latCol} AS REAL) AS latitude
      FROM venues
      WHERE ${lonCol} IS NOT NULL AND ${latCol} IS NOT NULL
    `;
    return queryAll(sql);
  }

  // Optional: expose the raw db if you need transactions/exec/etc.
  function _raw() { return db; }

  return { init, queryAll, getVenues, _raw };
})();
