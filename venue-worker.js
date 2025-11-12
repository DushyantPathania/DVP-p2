// venue-worker.js — runs heavy aggregation in a dedicated worker using sql.js
// Messages:
// { id, action: 'aggregate', aliases: string[], yrRange: {min,max}, format }
// responses: { id, result: { byFormat }, error }

importScripts('https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js');

let SQLw = null, dbw = null;

// minimal IndexedDB helpers (same pattern as main thread)
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('cricket-sqlite-cache', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGet(key) {
  return idbOpen().then(idb => new Promise((res, rej) => {
    const tx = idb.transaction('files', 'readonly');
    const r = tx.objectStore('files').get(key);
    r.onsuccess = () => res(r.result || null);
    r.onerror   = () => rej(r.error);
  }));
}

async function ensureDB(){
  if (dbw) return;
  // init sql.js in worker
  SQLw = await initSqlJs({ locateFile: f => 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/' + f });
  // try IndexedDB cache key used by main thread
  const cacheKey = 'cricket.db::v1';
  try {
    const cached = await idbGet(cacheKey);
    if (cached && cached.byteLength) {
      dbw = new SQLw.Database(new Uint8Array(cached));
      return;
    }
  } catch (e) {
    // fall through
  }
  throw new Error('No DB binary available in worker IndexedDB cache');
}

function queryAll(sql, params = []){
  const stmt = dbw.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function tableHasColumn(tableName, colName){
  try{
    const rows = queryAll(`PRAGMA table_info(${tableName})`);
    return rows.some(r => String(r.name).toLowerCase() === String(colName).toLowerCase());
  }catch(e){ return false; }
}

function formatPatterns(fmtKey){
  if (fmtKey === 'test') return ['%test%'];
  if (fmtKey === 'odi') return ['%odi%', '%one%day%', '%one-day%', '%one day%'];
  if (fmtKey === 't20i') return ['%t20i%', '%t20%', '%twenty%', '%twenty20%'];
  return [`%${fmtKey}%`];
}

async function computeForFormat(aliases, yrRange, fmtKey){
  const pf = formatPatterns(fmtKey);
  const battingHasFormat = tableHasColumn('batting_innings','format');
  const bowlingHasFormat = tableHasColumn('bowling_innings','format');

  const likeClause = aliases.length ? aliases.map(_ => `LOWER(COALESCE(m.venue_name, '')) LIKE ?`).join(' OR ') : `LOWER(COALESCE(m.venue_name, '')) LIKE ?`;
  const likeParams = aliases.length ? aliases.map(p => `%${p}%`) : [`%${''}%`];

  const battingFmtClause = pf.map(_ => battingHasFormat ? `LOWER(COALESCE(bi.format, m.format, '')) LIKE ?` : `LOWER(COALESCE(m.format, '')) LIKE ?`).join(' OR ');
  const bowlingFmtClause = pf.map(_ => bowlingHasFormat ? `LOWER(COALESCE(bi.format, m.format, '')) LIKE ?` : `LOWER(COALESCE(m.format, '')) LIKE ?`).join(' OR ');
  const matchFmtClause = pf.map(_ => `LOWER(COALESCE(m.format, '')) LIKE ?`).join(' OR ');

  // batting
  const batSQL = `SELECT SUM(CAST(bi.runs AS INT)) AS runs, SUM(CAST(bi.balls AS INT)) AS balls, SUM(CASE WHEN COALESCE(bi.out,'')<>'' THEN 1 ELSE 0 END) AS dismissals, AVG(CAST(bi.boundary_pct AS REAL)) AS boundary_pct FROM batting_innings bi LEFT JOIN matches m ON bi.match_id = m.match_id WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${likeClause}) AND (${battingFmtClause})`;
  const batParams = [yrRange.min, yrRange.max, ...likeParams, ...pf.map(p=>p)];
  const batRows = queryAll(batSQL, batParams) || [];
  const bat = (batRows && batRows[0]) || {};

  // innings
  const innSQL = `SELECT COALESCE(CAST(bi.innings_no AS INT),0) AS innings_no, AVG(CAST(bi.runs AS INT)) AS avg_runs, COUNT(*) AS cnt FROM batting_innings bi LEFT JOIN matches m ON bi.match_id = m.match_id WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${likeClause}) AND (${battingFmtClause}) GROUP BY innings_no ORDER BY innings_no`;
  const innRows = queryAll(innSQL, [yrRange.min, yrRange.max, ...likeParams, ...pf.map(p=>p)]) || [];

  // bowling
  const bowlSQL = `SELECT SUM(CAST(bi.runs_conceded AS INT)) AS runs_conceded, SUM(CAST(bi.legal_balls AS INT)) AS balls, SUM(CAST(bi.wickets AS INT)) AS wickets FROM bowling_innings bi LEFT JOIN matches m ON bi.match_id = m.match_id WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${likeClause}) AND (${bowlingFmtClause})`;
  const bowlRows = queryAll(bowlSQL, [yrRange.min, yrRange.max, ...likeParams, ...pf.map(p=>p)]) || [];
  const bowl = (bowlRows && bowlRows[0]) || {};

  // matches
  const matchSQL = `SELECT m.match_id, m.team1, m.team2, m.toss_winner, m.toss_decision, m.winner, COALESCE(m.result_type, '') AS result_type FROM matches m WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${likeClause}) AND (${matchFmtClause})`;
  const matches = queryAll(matchSQL, [yrRange.min, yrRange.max, ...likeParams, ...pf.map(p=>p)]) || [];

  // batting-first win%
  let matchesWithResult = 0, battingFirstWins = 0;
  for (const m of matches){
    const resType = String(m.result_type || '').toLowerCase();
    if (resType && (resType.includes('no result') || resType.includes('draw') || resType.includes('tie') || resType.includes('tied'))) continue;
    const winner = (m.winner || '').trim(); if (!winner) continue;
    let battingFirst = null;
    try{
      const td = String(m.toss_decision || '').toLowerCase();
      const toss = String(m.toss_winner || '').trim();
      const t1 = String(m.team1 || '').trim(), t2 = String(m.team2 || '').trim();
      if (td.includes('bat')) battingFirst = toss;
      else if (toss && (t1 && t2)) battingFirst = (toss === t1 ? t2 : t1);
    }catch(e){ battingFirst = null; }
    if (!battingFirst) continue;
    matchesWithResult += 1;
    if (String(winner).trim() === String(battingFirst).trim()) battingFirstWins += 1;
  }

  const battingFirstPct = matchesWithResult ? (battingFirstWins / matchesWithResult) : null;

  const batting_sr = (bat && bat.balls) ? (100 * (bat.runs / bat.balls)) : null;
  const batting_avg = (bat && bat.dismissals) ? (bat.runs / bat.dismissals) : (bat && bat.runs ? (bat.runs / Math.max(1, (innRows && innRows.length) || 1)) : null);
  const boundary_pct = bat && bat.boundary_pct ? (+bat.boundary_pct) : null;
  const bowling_econ = (bowl && bowl.balls) ? (bowl.runs_conceded / (bowl.balls / 6)) : null;
  const bowling_avg = (bowl && bowl.wickets) ? (bowl.runs_conceded / (bowl.wickets || 1)) : null;
  const bowling_sr = (bowl && bowl.wickets) ? (bowl.balls / (bowl.wickets || 1)) : null;

  return {
    batting_sr: batting_sr ? +batting_sr : null,
    batting_avg: batting_avg ? +batting_avg : null,
    boundary_pct: boundary_pct ? +boundary_pct : null,
    bowling_econ: bowling_econ ? +bowling_econ : null,
    bowling_avg: bowling_avg ? +bowling_avg : null,
    bowling_sr: bowling_sr ? +bowling_sr : null,
    innings_by_no: innRows || [],
    matches_count: matches.length,
    matches_with_result: matchesWithResult,
    batting_first_win_pct: battingFirstPct
  };
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const { id, action } = msg;
  if (action === 'aggregate'){
    try{
      await ensureDB();
      const aliases = Array.isArray(msg.aliases) ? msg.aliases : [];
      const yrRange = msg.yrRange || { min: 2000, max: 2025 };
      const format = msg.format || 'all';
      const FORMATS = ['test','odi','t20i'];
      const byFormat = {};
      for (const f of FORMATS){
        // if top-level format filter is set, skip non-matching formats
        if (format && format !== 'all' && !f.includes(format) && !(format === 't20i' && f === 't20i')) {
          // allow explicit request
        }
        byFormat[f] = await computeForFormat(aliases, yrRange, f);
      }
      self.postMessage({ id, result: { byFormat } });
    } catch(err){
      self.postMessage({ id, error: String(err && err.message ? err.message : err) });
    }
  }
};
