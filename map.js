/* ============================================================================
   Cricket-themed Globe <-> Map (D3 v7)
   - Venues loaded from SQLite (sql.js) via db.js (works from file://)
   - Smooth globe spin, drag, zoom; hover highlight/pop for countries
   - D3-drawn toggle (3D globe <-> 2D map)
   - 89% overlay leaderboard (hamburger button)
   - Admin-1 (state/province) borders appear at higher zoom levels
   - Minimal dependencies in HTML:
       <script src="https://d3js.org/d3.v7.min.js"></script>
       <script src="https://unpkg.com/topojson-client@3"></script>
       <script src="https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js"></script>
       <script src="db.js"></script>
       <script src="map.js"></script>
   ============================================================================ */

(async function () {
  /* ----------------------------- Config ----------------------------------- */

  // SQLite DB hosted via jsDelivr (CORS ok). Update if you pin to a commit.
  const DB_URL = "https://cdn.jsdelivr.net/gh/DushyantPathania/DVP-p2@main/data/db/cricket.db";

  // Stadium icon (relative to index.html)
  const ICON_PATH  = "data/icon/CricketStadium.png";

  // Icon base size (px) at globe zoom k = 1
  const ICON_BASE = 22;

  // Globe spin speed (deg/sec)
  const SPIN_DEG_PER_SEC = 3;

  // Zoom thresholds for revealing admin-1 borders
  const ADMIN_SHOW_ZOOM_GLOBE = 1.6;  // globe zoom k >= this shows state borders
  const ADMIN_SHOW_ZOOM_MAP   = 2.2;  // map   zoom k >= this shows state borders

  /* ------------------------------ DOM ------------------------------------- */

  const container = document.getElementById("globe");
  const btnMenu   = document.getElementById("menuBtn");
  const overlay   = document.getElementById("leaderboardOverlay");
  const backdrop  = document.getElementById("backdrop");
  const btnClose  = document.getElementById("closeOverlay");
  const tabPanel  = document.getElementById("tabpanel");
  const tabBtns   = [document.getElementById("tab-batting"), document.getElementById("tab-bowling")];

  /* --------------------------- SVG & Layers -------------------------------- */

  const svg = d3.select(container).append("svg");

  // Geography inside gRoot (so 2D mode can pan/zoom entire group)
  const gRoot      = svg.append("g");
  const gSphere    = gRoot.append("g");
  const gGraticule = gRoot.append("g");
  const gCountries = gRoot.append("g");
  const gBoundary  = gRoot.append("g");
  const gAdmin1    = gRoot.append("g").attr("class", "admin1"); // state/province borders
  const gVenues    = gRoot.append("g").attr("class", "venues"); // stadium icons

  // Fixed-position UI layer (not transformed by zoom/pan)
  const gUI = svg.append("g").attr("class", "ui-layer");

  /* -------------------------- Projections/Path ----------------------------- */

  const graticule = d3.geoGraticule10();

  // 3D globe projection (orthographic)
  const globeProj = d3.geoOrthographic().precision(0.6).clipAngle(90);

  // 2D map projection (Natural Earth)
  const mapProj   = d3.geoNaturalEarth1().precision(0.6);

  // Active projection + path generator
  let projection = globeProj;
  let path       = d3.geoPath(projection);

  /* ----------------------------- State ------------------------------------ */

  let mode        = "globe";   // "globe" | "map"
  let baseScale   = 1;         // base globe radius (px)
  let globeZoomK  = 1;         // current globe zoom factor
  let mapZoomK    = 1;         // current 2D zoom factor
  let isDragging  = false;
  let prev        = null;      // last drag [x, y]
  const dragSens  = 0.25;

  // Spin timer
  const spinDegPerMs = SPIN_DEG_PER_SEC / 1000;
  let spinTimer   = null;
  let lastElapsed = null;

  // Hovered country id (to apply the pop transform)
  let hoveredId   = null;

  // Venues from DB: [{venue, longitude, latitude}]
  let venues      = [];

  /* ------------------------ Demo Leaderboard Data -------------------------- */
  // Replace with DB-driven data later if you want.
  const battingData = [
    { player: "Player A", team: "IND", runs: 945, sr: 142.3, avg: 52.5 },
    { player: "Player B", team: "AUS", runs: 903, sr: 136.4, avg: 48.2 },
    { player: "Player C", team: "ENG", runs: 881, sr: 131.9, avg: 45.1 },
    { player: "Player D", team: "SA",  runs: 865, sr: 145.2, avg: 47.8 },
    { player: "Player E", team: "PAK", runs: 842, sr: 128.6, avg: 43.0 },
    { player: "Player F", team: "NZ",  runs: 831, sr: 139.0, avg: 44.5 },
    { player: "Player G", team: "SL",  runs: 820, sr: 125.4, avg: 42.1 },
    { player: "Player H", team: "BAN", runs: 792, sr: 129.7, avg: 39.8 },
    { player: "Player I", team: "AFG", runs: 774, sr: 134.2, avg: 41.3 },
    { player: "Player J", team: "WI",  runs: 761, sr: 147.1, avg: 40.2 },
  ];
  const bowlingData = [
    { player: "Bowler A", team: "IND", wkts: 41, eco: 6.1, avg: 21.4 },
    { player: "Bowler B", team: "AUS", wkts: 39, eco: 5.6, avg: 22.9 },
    { player: "Bowler C", team: "ENG", wkts: 37, eco: 6.4, avg: 24.1 },
    { player: "Bowler D", team: "SA",  wkts: 36, eco: 5.8, avg: 23.6 },
    { player: "Bowler E", team: "PAK", wkts: 34, eco: 6.0, avg: 24.9 },
    { player: "Bowler F", team: "NZ",  wkts: 33, eco: 5.5, avg: 25.4 },
    { player: "Bowler G", team: "SL",  wkts: 31, eco: 6.2, avg: 26.8 },
    { player: "Bowler H", team: "BAN", wkts: 29, eco: 5.9, avg: 27.1 },
    { player: "Bowler I", team: "AFG", wkts: 27, eco: 6.3, avg: 28.6 },
    { player: "Bowler J", team: "WI",  wkts: 26, eco: 6.1, avg: 29.2 },
  ];

  /* ----------------------------- World Data -------------------------------- */

  // Countries + boundaries (TopoJSON -> GeoJSON)
  const worldData    = await d3.json("https://unpkg.com/world-atlas@2/countries-110m.json");
  const countries    = topojson.feature(worldData, worldData.objects.countries).features;
  const boundaryMesh = topojson.mesh(worldData, worldData.objects.countries, (a, b) => a !== b);

  // Admin-1 (state/province) mesh (10m for detail). Some regions may be sparse.
  const statesData   = await d3.json("https://unpkg.com/world-atlas@2/states-10m.json");
  const adminMesh    = topojson.mesh(statesData, statesData.objects.states, (a, b) => a !== b);

  /* ---------------------------- Geography ---------------------------------- */

  function drawStaticLayers() {
    // Ocean sphere
    gSphere.selectAll("path.sphere")
      .data([{ type: "Sphere" }])
      .join("path")
      .attr("class", "sphere")
      .attr("d", path);

    // Graticule (lat/long grid)
    gGraticule.selectAll("path.graticule")
      .data([graticule])
      .join("path")
      .attr("class", "graticule")
      .attr("d", path);
  }

  function drawCountries() {
    // Country polygons (with hover interactions)
    gCountries.selectAll("path.country")
      .data(countries, d => d.id)
      .join("path")
      .attr("class", "country")
      .on("mouseenter", (event, d) => {
        hoveredId = d.id;
        d3.select(event.currentTarget).raise();
        updateHoverTransform();
      })
      .on("mouseleave", () => {
        hoveredId = null;
        updateHoverTransform();
      })
      .attr("d", path);

    // Country boundaries (thin strokes between countries)
    gBoundary.selectAll("path.boundary")
      .data([boundaryMesh])
      .join("path")
      .attr("class", "boundary")
      .attr("d", path);
  }

  // Admin-1 borders as a single mesh path (fast)
  function drawAdminBoundaries() {
    gAdmin1.selectAll("path.admin1")
      .data([adminMesh])
      .join("path")
      .attr("class", "admin1")
      .attr("d", path)
      .attr("fill", "none")
      .attr("stroke", "rgba(255,255,255,0.22)")
      .attr("stroke-width", 0.6)
      .attr("vector-effect", "non-scaling-stroke")
      .attr("pointer-events", "none");
  }

  /* ----------------------------- Venues (DB) ------------------------------- */

  // Load venues from SQLite (via db.js). Expected table: venues(venue, longitude, latitude)
  async function loadVenuesFromDB() {
    await DB.init(DB_URL);           // opens cricket.db using sql.js
    venues = await DB.getVenues();   // [{ venue, longitude, latitude }]
  }

  // Create <image> markers once; then position on projection updates
  function drawVenues() {
    if (!venues.length) return;

    const sel = gVenues.selectAll("image.venue-icon")
      .data(venues, d => d.venue || `${d.longitude},${d.latitude}`);

    const enter = sel.enter()
      .append("image")
      .attr("class", "venue-icon")
      .attr("href", ICON_PATH)
      .attr("width", ICON_BASE)
      .attr("height", ICON_BASE)
      .attr("opacity", 0.95);

    enter.append("title").text(d => d.venue);

    sel.exit().remove();

    updateVenues();
  }

  // Position icons using current projection & zoom; hide on back hemisphere in globe mode
  function updateVenues() {
    if (!venues.length) return;

    gVenues.selectAll("image.venue-icon").each(function (d) {
      const lon = +d.longitude, lat = +d.latitude;
      const p   = projection([lon, lat]); // [x, y]
      if (!p) return;

      const size = (mode === "globe") ? ICON_BASE * globeZoomK : ICON_BASE;

      if (mode === "globe") {
        const r = projection.rotate();
        const visible = d3.geoDistance([lon, lat], [-r[0], -r[1]]) <= Math.PI / 2;
        d3.select(this).style("display", visible ? "block" : "none");
      } else {
        d3.select(this).style("display", "block");
      }

      d3.select(this)
        .attr("width", size)
        .attr("height", size)
        .attr("x", p[0] - size / 2)
        .attr("y", p[1] - size / 2);
    });
  }

  /* ---------------------------- Redraw Cycle -------------------------------- */

  // Recompute all paths, apply hover “pop”, update venues & admin-1 visibility
  function redrawAll() {
    gRoot.selectAll("path").attr("d", path);
    updateHoverTransform();
    updateVenues();
    updateDetailVisibility();
  }

  // Subtle hover “pop” on countries using CSS transform around centroid
  function updateHoverTransform() {
    gCountries.selectAll("path.country").each(function (d) {
      const sel = d3.select(this);
      if (hoveredId && d.id === hoveredId) {
        const [cx, cy] = path.centroid(d);
        sel.classed("hovered", true)
           .style("transform", `translate(${cx}px, ${cy}px) scale(1.025) translate(${-cx}px, ${-cy}px)`);
      } else {
        sel.classed("hovered", false).style("transform", null);
      }
    });
  }

  // Show/hide admin-1 borders depending on zoom & mode
  function updateDetailVisibility() {
    const show = (mode === "map")
      ? (mapZoomK   >= ADMIN_SHOW_ZOOM_MAP)
      : (globeZoomK >= ADMIN_SHOW_ZOOM_GLOBE);
    gAdmin1.style("opacity", show ? 1 : 0);
  }

  /* ------------------------------ Spin ------------------------------------- */

  function startSpin() {
    stopSpin();
    lastElapsed = null;
    spinTimer = d3.timer((elapsed) => {
      if (mode !== "globe" || isDragging) { lastElapsed = elapsed; return; }
      if (lastElapsed == null) lastElapsed = elapsed;
      const dt = elapsed - lastElapsed; lastElapsed = elapsed;
      const r = projection.rotate();
      r[0] += spinDegPerMs * dt;         // spin around vertical axis
      projection.rotate(r);
      redrawAll();
    });
  }

  function stopSpin() {
    if (spinTimer) { spinTimer.stop(); spinTimer = null; }
  }

  /* --------------------------- Interactions -------------------------------- */

  // Drag globe to rotate (3D)
  const dragGlobe = d3.drag()
    .on("start", (event) => { isDragging = true; stopSpin(); prev = [event.x, event.y]; })
    .on("drag",  (event) => {
      if (!prev) prev = [event.x, event.y];
      const dx = event.x - prev[0], dy = event.y - prev[1];
      const r = projection.rotate();
      const lambda = r[0] + dx * dragSens;
      const phi    = clamp(r[1] - dy * dragSens, -90, 90);
      projection.rotate([lambda, phi, r[2]]);
      prev = [event.x, event.y];
      redrawAll();
    })
    .on("end",   () => { isDragging = false; prev = null; startSpin(); });

  // Zoom: globe (scale radius) vs map (transform group)
  const zoomGlobe = d3.zoom()
    .scaleExtent([0.7, 8])
    .filter((event) => event.type === "wheel" || event.type === "touchstart")
    .on("zoom", (event) => {
      globeZoomK = event.transform.k;
      projection.scale(baseScale * globeZoomK);
      redrawAll();
      updateDetailVisibility();
    });

  const zoomMap = d3.zoom()
    .scaleExtent([1, 8])
    .on("zoom", (event) => {
      mapZoomK = event.transform.k;
      gRoot.attr("transform", event.transform);  // pan/zoom whole geography
      updateDetailVisibility();
      // paths don't need recomputing in 2D; the group transform handles it
    });

  /* ----------------------------- Mode Toggle --------------------------------
     D3-drawn switch (top-left): click/Enter/Space toggles 3D <-> 2D.
  --------------------------------------------------------------------------- */

  const TOGGLE = { w: 120, h: 36, r: 18, m: 16 };
  const ui = gUI.append("g")
    .attr("class", "mode-toggle")
    .attr("role", "switch")
    .attr("tabindex", 0)
    .attr("aria-checked", "false")
    .style("cursor", "pointer");

  ui.append("rect")
    .attr("rx", TOGGLE.r).attr("ry", TOGGLE.r)
    .attr("width", TOGGLE.w).attr("height", TOGGLE.h)
    .style("fill", "#134e4a")
    .style("stroke", "rgba(255,255,255,0.2)")
    .style("stroke-width", 1.2);

  const label3d = ui.append("text")
    .attr("x", 22).attr("y", TOGGLE.h/2 + 4)
    .attr("text-anchor", "start")
    .style("font", "600 12px system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif")
    .style("fill", "var(--text)")
    .text("3D");

  const label2d = ui.append("text")
    .attr("x", TOGGLE.w - 22).attr("y", TOGGLE.h/2 + 4)
    .attr("text-anchor", "end")
    .style("font", "600 12px system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif")
    .style("fill", "var(--muted)")
    .text("2D");

  const knob = ui.append("circle")
    .attr("cy", TOGGLE.h/2)
    .attr("r", TOGGLE.h/2 - 4)
    .style("fill", "var(--text)");

  function knobX() { return mode === "globe" ? TOGGLE.h/2 : TOGGLE.w - TOGGLE.h/2; }
  function positionToggle() { ui.attr("transform", `translate(${TOGGLE.m}, ${TOGGLE.m})`); }
  function updateToggleUI(animate = true) {
    ui.attr("aria-checked", mode === "map" ? "true" : "false");
    label3d.style("fill", mode === "globe" ? "var(--text)" : "var(--muted)");
    label2d.style("fill", mode === "map"   ? "var(--text)" : "var(--muted)");
    (animate ? knob.transition().duration(160) : knob).attr("cx", knobX());
  }

  // Prevent interactions from leaking to the globe when toggling
  ["mousedown","touchstart","wheel"].forEach(ev =>
    ui.on(ev, (event) => event.stopPropagation(), true)
  );
  ui.on("click", () => setMode(mode === "globe" ? "map" : "globe"));
  ui.on("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      setMode(mode === "globe" ? "map" : "globe");
    }
  });

  function setMode(newMode) {
    if (newMode === mode) return;
    mode = newMode;
    gRoot.attr("transform", null); // clear any 2D transform

    if (mode === "map") {
      stopSpin();
      gRoot.on(".drag", null);
      svg.on(".zoom", null).call(zoomMap).call(zoomMap.transform, d3.zoomIdentity);
      mapZoomK = 1;
      projection = mapProj; path.projection(projection);
      resize(); redrawAll();
    } else {
      globeZoomK = 1;
      svg.on(".zoom", null).call(zoomGlobe).call(zoomGlobe.transform, d3.zoomIdentity);
      gRoot.call(dragGlobe);
      projection = globeProj; path.projection(projection);
      resize(); redrawAll();
      startSpin();
    }

    updateToggleUI(true);
    updateDetailVisibility();
  }

  /* ------------------------------- Resize ---------------------------------- */

  function resize() {
    const width  = window.innerWidth;
    const height = window.innerHeight;

    svg.attr("width", width).attr("height", height);

    if (mode === "globe") {
      // Fit a near-fullscreen globe
      const size = Math.min(width, height);
      baseScale = (size / 2) * 0.95;
      projection
        .translate([width / 2, height / 2])
        .scale(baseScale * globeZoomK)
        .clipAngle(90);
    } else {
      // Fit the 2D map nicely within the viewport
      const margin = 20;
      projection.fitExtent([[margin, margin], [width - margin, height - margin]], { type: "Sphere" });
    }

    positionToggle();
    redrawAll();
    updateDetailVisibility();
  }
  window.addEventListener("resize", resize);

  /* ------------------------------- Reset ----------------------------------- */

  // Double-click to reset view (center + zoom=1)
  svg.on("dblclick", () => {
    if (mode === "globe") {
      projection.rotate([0, 0, 0]);
      globeZoomK = 1;
      svg.transition().duration(500)
        .call(zoomGlobe.transform, d3.zoomIdentity)
        .on("end", redrawAll);
    } else {
      svg.transition().duration(400)
        .call(zoomMap.transform, d3.zoomIdentity)
        .on("end", () => gRoot.attr("transform", null));
      mapZoomK = 1;
    }
    updateDetailVisibility();
  });

  /* --------------------------- Overlay (Leaderboard) ----------------------- */

  function openOverlay() {
    overlay.hidden = false; backdrop.hidden = false;
    overlay.classList.add("open"); backdrop.classList.add("open"); btnMenu.classList.add("open");
    btnMenu.setAttribute("aria-expanded", "true");
    overlay.setAttribute("aria-hidden", "false");
    if (mode === "globe") stopSpin();
    setActiveTab("batting");
    tabPanel.focus();
  }

  function closeOverlay() {
    overlay.classList.remove("open"); backdrop.classList.remove("open"); btnMenu.classList.remove("open");
    btnMenu.setAttribute("aria-expanded", "false");
    overlay.setAttribute("aria-hidden", "true");
    setTimeout(() => { overlay.hidden = true; backdrop.hidden = true; }, 180);
    if (mode === "globe") startSpin();
  }

  function toggleOverlay() { if (overlay.hidden) openOverlay(); else closeOverlay(); }

  btnMenu.addEventListener("click", toggleOverlay);
  btnClose.addEventListener("click", closeOverlay);
  backdrop.addEventListener("click", closeOverlay);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeOverlay(); });

  // Tabs
  tabBtns.forEach(btn => btn.addEventListener("click", () => setActiveTab(btn.dataset.kind)));

  function setActiveTab(kind) {
    tabBtns.forEach(b => {
      const on = b.dataset.kind === kind;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    renderLeaderboard(kind);
  }

  function renderLeaderboard(kind = "batting") {
    const rows = (kind === "batting" ? battingData : bowlingData)
      .slice()
      .sort((a, b) => (kind === "batting" ? d3.descending(a.runs, b.runs) : d3.descending(a.wkts, b.wkts)));

    const head = (kind === "batting")
      ? `<tr><th>#</th><th>Player</th><th>Team</th><th>Runs</th><th>SR</th><th>Avg</th></tr>`
      : `<tr><th>#</th><th>Player</th><th>Team</th><th>Wkts</th><th>Eco</th><th>Avg</th></tr>`;

    const body = rows.map((r, i) => (kind === "batting")
      ? `<tr><td>${i+1}</td><td>${r.player}</td><td>${r.team}</td><td>${r.runs}</td><td>${r.sr}</td><td>${r.avg}</td></tr>`
      : `<tr><td>${i+1}</td><td>${r.player}</td><td>${r.team}</td><td>${r.wkts}</td><td>${r.eco}</td><td>${r.avg}</td></tr>`
    ).join("");

    tabPanel.innerHTML = `
      <table class="lb-table" aria-describedby="lbMeta">
        <thead>${head}</thead>
        <tbody>${body}</tbody>
      </table>
      <p id="lbMeta" class="lb-meta">Demo data — replace in <code>map.js</code> if needed.</p>
    `;
  }

  /* ------------------------------- Init ------------------------------------ */

  resize();               // 1) size SVG
  drawStaticLayers();     // 2) sphere + graticule
  drawCountries();        // 3) country polygons + borders
  drawAdminBoundaries();  // 4) admin-1 mesh (hidden until zoom threshold)
  updateDetailVisibility();

  await loadVenuesFromDB(); // 5) fetch venues from SQLite DB
  if (venues.length) drawVenues();

  // 6) interactions (start in globe mode)
  gRoot.call(dragGlobe);
  svg.call(zoomGlobe).call(zoomGlobe.transform, d3.zoomIdentity);

  // 7) UI toggle + spin
  positionToggle();
  updateToggleUI(false);
  startSpin();

  /* ------------------------------ Utils ------------------------------------ */

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
})();
