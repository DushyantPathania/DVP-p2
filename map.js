// Cricket-themed globe<->map with D3 SVG toggle + 89% overlay leaderboard
// + Venue markers loaded from CSV (venue, longitude, latitude)
// Icon path assumed: data/icon/CricketStadium.png
(async function () {
  // ---- Config your data paths here ----
  const VENUES_CSV = "data/csvs/venues.csv";              // change filename if needed
  const ICON_PATH  = "data/icon/CricketStadium.png";      // note the slash (folder/file)

  // ---- DOM refs
  const container = document.getElementById("globe");
  const btnMenu   = document.getElementById("menuBtn");
  const overlay   = document.getElementById("leaderboardOverlay");
  const backdrop  = document.getElementById("backdrop");
  const btnClose  = document.getElementById("closeOverlay");
  const tabPanel  = document.getElementById("tabpanel");
  const tabBtns   = [document.getElementById("tab-batting"), document.getElementById("tab-bowling")];

  // ---- SVG + layers
  const svg = d3.select(container).append("svg");
  const gRoot = svg.append("g");          // geography lives here
  const gSphere = gRoot.append("g");
  const gGraticule = gRoot.append("g");
  const gCountries = gRoot.append("g");
  const gBoundary = gRoot.append("g");
  const gVenues = gRoot.append("g").attr("class", "venues"); // markers on top of geography

  // UI layer (not zoom/panned)
  const gUI = svg.append("g").attr("class", "ui-layer");

  const graticule = d3.geoGraticule10();
  const globeProj = d3.geoOrthographic().precision(0.6).clipAngle(90);
  const mapProj   = d3.geoNaturalEarth1().precision(0.6);
  let projection  = globeProj;
  let path        = d3.geoPath(projection);

  // ---- State
  let mode = "globe";     // "globe" | "map"
  let baseScale = 1;      // for globe scale
  let isDragging = false;
  let prev = null;
  const dragSens = 0.25;

  // smooth spin
  const spinDegPerSec = 3;
  const spinDegPerMs  = spinDegPerSec / 1000;
  let spinTimer = null;
  let lastElapsed = null;

  // zoom (globe)
  let globeZoomK = 1;

  // hover
  let hoveredId = null;

  // venues data
  let venues = [];  // [{venue, lon, lat}]

  // ---- Demo leaderboard data (replace with real)
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

  // ---- Map data
  const worldData = await d3.json("https://unpkg.com/world-atlas@2/countries-110m.json");
  const countries = topojson.feature(worldData, worldData.objects.countries).features;
  const boundaryMesh = topojson.mesh(worldData, worldData.objects.countries, (a, b) => a !== b);

  // Try to load venues CSV (it may not exist yet)
  try {
    const raw = await d3.csv(VENUES_CSV);
    venues = raw
      .map(d => ({
        venue: d.venue?.trim() ?? "",
        lon: +d.longitude,
        lat: +d.latitude
      }))
      .filter(d => isFinite(d.lon) && isFinite(d.lat));
  } catch (e) {
    console.warn("Venues CSV not found yet (this is fine until you add it):", VENUES_CSV);
  }

  // ---------- Geography drawing ----------
  function drawStaticLayers() {
    gSphere.selectAll("path.sphere")
      .data([{ type: "Sphere" }])
      .join("path")
      .attr("class", "sphere")
      .attr("d", path);

    gGraticule.selectAll("path.graticule")
      .data([graticule])
      .join("path")
      .attr("class", "graticule")
      .attr("d", path);
  }

  function drawCountries() {
    gCountries.selectAll("path.country")
      .data(countries, d => d.id)
      .join("path")
      .attr("class", "country")
      .on("mouseenter", (event, d) => { hoveredId = d.id; d3.select(event.currentTarget).raise(); updateHoverTransform(); })
      .on("mouseleave", () => { hoveredId = null; updateHoverTransform(); })
      .attr("d", path);

    gBoundary.selectAll("path.boundary")
      .data([boundaryMesh])
      .join("path")
      .attr("class", "boundary")
      .attr("d", path);

    updateHoverTransform();
  }

  // ---------- Venues ----------
  // Base icon size in pixels at globe zoom k = 1
  const ICON_BASE = 22;

  function drawVenues() {
    if (!venues.length) return;

    const sel = gVenues.selectAll("image.venue-icon")
      .data(venues, d => d.venue || `${d.lon},${d.lat}`);

    sel.enter()
      .append("image")
      .attr("class", "venue-icon")
      .attr("href", ICON_PATH)
      .attr("width", ICON_BASE)
      .attr("height", ICON_BASE)
      .attr("opacity", 0.95)
      .append("title").text(d => d.venue);

    sel.exit().remove();

    updateVenues();
  }

  function updateVenues() {
    if (!venues.length) return;

    gVenues.selectAll("image.venue-icon")
      .each(function (d) {
        const p = projection([d.lon, d.lat]); // [x, y]
        if (!p) return;
        let size = ICON_BASE;

        if (mode === "globe") {
          // keep icon size proportional to globe zoom
          size = ICON_BASE * globeZoomK;
          // hide if on the back hemisphere
          const r = projection.rotate(); // [λ, φ, γ]
          const visible = d3.geoDistance([d.lon, d.lat], [-r[0], -r[1]]) <= Math.PI / 2;
          d3.select(this).style("display", visible ? "block" : "none");
        } else {
          // map mode: icons scale with zoom (because gRoot is transformed)
          d3.select(this).style("display", "block");
        }

        d3.select(this)
          .attr("width", size)
          .attr("height", size)
          .attr("x", p[0] - size / 2)
          .attr("y", p[1] - size / 2);
      });
  }

  // call this after any redraw/resize/zoom/rotate
  function redrawAll() {
    gRoot.selectAll("path").attr("d", path);
    updateHoverTransform();
    updateVenues();
  }

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

  // ---------- Smooth spin ----------
  function startSpin() {
    stopSpin();
    lastElapsed = null;
    spinTimer = d3.timer((elapsed) => {
      if (mode !== "globe" || isDragging) { lastElapsed = elapsed; return; }
      if (lastElapsed == null) lastElapsed = elapsed;
      const dt = elapsed - lastElapsed; lastElapsed = elapsed;
      const r = projection.rotate(); r[0] += spinDegPerMs * dt; projection.rotate(r);
      redrawAll();
    });
  }
  function stopSpin() { if (spinTimer) { spinTimer.stop(); spinTimer = null; } }

  // ---------- Behaviors ----------
  const dragGlobe = d3.drag()
    .on("start", (event) => { isDragging = true; stopSpin(); prev = [event.x, event.y]; })
    .on("drag",  (event) => {
      if (!prev) prev = [event.x, event.y];
      const dx = event.x - prev[0], dy = event.y - prev[1];
      const r = projection.rotate();
      const lambda = r[0] + dx * dragSens;
      const phi    = clamp(r[1] - dy * dragSens, -90, 90);
      projection.rotate([lambda, phi, r[2]]);
      prev = [event.x, event.y]; redrawAll();
    })
    .on("end",   () => { isDragging = false; prev = null; startSpin(); });

  const zoomGlobe = d3.zoom()
    .scaleExtent([0.7, 8])
    .filter((event) => event.type === "wheel" || event.type === "touchstart")
    .on("zoom", (event) => {
      globeZoomK = event.transform.k;
      projection.scale(baseScale * globeZoomK);
      redrawAll();
    });

  const zoomMap = d3.zoom()
    .scaleExtent([1, 8])
    .on("zoom", (event) => {
      gRoot.attr("transform", event.transform);
      // icons move automatically with gRoot; nothing else to do
    });

  // ---------- D3 SVG toggle (3D <-> 2D) ----------
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

  function knobX() { return mode === "globe" ?  TOGGLE.h/2 : TOGGLE.w - TOGGLE.h/2; }
  function positionToggle() { ui.attr("transform", `translate(${TOGGLE.m}, ${TOGGLE.m})`); }
  function updateToggleUI(animate=true) {
    ui.attr("aria-checked", mode === "map" ? "true" : "false");
    label3d.style("fill", mode === "globe" ? "var(--text)" : "var(--muted)");
    label2d.style("fill", mode === "map"   ? "var(--text)" : "var(--muted)");
    (animate ? knob.transition().duration(160) : knob).attr("cx", knobX());
  }

  ["mousedown","touchstart","wheel"].forEach(ev =>
    ui.on(ev, (event) => event.stopPropagation(), true)
  );
  ui.on("click", () => setMode(mode === "globe" ? "map" : "globe"));
  ui.on("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") { event.preventDefault(); setMode(mode === "globe" ? "map" : "globe"); }
  });

  // ---------- Mode switch ----------
  function setMode(newMode) {
    if (newMode === mode) return;
    mode = newMode; gRoot.attr("transform", null);

    if (mode === "map") {
      stopSpin();
      gRoot.on(".drag", null);
      svg.on(".zoom", null).call(zoomMap).call(zoomMap.transform, d3.zoomIdentity);
      projection = mapProj; path.projection(projection);
      resize(); redrawAll();
    } else {
      globeZoomK = 1;
      svg.on(".zoom", null).call(zoomGlobe).call(zoomGlobe.transform, d3.zoomIdentity);
      gRoot.call(dragGlobe);
      projection = globeProj; path.projection(projection);
      resize(); redrawAll(); startSpin();
    }
    updateToggleUI(true);
  }

  // ---------- Resize ----------
  function resize() {
    const width  = window.innerWidth, height = window.innerHeight;
    svg.attr("width", width).attr("height", height);

    if (mode === "globe") {
      const size = Math.min(width, height);
      baseScale = (size / 2) * 0.95;
      projection.translate([width / 2, height / 2]).scale(baseScale * globeZoomK).clipAngle(90);
    } else {
      const margin = 20;
      projection.fitExtent([[margin, margin], [width - margin, height - margin]], { type: "Sphere" });
    }
    positionToggle();
    redrawAll();
  }
  window.addEventListener("resize", resize);

  // ---------- Reset (dblclick) ----------
  svg.on("dblclick", () => {
    if (mode === "globe") {
      projection.rotate([0, 0, 0]);
      globeZoomK = 1;
      svg.transition().duration(500).call(zoomGlobe.transform, d3.zoomIdentity).on("end", redrawAll);
    } else {
      svg.transition().duration(400).call(zoomMap.transform, d3.zoomIdentity).on("end", () => gRoot.attr("transform", null));
    }
  });

  // ---------- Overlay logic (leaderboard) ----------
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
      <p id="lbMeta" class="lb-meta">Demo data — replace in <code>map.js</code> (battingData/bowlingData).</p>
    `;
  }

  // ---------- Init
  resize();
  // geography
  drawStaticLayers();
  drawCountries();
  // venues (if CSV exists)
  drawVenues();

  // interactions
  gRoot.call(dragGlobe);
  svg.call(zoomGlobe).call(zoomGlobe.transform, d3.zoomIdentity);

  // UI toggle
  positionToggle(); updateToggleUI(false);

  // spin
  startSpin();

  // Utils
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
})();
