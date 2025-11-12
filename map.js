/* ============================================================================
   Cricket Globe / Map (D3 v7)
   Landing layout: small globe at right + intro text on left.
   Clicking "Explore data" removes .landing and expands the globe to full screen.

   Choropleth: home win % by host country (from SQLite via sql.js)
   Spikes: matches hosted (height), colored by win %
   Slider drives re-query; 2D/3D toggle supported.
   ============================================================================ */

(async function () {
  /* ----------------------------- Config ----------------------------------- */
  // Prefer raw GitHub (or replace with your local path "./data/db/cricket.db")
  const DB_URL = "https://raw.githubusercontent.com/DushyantPathania/DVP-p2/main/data/db/cricket.db";

  const ICON_PATH  = "data/icon/CricketStadium.png";
  const ICON_BASE  = 10;
  const SPIN_DEG_PER_SEC = 3;

  /* ------------------------------ DOM ------------------------------------- */
  const container   = document.getElementById("globe");
  const btnMenu     = document.getElementById("menuBtn");
  const overlay     = document.getElementById("leaderboardOverlay");
  const backdrop    = document.getElementById("backdrop");
  const btnClose    = document.getElementById("closeOverlay");
  const tabPanel    = document.getElementById("tabpanel");
  const tabBtns     = [document.getElementById("tab-batting"), document.getElementById("tab-bowling")];
  let spikeLegend = null; // created dynamically by createLegendUI()
  let spikeLegendSection = null;
  const enterBtn    = document.getElementById("enterBtn");

  // Year slider elements
  const yearBox       = document.getElementById("yearBox");
  const yrSlider      = document.querySelector(".yr-slider");
  const yrTrack       = document.querySelector(".yr-track");
  const yrFill        = document.querySelector(".yr-fill");
  const yrThumbL      = document.querySelector(".yr-thumb.left");
  const yrThumbR      = document.querySelector(".yr-thumb.right");
  const yrBubbleL     = document.getElementById("yrBubbleLeft");
  const yrBubbleR     = document.getElementById("yrBubbleRight");
  const yearBoxValue  = document.getElementById("yearBoxValue");

  /* --------------------------- SVG & Layers -------------------------------- */
  const svg = d3.select(container).append("svg");
  const gRoot      = svg.append("g");
  const gSphere    = gRoot.append("g");
  const gGraticule = gRoot.append("g");
  const gCountries = gRoot.append("g");
  const gBoundary  = gRoot.append("g");
  const gSpikes    = gRoot.append("g").attr("class", "spikes");
  const gVenues    = gRoot.append("g").attr("class", "venues"); // existing feature
  const gUI        = svg.append("g").attr("class", "ui-layer");

  VenueWindow.init({ svg, gRoot, projectionRef: () => projection, modeRef: () => mode });

  /* -------------------------- Projections/Path ----------------------------- */
  const graticule = d3.geoGraticule10();
  const globeProj = d3.geoOrthographic().precision(0.6).clipAngle(90);
  const mapProj   = d3.geoNaturalEarth1().precision(0.6);
  let projection  = globeProj;
  let path        = d3.geoPath(projection);

  /* ----------------------------- State ------------------------------------ */
  let mode        = "globe";
  let baseScale   = 1;
  let globeZoomK  = 1;
  let mapZoomK    = 1;
  let isDragging  = false;
  let prev        = null;

  const spinDegPerMs = SPIN_DEG_PER_SEC / 1000;
  let spinTimer   = null;
  let lastElapsed = null;
  let hoveredId   = null;

  // venues (existing)
  let venuesAll    = [];
  const venueIndex = new Set();
  let venueCountrySet = new Set();
  let countryFocused  = false;
  // HTML tooltip element for map & venues
  let tooltipEl = null;

  function ensureTooltip(){
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'map-tooltip';
    tooltipEl.style.position = 'fixed';
    tooltipEl.style.zIndex = 2200;
    tooltipEl.style.pointerEvents = 'none';
    tooltipEl.style.background = 'rgba(0,0,0,0.78)';
    tooltipEl.style.color = 'white';
    tooltipEl.style.padding = '8px 10px';
    tooltipEl.style.borderRadius = '6px';
    tooltipEl.style.fontSize = '0.9rem';
    tooltipEl.style.maxWidth = '320px';
    tooltipEl.style.boxShadow = '0 6px 18px rgba(0,0,0,0.5)';
    tooltipEl.style.display = 'none';
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function showTooltipAt(x, y, html){
    ensureTooltip();
    tooltipEl.innerHTML = html;
    tooltipEl.style.left = (x + 12) + 'px';
    tooltipEl.style.top = (y + 12) + 'px';
    tooltipEl.style.display = 'block';
  }
  function moveTooltipToEvent(ev){
    if (!tooltipEl || tooltipEl.style.display === 'none') return;
    const x = (ev.clientX || (ev.touches && ev.touches[0] && ev.touches[0].clientX) || 0);
    const y = (ev.clientY || (ev.touches && ev.touches[0] && ev.touches[0].clientY) || 0);
    tooltipEl.style.left = (x + 12) + 'px';
    tooltipEl.style.top = (y + 12) + 'px';
  }
  function hideTooltip(){ if (tooltipEl) tooltipEl.style.display = 'none'; }

  // Show venue tooltip with aggregated stats (async DB query). Accepts mouse event and venue row.
  async function showVenueTooltip(ev, d){
    try{
      const name = d.venue || d.name || '';
      const city = d.city || d.town || '';
      const country = d.country || '';
      const basic = `<div style="font-weight:600;margin-bottom:6px">${escapeHtml(name)}</div><div style="font-size:0.9rem;color:#dfe6ea;margin-bottom:6px">${escapeHtml(city)} ${country?('&middot; ' + escapeHtml(country)) : ''}</div>`;
      showTooltipAt(ev.clientX, ev.clientY, basic + '<div style="color:#bcd">Loading…</div>');

      // Aggregate matches from venue_stats where venue_name LIKE name
      const like = `%${(String(name || d.names || d.name || '').toLowerCase()).replace(/%/g,'')}%`;
      let rows = [];
      try{
        rows = DB.queryAll(`SELECT COALESCE(SUM(CAST(matches AS INT)),0) AS matches, 
                               SUM(CASE WHEN LOWER(format) LIKE '%t20%' THEN CAST(matches AS INT) ELSE 0 END) AS t20_matches,
                               SUM(CASE WHEN LOWER(format) LIKE '%odi%' THEN CAST(matches AS INT) ELSE 0 END) AS odi_matches,
                               SUM(CASE WHEN LOWER(format) LIKE '%test%' THEN CAST(matches AS INT) ELSE 0 END) AS test_matches
                           FROM venue_stats WHERE LOWER(venue_name) LIKE ?`, [like]) || [];
      }catch(e){ rows = []; }
      const agg = (rows && rows[0]) ? rows[0] : { matches:0, t20_matches:0, odi_matches:0, test_matches:0 };
      const parts = [];
      parts.push(`<div style="font-size:0.92rem;margin-bottom:6px">Total matches (all years): <strong style="color:#fff">${agg.matches||0}</strong></div>`);
      parts.push(`<div style="display:flex;gap:8px;font-size:0.88rem;color:#cfe8f5">
          <div>Test: <strong style="color:#fff">${agg.test_matches||0}</strong></div>
          <div>ODI: <strong style="color:#fff">${agg.odi_matches||0}</strong></div>
          <div>T20: <strong style="color:#fff">${agg.t20_matches||0}</strong></div>
        </div>`);

      // Also include quick link to open full venue panel (if available)
      parts.push(`<div style="margin-top:8px;font-size:0.85rem;color:#bcd"><button class="map-tooltip-open" style="background:#1f77b4;color:white;border:none;padding:6px 8px;border-radius:6px;cursor:pointer">Open venue details</button></div>`);
      showTooltipAt(ev.clientX, ev.clientY, basic + parts.join(''));

      // wire button
      const btn = tooltipEl.querySelector('.map-tooltip-open');
      if (btn) btn.addEventListener('click', () => { try{ window.VenueWindow.open(d); hideTooltip(); } catch(e){} });
    }catch(e){ console.warn('showVenueTooltip failed', e); }
  }

  // Show country tooltip using precomputed choroByCountry and best-known venues
  async function showCountryTooltip(ev, feature){
    try{
      const cname = canonicalMapName(feature.properties?.name || '');
      const rec = choroByCountry.get(cname) || null;
      let html = `<div style="font-weight:600;margin-bottom:6px">${escapeHtml(feature.properties?.name || cname)}</div>`;
      if (!rec) {
        html += `<div style="color:#bcd">No match data available</div>`;
        showTooltipAt(ev.clientX, ev.clientY, html); return;
      }
      const total = rec.matches || 0; const wins = rec.homeWins || 0; const pct = total ? Math.round((wins/total)*100) : 0;
      html += `<div style="font-size:0.92rem;margin-bottom:6px">Home wins: <strong style="color:#fff">${pct}%</strong> (${wins}/${total})</div>`;
      // per-format breakdown
      const fmts = ['test','odi','t20'];
      html += '<div style="display:flex;gap:8px;font-size:0.88rem;color:#cfe8f5">';
      fmts.forEach(f => { const fr = rec.formats && rec.formats[f] ? rec.formats[f] : { matches:0, homeWins:0 }; const mp = fr.matches||0; const wp = fr.homeWins||0; const wpct = mp ? Math.round((wp/mp)*100) : 0; html += `<div style="min-width:80px">${f.toUpperCase()}: <strong style="color:#fff">${mp}</strong><div style="color:#9fb6c8;font-size:0.78rem">win ${wpct}%</div></div>`; });
      html += '</div>';

      // list up to 3 notable venues (quick query)
      try{
        const venues = await loadVenuesForCountry(cname);
        if (venues && venues.length) {
          const top = venues.slice(0,3).map(v => escapeHtml(v.venue || v.name || '—'));
          html += `<div style="margin-top:8px;color:#bcd;font-size:0.86rem">Notable venues: <strong style="color:#fff">${top.join(', ')}</strong></div>`;
        }
      }catch(e){ /* ignore */ }

      showTooltipAt(ev.clientX, ev.clientY, html);
    }catch(e){ console.warn('showCountryTooltip failed', e); }
  }

  // small HTML escape
  function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // Year range
  const YEAR_MIN = 2000, YEAR_MAX = 2025;
  let yearRange  = { min: YEAR_MIN, max: YEAR_MAX };

  // Choropleth + spikes
  let choroActive     = false;
  let choroByCountry  = new Map(); // key -> {matches, homeWins, winPct}
  // Use a linear spike scale so heights are more directly proportional to match counts
  // and increase the maximum pixel range so spikes are more visible on the globe.
  let spikeScale      = d3.scaleLinear().domain([0,1]).range([0, 40]);

  /* ----------------------------- Demo leaderboard -------------------------- */
  const battingData = [
    { player:"Player A", team:"IND", runs:945, sr:142.3, avg:52.5 },
    { player:"Player B", team:"AUS", runs:903, sr:136.4, avg:48.2 },
    { player:"Player C", team:"ENG", runs:881, sr:131.9, avg:45.1 },
    { player:"Player D", team:"SA",  runs:865, sr:145.2, avg:47.8 },
    { player:"Player E", team:"PAK", runs:842, sr:128.6, avg:43.0 },
    { player:"Player F", team:"NZ",  runs:831, sr:139.0, avg:44.5 },
    { player:"Player G", team:"SL",  runs:820, sr:125.4, avg:42.1 },
    { player:"Player H", team:"BAN", runs:792, sr:129.7, avg:39.8 },
    { player:"Player I", team:"AFG", runs:774, sr:134.2, avg:41.3 },
    { player:"Player J", team:"WI",  runs:761, sr:147.1, avg:40.2 }
  ];
  const bowlingData = [
    { player:"Bowler A", team:"IND", wkts:41, eco:6.1, avg:21.4 },
    { player:"Bowler B", team:"AUS", wkts:39, eco:5.6, avg:22.9 },
    { player:"Bowler C", team:"ENG", wkts:37, eco:6.4, avg:24.1 },
    { player:"Bowler D", team:"SA",  wkts:36, eco:5.8, avg:23.6 },
    { player:"Bowler E", team:"PAK", wkts:34, eco:6.0, avg:24.9 },
    { player:"Bowler F", team:"NZ",  wkts:33, eco:5.5, avg:25.4 },
    { player:"Bowler G", team:"SL",  wkts:31, eco:6.2, avg:26.8 },
    { player:"Bowler H", team:"BAN", wkts:29, eco:5.9, avg:27.1 },
    { player:"Bowler I", team:"AFG", wkts:27, eco:6.3, avg:28.6 },
    { player:"Bowler J", team:"WI",  wkts:26, eco:6.1, avg:29.2 }
  ];

  /* ----------------------------- World Data -------------------------------- */
  const worldData    = await d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json");
  const countries    = topojson.feature(worldData, worldData.objects.countries).features;
  const boundaryMesh = topojson.mesh(worldData, worldData.objects.countries, (a, b) => a !== b);

  /* ------------------------ Country Name Helpers --------------------------- */
  const ALIAS_TO_CANON_MAP = new Map([
    ["united states of america","united states"],
    ["usa","united states"],
    ["uk","united kingdom"],
    ["england","united kingdom"],
    ["uae","united arab emirates"]
  ]);
  function norm(s){ return String(s||"").toLowerCase().replace(/&/g,"and").replace(/[^a-z0-9\s]/g,"").replace(/\s+/g," ").trim(); }
  function canonicalMapName(s){ const n = norm(s); return ALIAS_TO_CANON_MAP.get(n) || n; }

  // host->home team mapping
  const CARIB = new Set(["barbados","trinidad and tobago","jamaica","saint lucia","grenada","antigua and barbuda","saint kitts and nevis","guyana","dominica","saint vincent and the grenadines"]);
  const TEAM_ALIASES = new Map([
    ["uae","united arab emirates"],
    ["united arab emirates","united arab emirates"],
    ["eng","england"], ["uk","england"], ["united kingdom","england"],
    ["usa","united states"], ["united states of america","united states"],
    ["westindies","west indies"], ["west indies","west indies"]
  ]);
  function canonicalTeamName(s){ const n = norm(s); return TEAM_ALIASES.get(n) || n; }
  function hostToHomeTeamCountry(host){ const h = norm(host); if (CARIB.has(h)) return "west indies"; if (h === "united kingdom") return "england"; return h; }

  /* ------------------------ Column Synonyms (lowercase) -------------------- */
  const WINNER_SYNS = ["winner","match_winner","winning_team","win_team"];
  const DATE_SYNS   = ["date","match_date","start_date","starttime","start_time"];
  const HOST_SYNS   = ["venue_country","host_country","host","country","home_country","venuecountry"];
  const NEUTRAL_SYNS= ["neutral_venue","neutral","neutralground"];
  const RESULT_SYNS = ["result_type","result","outcome_type"];
  const FORMAT_SYNS = ["format","match_type","type","game_type","format_type"];

  // color palettes per format (low -> mid -> high)
  const PALETTES = {
    all: ["#e64a19", "#f7e082", "#2e7d32"],   // red -> yellow -> green
    odi: ["#e6f2ff", "#66b3ff", "#005b96"],   // light blue -> bright -> deep blue
    t20: ["#fff0f7", "#f07fbf", "#7a0177"],  // pink -> magenta -> purple
    test:["#fff7e6", "#f4b942", "#8b4513"]   // pale -> ochre -> brown
  };
  let selectedFormat = 'all';
  // expose selected format globally so other modules (venue popup) can read it
  window.selectedFormat = selectedFormat;
  const colorScales = {
    all: d3.scaleLinear().domain([0,0.5,1]).range(PALETTES.all),
    odi: d3.scaleLinear().domain([0,0.5,1]).range(PALETTES.odi),
    t20: d3.scaleLinear().domain([0,0.5,1]).range(PALETTES.t20),
    test: d3.scaleLinear().domain([0,0.5,1]).range(PALETTES.test)
  };

  /* ---------------------------- Geography ---------------------------------- */
  function drawStaticLayers() {
    gSphere.selectAll("path.sphere").data([{ type:"Sphere" }]).join("path").attr("class","sphere").attr("d", path);
    gGraticule.selectAll("path.graticule").data([d3.geoGraticule10()]).join("path").attr("class","graticule").attr("d", path);
  }
  function drawCountries() {
    gCountries.selectAll("path.country")
      .data(countries, d => d.id)
      .join("path")
      .attr("class","country")
      .on("mouseenter", (event, d) => { hoveredId = d.id; d3.select(event.currentTarget).raise(); updateHoverTransform(); try { showCountryTooltip(event, d); } catch(e){} })
      .on("mouseleave", (event, d) => { hoveredId = null; updateHoverTransform(); try { hideTooltip(); } catch(e){} })
      .on("click", (event, d) => handleCountryClick(d))
      .attr("d", path);

    gBoundary.selectAll("path.boundary")
      .data([boundaryMesh]).join("path").attr("class","boundary").attr("d", path);

    applyCountryHighlight();
    applyChoropleth();
  }
  function applyCountryHighlight() {
    if (!venueCountrySet || venueCountrySet.size === 0) return;
    gCountries.selectAll("path.country")
      .classed("has-venues", d => venueCountrySet.has(canonicalMapName(d.properties?.name || "")));
  }

  /* ----------------------------- Toast UI ---------------------------------- */
  const toastEl = document.getElementById("loadingToast");
  function toast(msg){ toastEl.textContent = msg; toastEl.classList.add("show"); }
  function toastHide(){ toastEl.classList.remove("show"); }

  // Transient venue-loading dialog shown when a venue icon is clicked until the
  // VenueWindow actually opens (fires `venuewindow:open`). Idempotent helpers.
  // keep state so we can reliably clear timeouts / listeners
  let _venueLoadingState = { timeoutId: null, onOpen: null };
  function showVenueLoading(msg = 'Loading venue details...'){
    let el = document.getElementById('venue-loading-dialog');
    if (!el) {
      el = document.createElement('div');
      el.id = 'venue-loading-dialog';
      el.setAttribute('role','status');
      el.setAttribute('aria-live','polite');
      el.style.position = 'fixed';
      el.style.left = '0';
      el.style.top = '0';
      el.style.right = '0';
      el.style.bottom = '0';
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.zIndex = 1400; // above the backdrop used by venue popup (1305)
      el.style.background = 'rgba(0,0,0,0.32)';
      const inner = document.createElement('div');
      inner.style.background = 'rgba(0,0,0,0.7)';
      inner.style.color = 'white';
      inner.style.padding = '14px 18px';
      inner.style.borderRadius = '8px';
      inner.style.fontSize = '1rem';
      inner.style.boxShadow = '0 6px 18px rgba(0,0,0,0.5)';
      inner.textContent = msg;
      el.appendChild(inner);
      document.body.appendChild(el);
    } else {
      el.style.display = 'flex';
      const inner = el.firstChild; if (inner) inner.textContent = msg;
    }
    // clear any previous state
    if (_venueLoadingState.timeoutId) { clearTimeout(_venueLoadingState.timeoutId); _venueLoadingState.timeoutId = null; }
    if (_venueLoadingState.onOpen) { window.removeEventListener('venuewindow:open', _venueLoadingState.onOpen); _venueLoadingState.onOpen = null; }
    // auto-hide when venue window opens
    const onOpen = () => { hideVenueLoading(); window.removeEventListener('venuewindow:open', onOpen); _venueLoadingState.onOpen = null; };
    _venueLoadingState.onOpen = onOpen;
    window.addEventListener('venuewindow:open', onOpen);
    // fallback timeout to avoid stuck overlay
    _venueLoadingState.timeoutId = setTimeout(() => { hideVenueLoading(); _venueLoadingState.timeoutId = null; }, 10000);
  }
  function hideVenueLoading(){ const el = document.getElementById('venue-loading-dialog'); if (el) el.style.display = 'none';
    // clear any pending timeout/listener
    try {
      if (_venueLoadingState.timeoutId) { clearTimeout(_venueLoadingState.timeoutId); _venueLoadingState.timeoutId = null; }
      if (_venueLoadingState.onOpen) { window.removeEventListener('venuewindow:open', _venueLoadingState.onOpen); _venueLoadingState.onOpen = null; }
    } catch(e) { /* ignore */ }
  }

  /* ------------------------- Schema Introspection -------------------------- */
  let schemaCache = null;
  async function getVenueSchema() {
    if (schemaCache) return schemaCache;
    await DB.init(DB_URL); // load via sql.js (your db.js can internally use IndexedDB cache)

    // Sanity logs
    try {
      const tnames = DB.queryAll("SELECT name FROM sqlite_master WHERE type='table'");
      console.info("[DB] tables:", tnames.map(r => r.name));
    } catch (e) {
      console.warn("[DB] table introspection failed:", e);
    }

    const colsRows = await DB.queryAll("PRAGMA table_info(venues)");
    const cols = colsRows.map(r => (r.name || r['name'] || "").toLowerCase());
    const countryCol = ["country","country_name","countrytext","nation","state","venue_country"].find(c => cols.includes(c)) || null;
    const lonCol = ["longitude","lon","lng","long","x"].find(c => cols.includes(c)) || null;
    const latCol = ["latitude","lat","y"].find(c => cols.includes(c)) || null;
    const iso3 = cols.includes("iso3") ? "iso3" : null;
    const iso2 = cols.includes("iso2") ? "iso2" : null;

    schemaCache = { cols, countryCol, lonCol, latCol, iso3, iso2 };
    return schemaCache;
  }

  /* ----------------------------- Venues ------------------------------------ */
  function venueKey(v){
    const name = String(v.venue || v.name || "").toLowerCase().trim();
    const lon  = isFinite(+v.longitude) ? (+v.longitude).toFixed(5) : "x";
    const lat  = isFinite(+v.latitude)  ? (+v.latitude).toFixed(5)  : "y";
    return `${name}|${lon}|${lat}`;
  }
  function addVenues(rows){
    for (const r of rows){
      const k = venueKey(r);
      if (!venueIndex.has(k)){ venueIndex.add(k); venuesAll.push(r); }
    }
  }
  function drawVenues() {
    const sel = gVenues.selectAll("image.venue-icon")
      .data(venuesAll, d => d._key || (d._key = venueKey(d)));

    sel.exit().remove();

    const enter = sel.enter()
      .append("image")
      .attr("class","venue-icon")
      .attr("href", ICON_PATH)
      .attr("width", ICON_BASE)
      .attr("height", ICON_BASE)
      .attr("opacity", 0.95)
      // show loader immediately on pointerdown so users get instant feedback
      .on("pointerdown", (event, d) => {
        try { event.stopPropagation(); } catch(e){}
        stopSpin();
      })
      .on("click", (event, d) => {
        event.stopPropagation();
        stopSpin();
        // open the venue popup (it will dispatch 'venuewindow:open' when ready)
        try { VenueWindow.open(d); } catch (e) { hideVenueLoading(); console.warn('VenueWindow.open failed', e); }
      });

    // replace simple <title> with richer HTML tooltip handlers
    enter
      .on('pointerenter', (event, d) => { try { showVenueTooltip(event, d); } catch(e){} })
      .on('pointermove', (event, d) => { try { moveTooltipToEvent(event); } catch(e){} })
      .on('pointerleave', (event, d) => { try { hideTooltip(); } catch(e){} });

    updateVenuesPosition();
  }
  function updateVenuesPosition() {
    if (!venuesAll.length) return;
    gVenues.selectAll("image.venue-icon").each(function(d){
      const lon = +d.longitude, lat = +d.latitude;
      if (!isFinite(lon) || !isFinite(lat)) return;
      const p = projection([lon, lat]);
      if (!p) return;

      const size = (mode === "globe") ? ICON_BASE * globeZoomK : ICON_BASE;
      if (mode === "globe") {
        const r = projection.rotate();
        const visible = d3.geoDistance([lon, lat], [-r[0], -r[1]]) <= Math.PI/2;
        d3.select(this).style("display", visible ? "block" : "none");
      } else {
        d3.select(this).style("display", "block");
      }
      d3.select(this).attr("width", size).attr("height", size).attr("x", p[0] - size/2).attr("y", p[1] - size/2);
    });
  }

  /* ------------------------------ Choropleth & Spikes ---------------------- */
  function yClause() { return "CAST(substr(date,1,4) AS INT) BETWEEN ? AND ?"; }

  async function loadMatchTables() {
    const names = DB.queryAll("SELECT name FROM sqlite_master WHERE type='table'")
                    .map(r => r.name).filter(Boolean);

    const out = [];
    for (const n of names) {
      const cols = DB.queryAll(`PRAGMA table_info(${n})`).map(r => (r.name || "").toLowerCase());
      const winnerCol = WINNER_SYNS.find(c => cols.includes(c));
      const dateCol   = DATE_SYNS.find(c   => cols.includes(c));
      const hostCol   = HOST_SYNS.find(c   => cols.includes(c));
      if (winnerCol && dateCol && hostCol) {
        const neutralCol = NEUTRAL_SYNS.find(c => cols.includes(c));
        const resultCol  = RESULT_SYNS.find(c => cols.includes(c));
        const formatCol  = FORMAT_SYNS.find(c => cols.includes(c));
        out.push({ name: n, cols, map: { winnerCol, dateCol, hostCol, neutralCol, resultCol, formatCol } });
      }
    }

    console.info("[CHORO] matches-like tables:", out.map(t => t.name));
    return out;
  }

  async function computeChoropleth(yearMin, yearMax) {
    const tables = await loadMatchTables();
    let rows = [];

    if (!tables.length) {
      console.warn("[CHORO] No matches-like table found. Need (winner, date, venue_country/host/country).");
    } else {
      try {
        const unionParts = tables.map(t => {
          const m = t.map;
          const neutralExpr = m.neutralCol ? `COALESCE(${m.neutralCol},0)` : "0";
          const resultExpr  = m.resultCol  ? `COALESCE(${m.resultCol},'')`  : "''";
          const formatExpr  = m.formatCol ? `COALESCE(${m.formatCol},'')` : "''";
          return `
            SELECT
              ${m.winnerCol} AS winner,
              ${m.hostCol}   AS venue_country,
              ${m.dateCol}   AS date,
              ${neutralExpr} AS neutral_venue,
              ${resultExpr}  AS result_type,
              ${formatExpr}  AS format
            FROM ${t.name}
          `;
        });
        const unionSQL = unionParts.join(" UNION ALL ");

        rows = DB.queryAll(
          `SELECT * FROM (${unionSQL})
           WHERE ${yClause()}`,
          [yearMin, yearMax]
        );
      } catch (e) {
        console.warn("[CHORO] Query failed:", e);
        rows = [];
      }
    }

    // Aggregate totals overall and per-format
    const agg = new Map();
    function ensureRec(key){
      if (!agg.has(key)) {
        agg.set(key, { matches:0, homeWins:0, formats: { all:{matches:0,homeWins:0}, odi:{matches:0,homeWins:0}, t20:{matches:0,homeWins:0}, test:{matches:0,homeWins:0} } });
      }
      return agg.get(key);
    }

    for (const r of rows) {
      const y = +(String(r.date).slice(0,4));
      if (!y || y < yearMin || y > yearMax) continue;

      const hostRaw = r.venue_country; if (!hostRaw) continue;
      const neutral = String(r.neutral_venue ?? "0").trim() === "1";
      if (neutral) continue;

      const rt = String(r.result_type || "").toLowerCase().replace("_"," ");
      if (rt === "no result" || rt === "tie" || rt === "tied") continue;

      const hostKey  = canonicalMapName(hostRaw);
      const homeTeam = canonicalTeamName(hostToHomeTeamCountry(hostKey));
      const win      = canonicalTeamName(r.winner || "") === homeTeam;

      const rec = ensureRec(hostKey);
      // overall
      rec.matches += 1; if (win) rec.homeWins += 1;

      // format-specific increment
      const fmtRaw = String(r.format || "").toLowerCase().trim();
      const fmt = (fmtRaw.includes('odi')) ? 'odi' : (fmtRaw.includes('t20') || fmtRaw.includes('twenty')) ? 't20' : (fmtRaw.includes('test') ? 'test' : null);
      if (fmt && rec.formats[fmt]){
        rec.formats[fmt].matches += 1;
        if (win) rec.formats[fmt].homeWins += 1;
      }
    }
    // compute per-format winPct and overall
    agg.forEach(v => {
      v.winPct = v.matches ? v.homeWins / v.matches : 0;
      for (const k of Object.keys(v.formats)){
        const f = v.formats[k]; f.winPct = f.matches ? f.homeWins / f.matches : 0;
      }
    });

    choroByCountry = agg;
    choroActive = agg.size > 0;

    // compute max matches for selected format
    const maxMatches = d3.max(Array.from(agg.values()), d => {
      if (selectedFormat === 'all') return d.matches;
      return d.formats[selectedFormat] ? d.formats[selectedFormat].matches : 0;
    }) || 1;
  // make globe spikes taller for visibility; use a larger max pixel height
  spikeScale.domain([0, maxMatches]).range([0, mode==="globe" ? 56 : 40]);

    document.body.classList.toggle("choro-on", choroActive);
    renderSpikeLegend(maxMatches);
    applyChoropleth();
    drawSpikes();
    console.info("[CHORO] countries:", agg.size, "max matches:", maxMatches);
  }

  function applyChoropleth(){
    if (!choroActive) return;
    gCountries.selectAll("path.country")
      .style("fill", d => {
          const key = canonicalMapName(d.properties?.name || "");
          const rec = choroByCountry.get(key);
          if (!rec) return null;
          const fmtRec = (selectedFormat === 'all') ? rec : (rec.formats[selectedFormat] && rec.formats[selectedFormat].matches ? rec.formats[selectedFormat] : null);
          const pct = fmtRec ? (fmtRec.winPct ?? 0) : rec.winPct;
          const scale = colorScales[selectedFormat] || colorScales.all;
          return scale(pct);
        })
      .selectAll("title").remove();

    // Titles replaced by richer HTML tooltips handled in mouseenter/mouseleave
  }

  function drawSpikes(){
    // Do not render spikes in 2D map mode — spikes are a 3D/globe visual.
    if (mode === 'map') {
      // ensure any previously-created spikes are removed/hidden when switching to map
      try { gSpikes.selectAll('*').remove(); } catch(e) {}
      return;
    }
    const data = [];
    countries.forEach(f => {
      const key = canonicalMapName(f.properties?.name || "");
  const rec = choroByCountry.get(key);
  if (!rec) return;
  const fmtRec = (selectedFormat === 'all') ? rec : (rec.formats[selectedFormat] && rec.formats[selectedFormat].matches ? rec.formats[selectedFormat] : null);
  const matches = fmtRec ? fmtRec.matches : rec.matches;
  const winPct  = fmtRec ? (fmtRec.winPct ?? 0) : rec.winPct;
  if (!matches) return;
      const c = d3.geoCentroid(f);
      if (!c || !isFinite(c[0]) || !isFinite(c[1])) return;
      data.push({ key, lon:c[0], lat:c[1], matches, winPct });
    });

    const sel = gSpikes.selectAll("line.spike").data(data, d => d.key);
    sel.exit().remove();
    // use a high-contrast dark-red stroke for spikes and make them thicker
    const SPIKE_COLOR = '#8b0000';
    sel.enter().append("line").attr("class","spike")
  .merge(sel)
  .attr("stroke", SPIKE_COLOR)
  .attr("stroke-width", 3.5)
  .attr("opacity", 0.95);

    updateSpikesPosition();
  }

  function updateSpikesPosition(){
    // If map-mode, hide spikes entirely (they are a globe-only visual)
    if (mode === 'map') {
      gSpikes.selectAll("line.spike").style('display', 'none');
      return;
    }

    gSpikes.selectAll("line.spike").each(function(d){
      const p = projection([d.lon, d.lat]);
      if (!p) return;
      let visible = true;
      if (mode === "globe") {
        const r = projection.rotate();
        visible = d3.geoDistance([d.lon, d.lat], [-r[0], -r[1]]) <= Math.PI/2;
      }
      d3.select(this).style("display", visible ? "block" : "none");
      const len = spikeScale(d.matches) * (mode==="globe" ? globeZoomK : 1);
      d3.select(this).attr("x1", p[0]).attr("y1", p[1]).attr("x2", p[0]).attr("y2", p[1] - len);
    });
  }

  function renderSpikeLegend(maxMatches){
    if (!spikeLegend) return;
    const svgL = d3.select(spikeLegend);
    svgL.selectAll("*").remove();
    const w = +svgL.attr("width"), h = +svgL.attr("height");
    const cx = 24, baseY = h - 8;
    // Use the same spikeScale so legend matches rendered spike heights.
    // Ensure we copy the current domain/range for local computations.
    const localScale = spikeScale.copy ? spikeScale.copy() : d3.scaleLinear().domain([0, maxMatches]).range([0, 34]);
    // If the global spikeScale range is larger (globe mode), reflect that in legend height
    // but keep it visually constrained to the legend box.
    const maxPx = Math.min(56, (localScale(maxMatches) || 34));
    localScale.range([0, maxPx]).domain([0, maxMatches]);
    const ticks = (localScale.ticks && typeof localScale.ticks === 'function') ? localScale.ticks(3) : d3.scaleLinear().domain([0, maxMatches]).ticks(3);
  const SPIKE_COLOR = '#8b0000'; // dark red for legend lines/text
    // main spike line
    svgL.append("line").attr("x1", cx).attr("y1", baseY).attr("x2", cx).attr("y2", baseY - localScale(maxMatches))
      .attr("stroke", SPIKE_COLOR).attr("stroke-width", 2).attr("opacity", 0.95);
    // ticks + labels
    ticks.forEach(t => {
      const y = baseY - localScale(t);
      svgL.append("line").attr("x1", cx-6).attr("y1", y).attr("x2", cx+6).attr("y2", y).attr("stroke", SPIKE_COLOR).attr("opacity",0.8);
      svgL.append("text").attr("x", cx+12).attr("y", y+4).attr("fill",SPIKE_COLOR).attr("font-size", 11).text(t);
    });
    // explanatory label (smaller) to clarify the metric
    svgL.append('text').attr('x', 6).attr('y', 12).attr('fill', SPIKE_COLOR).attr('font-size', 11).text('Spike height = matches hosted');
  }

  /* ------------------------- Focus helpers (globe / map) ------------------ */
  // Smoothly rotate the globe to center on the feature's centroid
  function focusGlobeOn(feature){
    return new Promise((resolve) => {
      try{
        const c = d3.geoCentroid(feature);
        if (!c || !isFinite(c[0]) || !isFinite(c[1])) { resolve(); return; }
        const targetRot = [-c[0], -c[1], 0];
        const currentRot = projection.rotate();

        // First animate rotation to center the feature
        const rotInterp = d3.interpolate(currentRot, targetRot);
        d3.transition().duration(700).tween('rotate', () => t => { projection.rotate(rotInterp(t)); redrawAll(); })
          .on('end', () => {
            // After rotation, compute feature bounds and pick a reasonable zoom factor
            try{
              const b = path.bounds(feature);
              const rect = container.getBoundingClientRect();
              const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
              const dx = Math.max(4, Math.abs(b[1][0] - b[0][0]));
              const dy = Math.max(4, Math.abs(b[1][1] - b[0][1]));
              // desired scale factor relative to current baseScale: want feature to fill ~40-60% of view
              const scaleX = width / dx; const scaleY = height / dy;
              // increase multiplier so the focused country zooms in more strongly
              let desiredK = Math.min(12, Math.max(1, 0.75 * Math.min(scaleX, scaleY)));
              // animate globeZoomK from current to desired (smoother duration)
              const startK = globeZoomK || 1;
              const kInterp = d3.interpolateNumber(startK, desiredK);
              d3.transition().duration(600).tween('zoomk', () => t => { globeZoomK = kInterp(t); projection.scale(baseScale * globeZoomK); redrawAll(); }).on('end', resolve);
            }catch(e){ console.warn('post-rotate focus adjustments failed', e); resolve(); }
          });
      }catch(e){ console.warn('focusGlobeOn failed', e); resolve(); }
    });
  }

  // Zoom & pan the flat map to fit the feature into view
  function focusMapOn(feature){
    return new Promise((resolve) => {
      try{
        const bounds = path.bounds(feature);
        const rect = container.getBoundingClientRect();
        const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
        const dx = bounds[1][0] - bounds[0][0];
        const dy = bounds[1][1] - bounds[0][1];
        const x = (bounds[0][0] + bounds[1][0]) / 2;
        const y = (bounds[0][1] + bounds[1][1]) / 2;
        const scale = Math.max(1, 0.8 * Math.min(width / dx, height / dy));
        const translate = [width / 2 - scale * x, height / 2 - scale * y];
        const t = d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale);
        svg.transition().duration(700).call(zoomMap.transform, t).on('end', resolve);
      }catch(e){ console.warn('focusMapOn failed', e); resolve(); }
    });
  }

  // Create legend UI using D3 and place it to the right, below the toggle
  function createLegendUI(){
    // Remove any existing legend created earlier
    d3.selectAll('.legend').remove();

    const legend = d3.select('body').append('div').attr('class','legend').attr('aria-live','polite');

    // Section: choropleth + format buttons
    const sec1 = legend.append('div').attr('class','legend-section');
    const header = sec1.append('div').style('display','flex').style('align-items','center').style('gap','12px').style('justify-content','space-between');
    header.append('div').attr('class','legend-title').text('Home win % (by host country)');
    const fmtWrap = header.append('div').attr('class','format-toggle').attr('role','tablist').attr('aria-label','Format filter');
    fmtWrap.append('button').attr('class','fmt-btn').attr('data-format','all').attr('role','tab').attr('aria-selected','true').text('All');
    fmtWrap.append('button').attr('class','fmt-btn').attr('data-format','odi').attr('role','tab').attr('aria-selected','false').text('ODI');
    fmtWrap.append('button').attr('class','fmt-btn').attr('data-format','t20').attr('role','tab').attr('aria-selected','false').text('T20');
    fmtWrap.append('button').attr('class','fmt-btn').attr('data-format','test').attr('role','tab').attr('aria-selected','false').text('Test');

    const grad = sec1.append('div').attr('class','legend-gradient');
    grad.append('div').attr('class','legend-gradbar');
    grad.append('div').attr('class','legend-scale').html('<span>0%</span><span>50%</span><span>100%</span>');

    // Section: spike legend (svg)
  const sec2 = legend.append('div').attr('class','legend-section spike-section');
  sec2.append('div').attr('class','legend-title').text('Win spikes = matches hosted');
    // attach an svg for spike legend
  const svgEl = sec2.append('svg').attr('width', 160).attr('height', 72);
  spikeLegend = svgEl.node();
  spikeLegendSection = sec2.node();

    // Position the legend: top-right, below toggle
    // CSS `.legend` rules provide baseline styling; adjust position relative to toggle
    // ensure the element exists for setupFormatUI to wire
    return legend.node();
  }

  // Format selector UI wiring
  function setupFormatUI(){
    const btns = document.querySelectorAll('.fmt-btn');
    if (!btns || !btns.length) return;
    btns.forEach(b => b.addEventListener('click', () => {
      const fmt = b.dataset.format || 'all';
      selectedFormat = fmt;
      // publish globally for other UI (venue popup) to react
      window.selectedFormat = selectedFormat;
      window.dispatchEvent(new CustomEvent('format:change', { detail: { format: selectedFormat } }));
      btns.forEach(x => x.setAttribute('aria-selected', x === b ? 'true' : 'false'));
      // update legend gradient
      const grad = document.querySelector('.legend-gradbar');
      if (grad) grad.style.background = `linear-gradient(90deg, ${PALETTES[fmt][0]}, ${PALETTES[fmt][1]}, ${PALETTES[fmt][2]})`;
      // recompute spike domain based on available aggregated data
      const maxMatches = d3.max(Array.from(choroByCountry.values()||[]), d => (selectedFormat==='all' ? d.matches : (d.formats[selectedFormat] ? d.formats[selectedFormat].matches : 0))) || 1;
      spikeScale.domain([0, maxMatches]);
      applyChoropleth(); drawSpikes(); renderSpikeLegend(maxMatches);
    }));
    // initialize gradient
    const initGrad = document.querySelector('.legend-gradbar');
    if (initGrad) initGrad.style.background = `linear-gradient(90deg, ${PALETTES.all[0]}, ${PALETTES.all[1]}, ${PALETTES.all[2]})`;
  }

  /* ---------------------------- Redraw Cycle -------------------------------- */
  function redrawAll(){
    gRoot.selectAll("path").attr("d", path);
    updateHoverTransform();
    updateVenuesPosition();
    updateSpikesPosition();
  }
  function updateHoverTransform(){
    gCountries.selectAll("path.country").each(function (d) {
      const sel = d3.select(this);
      if (hoveredId && d.id === hoveredId) {
        const [cx, cy] = path.centroid(d);
        sel.classed("hovered", true).style("transform", `translate(${cx}px, ${cy}px) scale(1.025) translate(${-cx}px, ${-cy}px)`);
      } else {
        sel.classed("hovered", false).style("transform", null);
      }
    });
  }

  /* ------------------------------ Spin ------------------------------------- */
  function startSpin(){
    stopSpin();
    lastElapsed = null;
    spinTimer = d3.timer((elapsed) => {
      if (mode !== "globe" || isDragging || countryFocused) { lastElapsed = elapsed; return; }
      if (lastElapsed == null) lastElapsed = elapsed;
      const dt = elapsed - lastElapsed; lastElapsed = elapsed;
      const r = projection.rotate(); r[0] += (SPIN_DEG_PER_SEC/1000) * dt; projection.rotate(r);
      redrawAll();
    });
  }
  function stopSpin(){ if (spinTimer) { spinTimer.stop(); spinTimer = null; } }

  /* --------------------------- Interactions -------------------------------- */
  const dragGlobe = d3.drag()
    .on("start", (event) => { isDragging = true; stopSpin(); prev = [event.x, event.y]; })
    .on("drag",  (event) => {
      if (!prev) prev = [event.x, event.y];
      const dx = event.x - prev[0], dy = event.y - prev[1];
      const r = projection.rotate();
      const lambda = r[0] + dx * 0.25;
      const phi    = Math.max(-90, Math.min(90, r[1] - dy * 0.25));
      projection.rotate([lambda, phi, r[2]]);
      prev = [event.x, event.y]; redrawAll();
    })
    .on("end",   () => { isDragging = false; prev = null; startSpin(); });

  const zoomGlobe = d3.zoom()
    .scaleExtent([0.4, 32])
    .filter(function(event){
      // allow wheel (mouse wheel) and touchstart/pointer interactions (primary button)
      if (!event) return false;
      if (event.type === 'wheel') return true;
      if (event.type === 'touchstart') return true;
      if (event.type === 'pointerdown' || event.type === 'mousedown') {
        // only primary button
        return (typeof event.button === 'number') ? (event.button === 0) : true;
      }
      return false;
    })
    .on("zoom", (event) => { globeZoomK = event.transform.k; projection.scale(baseScale * globeZoomK); redrawAll(); });

  const zoomMap = d3.zoom()
    .scaleExtent([1, 12])
    .on("zoom", (event) => { mapZoomK = event.transform.k; gRoot.attr("transform", event.transform); });

  /* ----------------------------- Mode Toggle ------------------------------- */
  // legacy tilt input removed; new toggle uses #btn and events

  function updateToggleUI(animate=true){
    const shouldBeChecked = (mode === "map");

    // legacy tilt-toggle handling removed; new toggle (#btn) handled below

    // New toggle (id="btn") support
    const newToggle = document.getElementById('btn');
    if (newToggle) {
      if (newToggle.checked !== shouldBeChecked) newToggle.checked = shouldBeChecked;
      newToggle.setAttribute('aria-checked', shouldBeChecked ? 'true' : 'false');
    }

  // notify other UI (toggle label) about the current mode so they can update text
  window.dispatchEvent(new CustomEvent('view-mode-sync', { detail: { map: shouldBeChecked } }));
  }

  // legacy tilt input event handlers removed

  // Listen for the new toggle's custom events (dispatched by tilt-toggle.js replacement)
  window.addEventListener('view-toggle', (ev) => {
    const isMap = ev?.detail?.map;
    setMode(isMap ? 'map' : 'globe');
  });

  function setMode(newMode){
    if (newMode === mode) return;
    mode = newMode; gRoot.attr("transform", null);

    if (mode === "map") {
      stopSpin(); gRoot.on(".drag", null);
      svg.on(".zoom", null).call(zoomMap).call(zoomMap.transform, d3.zoomIdentity);
      mapZoomK = 1; projection = mapProj; path.projection(projection);
      resize(); redrawAll();
    } else {
      globeZoomK = 1; svg.on(".zoom", null).call(zoomGlobe).call(zoomGlobe.transform, d3.zoomIdentity);
      gRoot.call(dragGlobe); projection = globeProj; path.projection(projection);
      resize(); redrawAll(); startSpin();
    }
    updateToggleUI(true);
  // reflect map vs globe in body class so UI (legend) can adapt
  document.body.classList.toggle('map-mode', mode === 'map');
  // hide spike legend when in 2D map mode (spikes are a globe visual)
  try { if (spikeLegendSection) spikeLegendSection.style.display = (mode === 'map' ? 'none' : 'block'); } catch(e){}
    const maxMatches = d3.max(Array.from(choroByCountry.values()||[]), d => d.matches) || 1;
  spikeScale.range([0, mode==="globe" ? 56 : 40]);
    updateSpikesPosition();
  }

  /* ------------------------------- Resize ---------------------------------- */
  function resize(){
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    svg.attr("width", width).attr("height", height);
    if (mode === "globe") {
      const size = Math.min(width, height);
      baseScale = (size/2) * 0.95;
      projection.translate([width/2, height/2]).scale(baseScale * globeZoomK).clipAngle(90);
    } else {
      const margin = 20;
      projection.fitExtent([[margin, margin], [width - margin, height - margin]], { type: "Sphere" });
    }
    redrawAll();
    initYearBox(true);
  }
  window.addEventListener("resize", resize);

  /* ------------------------------- Reset ----------------------------------- */
  svg.on("dblclick", () => {
    if (mode === "globe") {
      projection.rotate([0,0,0]); globeZoomK = 1; countryFocused = false; startSpin();
      svg.transition().duration(500).call(zoomGlobe.transform, d3.zoomIdentity).on("end", redrawAll);
    } else {
      svg.transition().duration(400).call(zoomMap.transform, d3.zoomIdentity).on("end", () => gRoot.attr("transform", null));
      mapZoomK = 1; countryFocused = false;
    }
  });

  /* --------------------------- Overlay (Leaderboards) ---------------------- */
  function openOverlay(){ overlay.hidden=false; backdrop.hidden=false;
    overlay.classList.add("open"); backdrop.classList.add("open"); btnMenu.classList.add("open");
    btnMenu.setAttribute("aria-expanded","true"); overlay.setAttribute("aria-hidden","false");
    if (mode==="globe") stopSpin(); setActiveTab("batting"); tabPanel.focus();
  }
  function closeOverlay(){ overlay.classList.remove("open"); backdrop.classList.remove("open"); btnMenu.classList.remove("open");
    btnMenu.setAttribute("aria-expanded","false"); overlay.setAttribute("aria-hidden","true");
    setTimeout(()=>{ overlay.hidden=true; backdrop.hidden=true; },180);
    if (mode==="globe" && !countryFocused) startSpin();
  }
  function toggleOverlay(){ if (overlay.hidden) openOverlay(); else closeOverlay(); }
  btnMenu.addEventListener("click", toggleOverlay);
  btnClose.addEventListener("click", closeOverlay);
  backdrop.addEventListener("click", closeOverlay);
  window.addEventListener("keydown", (e)=>{ if(e.key==="Escape" && !overlay.hidden) closeOverlay(); });

  // Prevent clicks inside the overlay from bubbling to the backdrop (which would close it)
  if (overlay) overlay.addEventListener('click', (e) => { e.stopPropagation(); });

  tabBtns.forEach(btn => btn.addEventListener("click", () => setActiveTab(btn.dataset.kind)));
  function setActiveTab(kind){
    tabBtns.forEach(b => { const on=b.dataset.kind===kind; b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true":"false"); });
    renderLeaderboard(kind);
  }

  // Normalize best field like "4/25" or numeric best; used by comparator
  function parseBestField(v){
    if (v == null) return { wk:0, runs:0 };
    if (typeof v === 'number') return { wk: +v, runs: 0 };
    const s = String(v).trim(); if (!s) return { wk:0, runs:0 };
    const m = s.match(/(\d+)\s*\/?\s*(\d*)/);
    if (!m) return { wk:0, runs:0 };
    return { wk: +(m[1]||0), runs: +(m[2]||0) };
  }

  // comparator for table rows; handles numeric columns and special 'best' semantics
  function makeComparator(sortState){
    return function(a,b){
      const col = sortState.col;
      if (!col) return 0;
      if (col === 'best'){
        const pa = parseBestField(a.best), pb = parseBestField(b.best);
        if (pa.wk !== pb.wk) return (sortState.dir==='desc') ? d3.descending(pa.wk,pb.wk) : d3.ascending(pa.wk,pb.wk);
        return (sortState.dir==='desc') ? d3.ascending(pa.runs,pb.runs) : d3.descending(pa.runs,pb.runs);
      }
      const av = a[col], bv = b[col];
      if (av == null || bv == null) return 0;
      return (sortState.dir==='desc') ? d3.descending(av,bv) : d3.ascending(av,bv);
    };
  }

  // Attempt to build batting leaderboard from DB; falls back to demo
  async function getBattingLeaderboard(minYear, maxYear, format='all', limit=50){
    try{
      // join matches to filter by match date (year) and prefer format from matches when present
      const fmtCond = (format && format !== 'all') ? `AND LOWER(COALESCE(m.format, bi.format, '')) LIKE ?` : '';
      const params = [minYear, maxYear]; if (fmtCond) params.push(`%${format}%`);
      const rows = await DB.queryAll(`
        SELECT bi.batter AS player, bi.team AS team,
               COUNT(DISTINCT bi.match_id) AS matches,
               SUM(CAST(bi.runs AS INT)) AS runs,
               SUM(CAST(bi.balls AS INT)) AS balls,
               SUM(CASE WHEN COALESCE(bi.out,'')<>'' THEN 1 ELSE 0 END) AS dismissals,
               SUM(CASE WHEN CAST(bi.runs AS INT) >= 100 THEN 1 ELSE 0 END) AS hundreds,
               SUM(CASE WHEN CAST(bi.runs AS INT) BETWEEN 50 AND 99 THEN 1 ELSE 0 END) AS fifties,
               MAX(CAST(bi.runs AS INT)) AS best
        FROM batting_innings bi
        LEFT JOIN matches m ON bi.match_id = m.match_id
        WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? ${fmtCond}
        GROUP BY bi.batter, bi.team
        ORDER BY runs DESC
        LIMIT ${limit}
      `, params);
      if (!rows) return null;
      return rows.map(r => ({
        player: r.player,
        team: r.team,
        matches: +r.matches||0,
        runs: +r.runs||0,
        balls: +r.balls||0,
        sr: r.balls ? +(100*(r.runs/r.balls)).toFixed(1) : 0,
        avg: r.dismissals ? +(r.runs / r.dismissals).toFixed(2) : (r.matches ? +(r.runs / r.matches).toFixed(2) : 0),
        hundreds: +r.hundreds||0,
        fifties: +r.fifties||0,
        best: r.best
      }));
    }catch(e){ console.warn('batting leaderboard SQL failed', e); return null; }
  }

  // Attempt to build bowling leaderboard from DB; falls back to demo
  async function getBowlingLeaderboard(minYear, maxYear, format='all', limit=50){
    try{
      // join matches for date filtering and format resolution
      const fmtCond = (format && format !== 'all') ? `AND LOWER(COALESCE(m.format, bi.format, '')) LIKE ?` : '';
      const params = [minYear, maxYear]; if (fmtCond) params.push(`%${format}%`);
      const rows = await DB.queryAll(`
        SELECT bi.bowler AS player, bi.team AS team,
               COUNT(DISTINCT bi.match_id) AS matches,
               SUM(CAST(bi.wickets AS INT)) AS wkts,
               SUM(CAST(bi.runs_conceded AS INT)) AS runs_conceded,
               SUM(CAST(bi.legal_balls AS INT)) AS balls,
               SUM(CASE WHEN CAST(bi.wickets AS INT) >= 5 THEN 1 ELSE 0 END) AS five_wkts,
               MAX(CAST(bi.wickets AS INT)) AS best_wkts
        FROM bowling_innings bi
        LEFT JOIN matches m ON bi.match_id = m.match_id
        WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? ${fmtCond}
        GROUP BY bi.bowler, bi.team
        ORDER BY wkts DESC
        LIMIT ${limit}
      `, params);
      if (!rows) return null;
      // For each row, try to fetch the minimal runs_conceded for the best_wkts to present best as W/R
      const out = [];
      for (const r of rows){
        let bestRuns = 0;
        try{
          let br;
          if (fmtCond) {
            br = await DB.queryAll(
              `SELECT MIN(CAST(bi.runs_conceded AS INT)) AS runs FROM bowling_innings bi LEFT JOIN matches m ON bi.match_id = m.match_id WHERE LOWER(COALESCE(m.format, bi.format, '')) LIKE ? AND bi.bowler = ? AND CAST(bi.wickets AS INT) = ? LIMIT 1`,
              [`%${format}%`, r.player, r.best_wkts]
            );
          } else {
            br = await DB.queryAll(
              `SELECT MIN(CAST(bi.runs_conceded AS INT)) AS runs FROM bowling_innings bi WHERE bi.bowler = ? AND CAST(bi.wickets AS INT) = ? LIMIT 1`,
              [r.player, r.best_wkts]
            );
          }
          if (br && br[0] && br[0].runs != null) bestRuns = +br[0].runs;
        }catch(e) { /* ignore per-player best fetch errors */ }
        out.push({
          player: r.player,
          team: r.team,
          matches: +r.matches||0,
          wkts: +r.wkts||0,
          runs_conceded: +r.runs_conceded||0,
          balls: +r.balls||0,
          eco: r.balls ? +((r.runs_conceded/(r.balls/6))).toFixed(2) : 0,
          avg: r.wkts ? +(r.runs_conceded / r.wkts).toFixed(2) : 0,
          five_wkts: +r.five_wkts||0,
          best: `${r.best_wkts||0}/${bestRuns||0}`
        });
      }
      return out;
    }catch(e){ console.warn('bowling leaderboard SQL failed', e); return null; }
  }

  // Render leaderboard into overlay; supports format filter and sorting via delegated header click
  async function renderLeaderboard(kind = "batting") {
    tabPanel.innerHTML = `<div class="lb-loading">Loading...</div>`;
    let rows = [];
    const fmtDefault = (typeof selectedFormat === 'string' ? selectedFormat : 'all') || 'all';
    let fmt = fmtDefault;

    // initial sort state: batting -> runs, bowling -> wkts
    const sortState = { col: (kind === 'batting' ? 'runs' : (kind === 'bowling' ? 'wkts' : null)), dir: 'desc' };

    async function fetchRows() {
      try {
        const { min, max } = yearRange || { min: YEAR_MIN, max: YEAR_MAX };
        if (kind === 'batting') rows = await getBattingLeaderboard(min, max, fmt) || battingData.slice();
        else rows = await getBowlingLeaderboard(min, max, fmt) || bowlingData.slice();
      } catch (e) { console.warn('leaderboard query failed', e); rows = (kind === 'batting' ? battingData.slice() : bowlingData.slice()); }
      // normalize fallback rows to expected fields
      rows = rows.map(r => ({
        matches: r.matches || 0,
        runs: r.runs || 0,
        balls: r.balls || 0,
        sr: r.sr || 0,
        avg: r.avg || 0,
        hundreds: r.hundreds || 0,
        fifties: r.fifties || 0,
        wkts: r.wkts || 0,
        eco: r.eco || 0,
        five_wkts: r.five_wkts || 0,
        best: r.best || '',
        player: r.player || '',
        team: r.team || ''
      }));
    }

    function buildControls() {
      const fmtHtml = `<div class="lb-controls"><div class="fmt-filter" role="tablist" aria-label="Format filter">
        <button class="lb-fmt-btn" data-format="all" aria-pressed="${fmt==='all'}">All</button>
        <button class="lb-fmt-btn" data-format="odi" aria-pressed="${fmt==='odi'}">ODI</button>
        <button class="lb-fmt-btn" data-format="t20" aria-pressed="${fmt==='t20'}">T20</button>
        <button class="lb-fmt-btn" data-format="test" aria-pressed="${fmt==='test'}">Test</button>
      </div></div>`;
      tabPanel.innerHTML = fmtHtml + `<div class="lb-wrap">${tabPanel.innerHTML}</div>`;
      const btns = tabPanel.querySelectorAll('.lb-fmt-btn');
      btns.forEach(b => b.addEventListener('click', async () => {
        const f = b.dataset.format || 'all';
        fmt = f; btns.forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
        await fetchRows(); buildTable();
      }));
    }

    function buildTable() {
      const head = (kind === 'batting')
        ? `<tr><th>#</th><th>Player</th><th>Team</th><th data-col="matches" class="sortable">Matches</th><th data-col="runs" class="sortable">Runs</th><th data-col="sr" class="sortable">SR</th><th data-col="avg" class="sortable">Avg</th><th data-col="hundreds" class="sortable">100s</th><th data-col="fifties" class="sortable">50s</th><th data-col="best" class="sortable">Best</th></tr>`
        : `<tr><th>#</th><th>Player</th><th>Team</th><th data-col="matches" class="sortable">Matches</th><th data-col="wkts" class="sortable">Wkts</th><th data-col="eco" class="sortable">Eco</th><th data-col="avg" class="sortable">Avg</th><th data-col="five_wkts" class="sortable">5W</th><th data-col="best" class="sortable">Best</th></tr>`;

      const comp = makeComparator(sortState);
      const sorted = rows.slice().sort(comp).slice(0, 10);
      const body = sorted.map((r, i) => {
        if (kind === 'batting') return `<tr><td>${i+1}</td><td>${r.player}</td><td>${r.team||''}</td><td>${r.matches}</td><td>${r.runs}</td><td>${r.sr}</td><td>${r.avg}</td><td>${r.hundreds}</td><td>${r.fifties}</td><td>${r.best||''}</td></tr>`;
        return `<tr><td>${i+1}</td><td>${r.player}</td><td>${r.team||''}</td><td>${r.matches}</td><td>${r.wkts}</td><td>${r.eco}</td><td>${r.avg}</td><td>${r.five_wkts}</td><td>${r.best||''}</td></tr>`;
      }).join('');

      const tableHtml = `<table class="lb-table" aria-describedby="lbMeta"><thead>${head}</thead><tbody>${body}</tbody></table>`;
      const meta = `<p id="lbMeta" class="lb-meta">Top 10 — ${kind} — format: ${fmt.toUpperCase()}</p>`;
      tabPanel.querySelector('.lb-wrap')?.remove();
      tabPanel.insertAdjacentHTML('beforeend', `<div class="lb-wrap">${tableHtml}${meta}</div>`);

      const thead = tabPanel.querySelector('thead');
      if (thead) {
        thead.style.userSelect = 'none';
        const newThead = thead.cloneNode(true);
        thead.parentNode.replaceChild(newThead, thead);
        newThead.addEventListener('click', (ev) => {
          const th = ev.target.closest('th'); if (!th) return;
          const col = th.dataset.col; if (!col) return;
          if (sortState.col === col) sortState.dir = (sortState.dir === 'desc' ? 'asc' : 'desc');
          else { sortState.col = col; sortState.dir = 'desc'; }
          buildTable();
        });
      }
    }

    await fetchRows();
    buildControls();
    buildTable();
  }

  /* ----------------------- Country Focus & Venue Load ---------------------- */
  async function handleCountryClick(feature){
    const name = canonicalMapName(feature.properties?.name || "");
    if (!name) return;
    // If we don't know of any venues for this country, show a friendly message
    if (!venueCountrySet || !venueCountrySet.has(name)){
      const pretty = feature.properties?.name || name;
      // playful but informative message; don't attempt to load venues
      toast(`${pretty} seems quiet — no stadiums on record here. Try a neighbouring country!`);
      // hide toast after short delay
      setTimeout(() => toastHide(), 1400);
      return;
    }

    countryFocused = true; stopSpin();
    toast(`Searching stadiums in ${feature.properties?.name || "country"}…`);
    if (mode === "globe") await focusGlobeOn(feature); else await focusMapOn(feature);
    try {
      const rows = await loadVenuesForCountry(name);
      addVenues(rows); drawVenues();
    } catch(e){ console.warn("Failed loading venues for", name, e); }
    finally { toastHide(); }
  }
  function pickCoord(row, keys){
    for (const k of keys) {
      if (!k) continue;
      if (row.hasOwnProperty(k)) return +row[k];
      const hit = Object.keys(row).find(kk => kk.toLowerCase() === String(k).toLowerCase());
      if (hit) return +row[hit];
    }
    return NaN;
  }

  /* -------------------------------- Init ----------------------------------- */
  await DB.init(DB_URL);
  resize();
  drawStaticLayers();
  drawCountries();

  // Pre-highlight countries having venues
  venuesAll = []; venueIndex.clear();
  try { venueCountrySet = await loadVenueCountries(); applyCountryHighlight(); }
  catch(e){ console.warn("Could not derive venue countries from DB:", e); }

  // Interactions
  gRoot.call(dragGlobe);
  svg.call(zoomGlobe).call(zoomGlobe.transform, d3.zoomIdentity);
  updateToggleUI(false); startSpin();

  // build legend UI (D3) and wire format buttons
  createLegendUI();

  // pause/resume spin on popup and ensure transient loader is hidden when popup state changes
  window.addEventListener("venuewindow:open",  () => { hideVenueLoading(); stopSpin(); });
  window.addEventListener("venuewindow:close", () => { hideVenueLoading(); if (mode==="globe" && !countryFocused) startSpin(); });

  // stop map gestures when using the slider
  ["pointerdown","mousedown","touchstart","wheel"].forEach(ev =>
    yearBox?.addEventListener(ev, e => e.stopPropagation(), { passive: true })
  );

  /* ------------------------- Venue DB helpers ----------------------------- */
  // Return an array (Set-like) of canonical country names that have venues in the DB
  async function loadVenueCountries(){
    try{
      const schema = await getVenueSchema();
      if (!schema || !schema.countryCol) return new Set();
      const col = schema.countryCol;
      const rows = await DB.queryAll(`SELECT DISTINCT ${col} AS country FROM venues WHERE ${col} IS NOT NULL`);
      const s = new Set();
      for (const r of rows){ if (r && r.country) s.add(canonicalMapName(r.country)); }
      return s;
    }catch(e){ console.warn('loadVenueCountries failed', e); return new Set(); }
  }

  // Load venue rows for a canonical country name. Uses a case-insensitive LIKE match
  async function loadVenuesForCountry(name){
    try{
      const schema = await getVenueSchema();
      if (!schema || !schema.countryCol) return [];
      const col = schema.countryCol;
      const q = `SELECT * FROM venues WHERE LOWER(COALESCE(${col},'')) LIKE ?`;
      const rows = await DB.queryAll(q, [`%${String(name).toLowerCase()}%`]);
      // Normalize numeric coordinates if possible
      return (rows || []).map(r => {
        // ensure lat/lon keys exist in consistent names
        const out = Object.assign({}, r);
        if (schema.lonCol && !out.longitude && out.hasOwnProperty(schema.lonCol)) out.longitude = out[schema.lonCol];
        if (schema.latCol && !out.latitude && out.hasOwnProperty(schema.latCol)) out.latitude = out[schema.latCol];
        return out;
      });
    }catch(e){ console.warn('loadVenuesForCountry failed', e); return []; }
  }

  // landing → full view
  enterBtn?.addEventListener("click", () => {
  document.body.classList.remove("landing"); // show UI, hero hidden
  setMode("globe");                           // ensure globe mode
  requestAnimationFrame(() => {               // reflow after hero hides
    resize();
    startSpin();
  });
});

  // slider init & wiring
  initYearBox(false);
  window.addEventListener("yearrange:change", async (ev) => {
    const { min, max } = ev.detail || {};
    console.info("[SLIDER] range:", min, max);
    await computeChoropleth(min, max);
    // If the leaderboard overlay is open, refresh it so it respects the new year range
    try {
      if (overlay && !overlay.hidden) {
        const active = tabBtns.find(b => b.classList.contains('active'))?.dataset.kind || 'batting';
        // re-render the active leaderboard tab (debounce lightly by next tick)
        setTimeout(() => { renderLeaderboard(active); }, 20);
      }
    } catch (e) { console.warn('yearrange:change re-render failed', e); }
  });

  // initial choropleth + spikes
  await computeChoropleth(yearRange.min, yearRange.max);
  // wire up the format selector once initial data is available
  setupFormatUI();

  /* ------------------------- Utilities: slider ------------------------------ */
  function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }

  function initYearBox(recomputeOnly){
    if (!yearBox || !yrSlider || !yrTrack || !yrThumbL || !yrThumbR) return;

    // initial values
    let vL = Number.isFinite(yearRange?.min) ? +yearRange.min : YEAR_MIN;
    let vR = Number.isFinite(yearRange?.max) ? +yearRange.max : YEAR_MAX;

    function render(emit=true){
      // compute current geometry each render (robust to layout shifts)
      const trackRect = yrTrack.getBoundingClientRect();
      const sliderRect = yrSlider.getBoundingClientRect();
      const W = Math.max(1, trackRect.width);
      const trackLeftInSlider = trackRect.left - sliderRect.left;

      const xToYear = d3.scaleLinear().domain([0, W]).range([YEAR_MIN, YEAR_MAX]);
      const yearToX = d3.scaleLinear().domain([YEAR_MIN, YEAR_MAX]).range([0, W]);

      if (vL > vR) [vL, vR] = [vR, vL];
      vL = clamp(Math.round(vL), YEAR_MIN, YEAR_MAX);
      vR = clamp(Math.round(vR), YEAR_MIN, YEAR_MAX);

      const xL = yearToX(vL);
      const xR = yearToX(vR);

      yrFill.style.left  = `${trackLeftInSlider + xL}px`;
      yrFill.style.width = `${xR - xL}px`;

      yrThumbL.style.left = `${trackLeftInSlider + xL}px`;
      yrThumbR.style.left = `${trackLeftInSlider + xR}px`;

      yrBubbleL.textContent = Math.round(vL);
      yrBubbleR.textContent = Math.round(vR);
      yearBoxValue.textContent = `Years ${Math.round(vL)}–${Math.round(vR)}`;

      if (emit) {
        yearRange = { min: Math.round(vL), max: Math.round(vR) };
        window.dispatchEvent(new CustomEvent("yearrange:change", { detail: yearRange }));
      }
    }

    if (recomputeOnly) { render(false); return; }

    const dragLeft = d3.drag()
      .on("start", function(event) {
        yearBox.classList.add("dragging");
        try { d3.select(this).raise(); } catch(e){}
        d3.select(this).classed('active', true);
      })
      .on("drag", (event) => {
        const trackRect = yrTrack.getBoundingClientRect();
        const W = Math.max(1, trackRect.width);
        const [px] = d3.pointer(event, yrTrack);
        const clampedPx = clamp(px, 0, W);
        const xToYear = d3.scaleLinear().domain([0, W]).range([YEAR_MIN, YEAR_MAX]);
        const yearToX = d3.scaleLinear().domain([YEAR_MIN, YEAR_MAX]).range([0, W]);
        const maxX = yearToX(vR);
        const finalPx = clamp(clampedPx, 0, maxX);
        vL = Math.round(xToYear(finalPx));
        render();
      })
      .on("end", function() { yearBox.classList.remove("dragging"); d3.select(this).classed('active', false); });

    const dragRight = d3.drag()
      .on("start", function(event) {
        yearBox.classList.add("dragging");
        try { d3.select(this).raise(); } catch(e){}
        d3.select(this).classed('active', true);
      })
      .on("drag", (event) => {
        const trackRect = yrTrack.getBoundingClientRect();
        const W = Math.max(1, trackRect.width);
        const [px] = d3.pointer(event, yrTrack);
        const clampedPx = clamp(px, 0, W);
        const xToYear = d3.scaleLinear().domain([0, W]).range([YEAR_MIN, YEAR_MAX]);
        const yearToX = d3.scaleLinear().domain([YEAR_MIN, YEAR_MAX]).range([0, W]);
        const minX = yearToX(vL);
        const finalPx = clamp(clampedPx, minX, W);
        vR = Math.round(xToYear(finalPx));
        render();
      })
      .on("end", function() { yearBox.classList.remove("dragging"); d3.select(this).classed('active', false); });

    d3.select(yrThumbL).call(dragLeft);
    d3.select(yrThumbR).call(dragRight);

    d3.select(yrTrack).on("mousedown touchstart", (event) => {
      // recompute geometry
      const trackRect = yrTrack.getBoundingClientRect();
      const sliderRect = yrSlider.getBoundingClientRect();
      const W = Math.max(1, trackRect.width);
      const xToYear = d3.scaleLinear().domain([0, W]).range([YEAR_MIN, YEAR_MAX]);
      const yearToX = d3.scaleLinear().domain([YEAR_MIN, YEAR_MAX]).range([0, W]);
      const [px] = d3.pointer(event, yrTrack);
      const clampedPx = clamp(px, 0, W);
      // decide which thumb is nearer in pixel space
      const xL = yearToX(vL), xR = yearToX(vR);
      const dL = Math.abs(clampedPx - xL), dR = Math.abs(clampedPx - xR);
      const val = Math.round(xToYear(clampedPx));
      if (dL <= dR) {
        vL = clamp(val, YEAR_MIN, vR);
      } else {
        vR = clamp(val, vL, YEAR_MAX);
      }
      render();
    });

    render(false);
  }
})();
