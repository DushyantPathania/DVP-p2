/* ============================================================================
   Cricket Globe / Map (D3 v7)
   - Choropleth: home win % by host country (from SQLite on GitHub)
   - Spikes: number of matches hosted (height) & home-win% (color)
   - Slider drives re-query (year range)
   - 2D / 3D modes share the same layers
   - No CSV reads anywhere
   ============================================================================ */

(async function () {
  /* ----------------------------- Config ----------------------------------- */
  // Remote SQLite DB on GitHub (sql.js fetch)
  const DB_URL = "https://raw.githubusercontent.com/DushyantPathania/DVP-p2/main/data/db/cricket.db";

  const ICON_PATH  = "data/icon/CricketStadium.png";
  const ICON_BASE  = 16;
  const SPIN_DEG_PER_SEC = 3;

  /* ------------------------------ DOM ------------------------------------- */
  const container   = document.getElementById("globe");
  const btnMenu     = document.getElementById("menuBtn");
  const overlay     = document.getElementById("leaderboardOverlay");
  const backdrop    = document.getElementById("backdrop");
  const btnClose    = document.getElementById("closeOverlay");
  const tabPanel    = document.getElementById("tabpanel");
  const tabBtns     = [document.getElementById("tab-batting"), document.getElementById("tab-bowling")];
  const spikeLegend = document.getElementById("spikeLegend");

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

  // Venue popup (existing)
  VenueWindow.init({
    svg, gRoot,
    projectionRef: () => projection,
    modeRef: () => mode
  });

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

  // Year range
  const YEAR_MIN = 2000, YEAR_MAX = 2025;
  let yearRange  = { min: YEAR_MIN, max: YEAR_MAX };

  // Choropleth + spikes
  let choroActive     = false;
  let choroByCountry  = new Map(); // key -> {matches, homeWins, winPct}
  let spikeScale      = d3.scaleSqrt().domain([0,1]).range([0, 30]);
  const colorScale    = d3.scaleLinear().domain([0, 0.5, 1]).range(["#e64a19", "#f7e082", "#2e7d32"]);

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
      .on("mouseenter", (event, d) => { hoveredId = d.id; d3.select(event.currentTarget).raise(); updateHoverTransform(); })
      .on("mouseleave", () => { hoveredId = null; updateHoverTransform(); })
      .on("click", (event, d) => handleCountryClick(d))
      .attr("d", path);

    gBoundary.selectAll("path.boundary")
      .data([boundaryMesh]).join("path").attr("class","boundary").attr("d", path);

    applyCountryHighlight();
    applyChoropleth(); // if data loaded
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

  /* ------------------------- Schema Introspection -------------------------- */
  let schemaCache = null;
  async function getVenueSchema() {
    if (schemaCache) return schemaCache;
    await DB.init(DB_URL);

    // Sanity logs — confirm remote DB is used (no hard-coded table names)
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
      .on("click", (event, d) => {
        event.stopPropagation();
        stopSpin();
        VenueWindow.open(d);
      });

    enter.append("title").text(d => d.venue || d.name || "Venue");

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

  // Discover “matches-like” tables by synonyms and return mappings
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
        out.push({ name: n, cols, map: { winnerCol, dateCol, hostCol, neutralCol, resultCol } });
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
        // Build a union across all matches-like tables with standardized aliases
        const unionParts = tables.map(t => {
          const m = t.map;
          const neutralExpr = m.neutralCol ? `COALESCE(${m.neutralCol},0)` : "0";
          const resultExpr  = m.resultCol  ? `COALESCE(${m.resultCol},'')`  : "''";
          return `
            SELECT
              ${m.winnerCol} AS winner,
              ${m.hostCol}   AS venue_country,
              ${m.dateCol}   AS date,
              ${neutralExpr} AS neutral_venue,
              ${resultExpr}  AS result_type
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

    // Aggregate -> {matches, homeWins, winPct}
    const agg = new Map();
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

      const b = agg.get(hostKey) || { matches:0, homeWins:0 };
      b.matches += 1; if (win) b.homeWins += 1;
      agg.set(hostKey, b);
    }
    agg.forEach(v => v.winPct = v.matches ? v.homeWins / v.matches : 0);

    choroByCountry = agg;
    choroActive = agg.size > 0;

    const maxMatches = d3.max(Array.from(agg.values()), d => d.matches) || 1;
    spikeScale.domain([0, maxMatches]).range([0, mode==="globe" ? 32 : 40]);

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
        return rec ? colorScale(rec.winPct) : null;
      })
      .selectAll("title").remove();

    gCountries.selectAll("path.country").append("title")
      .text(d => {
        const key = canonicalMapName(d.properties?.name || "");
        const rec = choroByCountry.get(key);
        if (!rec) return d.properties?.name || "";
        const pct = Math.round(rec.winPct*100);
        return `${d.properties?.name}: Home wins ${pct}% (${rec.homeWins}/${rec.matches})`;
      });
  }

  function drawSpikes(){
    const data = [];
    countries.forEach(f => {
      const key = canonicalMapName(f.properties?.name || "");
      const rec = choroByCountry.get(key);
      if (!rec || !rec.matches) return;
      const c = d3.geoCentroid(f);
      if (!c || !isFinite(c[0]) || !isFinite(c[1])) return;
      data.push({ key, lon:c[0], lat:c[1], matches:rec.matches, winPct:rec.winPct });
    });

    const sel = gSpikes.selectAll("line.spike").data(data, d => d.key);
    sel.exit().remove();
    sel.enter().append("line").attr("class","spike")
      .merge(sel)
      .attr("stroke", d => colorScale(d.winPct))
      .attr("opacity", 0.95);

    updateSpikesPosition();
  }

  function updateSpikesPosition(){
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
    const scale = d3.scaleSqrt().domain([0, maxMatches]).range([0, 34]);
    const ticks = scale.ticks(3);
    svgL.append("line").attr("x1", cx).attr("y1", baseY).attr("x2", cx).attr("y2", baseY - scale(maxMatches))
      .attr("stroke", "#fff").attr("stroke-width", 2).attr("opacity", 0.8);
    ticks.forEach(t => {
      const y = baseY - scale(t);
      svgL.append("line").attr("x1", cx-6).attr("y1", y).attr("x2", cx+6).attr("y2", y).attr("stroke", "#fff").attr("opacity",0.6);
      svgL.append("text").attr("x", cx+12).attr("y", y+3).attr("fill","#fff").attr("font-size", 11).text(t);
    });
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
    .filter((event) => event.type === "wheel" || event.type === "touchstart")
    .on("zoom", (event) => { globeZoomK = event.transform.k; projection.scale(baseScale * globeZoomK); redrawAll(); });

  const zoomMap = d3.zoom()
    .scaleExtent([1, 12])
    .on("zoom", (event) => { mapZoomK = event.transform.k; gRoot.attr("transform", event.transform); });

  /* ----------------------------- Mode Toggle ------------------------------- */
  const tiltInputEl = document.querySelector('.tilt-toggle__input');

  function updateToggleUI(animate=true){
    if (!tiltInputEl) return;
    const shouldBeChecked = (mode === "map");
    if (tiltInputEl.checked !== shouldBeChecked) tiltInputEl.checked = shouldBeChecked;
    tiltInputEl.setAttribute('aria-checked', shouldBeChecked ? 'true' : 'false');
    const lbl = tiltInputEl.closest && tiltInputEl.closest('.tilt-toggle');
    if (lbl) {
      if (animate) lbl.classList.remove('tilt-toggle--pristine');
      lbl.classList.toggle('is-checked', shouldBeChecked);
      lbl.setAttribute('title', shouldBeChecked ? (lbl.dataset.nameMap || 'Map') : (lbl.dataset.nameGlobe || 'Globe'));
    }
    if (window.syncTiltToggleLabel) window.syncTiltToggleLabel();
  }

  if (tiltInputEl) {
    tiltInputEl.addEventListener('change', (e) => {
      const nm = e.target.checked ? 'map' : 'globe';
      setMode(nm);
    });
    ["pointerdown","mousedown","touchstart","wheel"].forEach(ev =>
      tiltInputEl.addEventListener(ev, e => e.stopPropagation(), { passive: true })
    );
  }

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
    // spike range tweak per mode
    const maxMatches = d3.max(Array.from(choroByCountry.values()||[]), d => d.matches) || 1;
    spikeScale.range([0, mode==="globe" ? 32 : 40]);
    updateSpikesPosition();
  }

  /* ------------------------------- Resize ---------------------------------- */
  function resize(){
    const width = window.innerWidth, height = window.innerHeight;
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

  /* --------------------------- Overlay (Leaderboard) ----------------------- */
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

  tabBtns.forEach(btn => btn.addEventListener("click", () => setActiveTab(btn.dataset.kind)));
  function setActiveTab(kind){
    tabBtns.forEach(b => { const on=b.dataset.kind===kind; b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true":"false"); });
    renderLeaderboard(kind);
  }
  function renderLeaderboard(kind="batting"){
    const rows = (kind==="batting" ? battingData : bowlingData).slice()
      .sort((a,b) => (kind==="batting" ? d3.descending(a.runs,b.runs) : d3.descending(a.wkts,b.wkts)));
    const head = (kind==="batting")
      ? `<tr><th>#</th><th>Player</th><th>Team</th><th>Runs</th><th>SR</th><th>Avg</th></tr>`
      : `<tr><th>#</th><th>Player</th><th>Team</th><th>Wkts</th><th>Eco</th><th>Avg</th></tr>`;
    const body = rows.map((r,i)=> (kind==="batting")
      ? `<tr><td>${i+1}</td><td>${r.player}</td><td>${r.team}</td><td>${r.runs}</td><td>${r.sr}</td><td>${r.avg}</td></tr>`
      : `<tr><td>${i+1}</td><td>${r.player}</td><td>${r.team}</td><td>${r.wkts}</td><td>${r.eco}</td><td>${r.avg}</td></tr>`).join("");
    tabPanel.innerHTML = `<table class="lb-table" aria-describedby="lbMeta"><thead>${head}</thead><tbody>${body}</tbody></table>
    <p id="lbMeta" class="lb-meta">Demo data — replace in <code>map.js</code> if needed.</p>`;
  }

  /* ----------------------- Country Focus & Venue Load ---------------------- */
  async function handleCountryClick(feature){
    const name = canonicalMapName(feature.properties?.name || "");
    if (!name) return;
    countryFocused = true; stopSpin();
    toast(`Loading venues for ${feature.properties?.name || "country"}…`);
    if (mode === "globe") await focusGlobeOn(feature); else await focusMapOn(feature);
    try {
      const rows = await loadVenuesForCountry(name);
      addVenues(rows); drawVenues();
    } catch(e){ console.warn("Failed loading venues for", name, e); }
    finally { toastHide(); }
  }
  async function focusGlobeOn(feature){
    const c = d3.geoCentroid(feature);
    const r0 = projection.rotate(); const r1 = [-c[0], -c[1], r0[2]];
    const s0 = globeZoomK; const s1 = Math.max(1.3, Math.min(2.2, s0*1.5));
    await new Promise(res => {
      d3.transition().duration(900).tween("rotate", () => {
        const ir = d3.interpolate(r0, r1); const iz = d3.interpolate(s0, s1);
        return t => { projection.rotate(ir(t)); globeZoomK = iz(t); projection.scale(baseScale*globeZoomK); redrawAll(); if (t===1) res(); };
      });
    });
  }
  async function focusMapOn(feature){
    const width = +svg.attr("width"), height = +svg.attr("height");
    const b = path.bounds(feature), dx = b[1][0]-b[0][0], dy = b[1][1]-b[0][1];
    const x = (b[0][0]+b[1][0])/2, y = (b[0][1]+b[1][1])/2;
    const m = 0.85, s = Math.max(1, Math.min(12, m/Math.max(dx/width, dy/height)));
    const tx = width/2 - s*x, ty = height/2 - s*y;
    await new Promise(res => { svg.transition().duration(800).call(zoomMap.transform, d3.zoomIdentity.translate(tx,ty).scale(s)).on("end", res); });
  }

  /* ------------------------------ DB Helpers ------------------------------- */
  async function loadVenueCountries(){
    const { countryCol, iso3, iso2 } = await getVenueSchema();
    if (countryCol) {
      const rows = await DB.queryAll(`SELECT DISTINCT ${countryCol} AS val FROM venues WHERE ${countryCol} IS NOT NULL AND TRIM(${countryCol}) <> ''`);
      return new Set(rows.map(r => canonicalMapName(r.val)));
    } else {
      const iso3Map = new Map(Object.entries({ AUS:"australia", IND:"india", PAK:"pakistan", NZL:"new zealand", ZAF:"south africa", LKA:"sri lanka", BGD:"bangladesh", AFG:"afghanistan", GBR:"united kingdom", ARE:"united arab emirates" }));
      const iso2Map = new Map(Object.entries({ AU:"australia", IN:"india", PK:"pakistan", NZ:"new zealand", ZA:"south africa", LK:"sri lanka", BD:"bangladesh", AF:"afghanistan", GB:"united kingdom", AE:"united arab emirates" }));
      const set = new Set();
      if (iso3) {
        const rows = await DB.queryAll(`SELECT DISTINCT ${iso3} AS val FROM venues WHERE ${iso3} IS NOT NULL AND TRIM(${iso3}) <> ''`);
        rows.forEach(r => { const c = iso3Map.get(String(r.val).toUpperCase()); if (c) set.add(c); });
      } else if (iso2) {
        const rows = await DB.queryAll(`SELECT DISTINCT ${iso2} AS val FROM venues WHERE ${iso2} IS NOT NULL AND TRIM(${iso2}) <> ''`);
        rows.forEach(r => { const c = iso2Map.get(String(r.val).toUpperCase()); if (c) set.add(c); });
      }
      return set;
    }
  }
  async function loadVenuesForCountry(canonName){
    const { countryCol, iso3, iso2, lonCol, latCol } = await getVenueSchema();
    let whereSql = ""; let params = [];
    if (countryCol) {
      const candidates = [canonName];
      if (canonName === "united kingdom") candidates.push("england");
      if (canonName === "united arab emirates") candidates.push("uae");
      whereSql = `LOWER(${countryCol}) IN (${candidates.map(()=>"?").join(",")})`;
      params = candidates.map(s => s.toLowerCase());
    } else if (iso3 || iso2) {
      const nameToIso3 = new Map(Object.entries({ "australia":"AUS","india":"IND","pakistan":"PAK","new zealand":"NZL","south africa":"ZAF","sri lanka":"LKA","bangladesh":"BGD","afghanistan":"AFG","united kingdom":"GBR","united arab emirates":"ARE" }));
      const nameToIso2 = new Map(Object.entries({ "australia":"AU","india":"IN","pakistan":"PK","new zealand":"NZ","south africa":"ZA","sri lanka":"LK","bangladesh":"BD","afghanistan":"AF","united kingdom":"GB","united arab emirates":"AE" }));
      if (iso3 && nameToIso3.get(canonName)) { whereSql = `UPPER(${iso3}) = ?`; params=[nameToIso3.get(canonName)]; }
      else if (iso2 && nameToIso2.get(canonName)) { whereSql = `UPPER(${iso2}) = ?`; params=[nameToIso2.get(canonName)]; }
      else whereSql = "1=0";
    } else { whereSql = "1=0"; }

    const rows = await DB.queryAll(`SELECT * FROM venues WHERE ${whereSql}`, params);
    return rows.map(r => {
      const out = { ...r };
      out.longitude = pickCoord(r, [lonCol, "longitude","lon","lng","long","x"]);
      out.latitude  = pickCoord(r, [latCol, "latitude","lat","y"]);
      return out;
    }).filter(r => isFinite(+r.longitude) && isFinite(+r.latitude));
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

  // pause/resume spin on popup
  window.addEventListener("venuewindow:open",  () => stopSpin());
  window.addEventListener("venuewindow:close", () => { if (mode==="globe" && !countryFocused) startSpin(); });

  // stop map gestures when using the slider
  ["pointerdown","mousedown","touchstart","wheel"].forEach(ev =>
    yearBox?.addEventListener(ev, e => e.stopPropagation(), { passive: true })
  );

  // slider init & wiring
  initYearBox(false);
  window.addEventListener("yearrange:change", async (ev) => {
    const { min, max } = ev.detail || {};
    console.info("[SLIDER] range:", min, max);
    await computeChoropleth(min, max);
  });

  // initial choropleth + spikes
  await computeChoropleth(yearRange.min, yearRange.max);

  /* ------------------------- Utilities: slider ------------------------------ */
  function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }

  function initYearBox(recomputeOnly){
    if (!yearBox || !yrSlider || !yrTrack || !yrThumbL || !yrThumbR) return;

    const trackRect = yrTrack.getBoundingClientRect();
    const W = trackRect.width;

    const xToYear = d3.scaleLinear().domain([0, W]).range([YEAR_MIN, YEAR_MAX]);
    const yearToX = d3.scaleLinear().domain([YEAR_MIN, YEAR_MAX]).range([0, W]);

    let vL = yearRange?.min ?? YEAR_MIN;
    let vR = yearRange?.max ?? YEAR_MAX;

    const sliderRect = yrSlider.getBoundingClientRect();
    const trackLeftInSlider = trackRect.left - sliderRect.left;

    function render(emit=true){
      if (vL > vR) [vL, vR] = [vR, vL];
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
      .on("start", () => yearBox.classList.add("dragging"))
      .on("drag", (event) => {
        const [px] = d3.pointer(event, yrTrack);
        const x = clamp(px, 0, yearToX(vR));
        vL = Math.round(xToYear(x));
        render();
      })
      .on("end", () => yearBox.classList.remove("dragging"));

    const dragRight = d3.drag()
      .on("start", () => yearBox.classList.add("dragging"))
      .on("drag", (event) => {
        const [px] = d3.pointer(event, yrTrack);
        const x = clamp(px, yearToX(vL), W);
        vR = Math.round(xToYear(x));
        render();
      })
      .on("end", () => yearBox.classList.remove("dragging"));

    d3.select(yrThumbL).call(dragLeft);
    d3.select(yrThumbR).call(dragRight);

    d3.select(yrTrack).on("mousedown touchstart", (event) => {
      const [px] = d3.pointer(event, yrTrack);
      const val = Math.round(xToYear(clamp(px, 0, W)));
      const dL = Math.abs(val - vL);
      const dR = Math.abs(val - vR);
      if (dL <= dR) vL = Math.min(val, vR); else vR = Math.max(val, vL);
      render();
    });

    render(false);
  }
})();
