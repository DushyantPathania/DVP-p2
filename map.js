/* ============================================================================
   Cricket-themed Globe <-> Map (D3 v7)
   - Venues from SQLite (sql.js) via db.js (works from file://)
   - Smooth globe spin; pauses when a venue/country is focused or venue window is open
   - NEW: Custom dual year slider (2000–2025) — fully custom thumbs & pointer logic
   - Drag to rotate (3D), wheel/touch zoom; hover highlight/pop for countries
   - D3-drawn toggle (3D globe <-> 2D map); 89% overlay leaderboard
   ============================================================================ */

(async function () {
  /* ----------------------------- Config ----------------------------------- */
  const DB_URL    = "https://cdn.jsdelivr.net/gh/DushyantPathania/DVP-p2@main/data/db/cricket.db";
  const ICON_PATH = "data/icon/CricketStadium.png";
  const ICON_BASE = 14;
  const SPIN_DEG_PER_SEC = 3;

  /* ------------------------------ DOM ------------------------------------- */
  const container = document.getElementById("globe");
  const btnMenu   = document.getElementById("menuBtn");
  const overlay   = document.getElementById("leaderboardOverlay");
  const backdrop  = document.getElementById("backdrop");
  const btnClose  = document.getElementById("closeOverlay");
  const tabPanel  = document.getElementById("tabpanel");
  const tabBtns   = [document.getElementById("tab-batting"), document.getElementById("tab-bowling")];

  /* Slider root (custom) */
  const sliderRoot = document.getElementById("yearSlider");

  /* --------------------------- SVG & Layers -------------------------------- */
  const svg = d3.select(container).append("svg");
  const gRoot      = svg.append("g");
  const gSphere    = gRoot.append("g");
  const gGraticule = gRoot.append("g");
  const gCountries = gRoot.append("g");
  const gBoundary  = gRoot.append("g");
  const gVenues    = gRoot.append("g").attr("class", "venues");
  const gUI        = svg.append("g").attr("class", "ui-layer");

  /* -------------------------- Projections/Path ----------------------------- */
  const graticule = d3.geoGraticule10();
  const globeProj = d3.geoOrthographic().precision(0.6).clipAngle(90);
  const mapProj   = d3.geoNaturalEarth1().precision(0.6);

  let projection = globeProj;
  let path       = d3.geoPath(projection);

  /* ----------------------------- State ------------------------------------ */
  let mode        = "globe";
  let baseScale   = 1;
  let globeZoomK  = 1;
  let isDragging  = false;
  let prev        = null;
  const dragSens  = 0.25;

  // Spin
  const spinDegPerMs = SPIN_DEG_PER_SEC / 1000;
  let spinTimer   = null;
  let lastElapsed = null;

  // Hover/focus
  let hoveredId         = null;
  let focusedCountryId  = null;

  // Venues
  let venues = [];

  // Year range (global)
  let yearRange = { min: 2000, max: 2025 };

  /* ------------------------ Demo Leaderboard Data -------------------------- */
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
  const worldData    = await d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json");
  const countries    = topojson.feature(worldData, worldData.objects.countries).features;
  const boundaryMesh = topojson.mesh(worldData, worldData.objects.countries, (a, b) => a !== b);

  /* ---------------------------- Geography ---------------------------------- */
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
      .on("click", (event, d) => {
        event.stopPropagation();
        focusedCountryId = (focusedCountryId === d.id) ? null : d.id;
        if (VenueWindow.isOpen && VenueWindow.isOpen()) VenueWindow.close();
        updateHoverTransform();
        updateSpinState();
      })
      .attr("d", path);

    gBoundary.selectAll("path.boundary")
      .data([boundaryMesh])
      .join("path")
      .attr("class", "boundary")
      .attr("d", path);
  }

  /* ----------------------------- Venues (DB) ------------------------------- */
  async function loadVenuesFromDB() {
    await DB.init(DB_URL);
    venues = await DB.getVenues();
  }

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

    enter.append("title").text(d => [d.venue, d.city, d.country].filter(Boolean).join(", "));
    sel.exit().remove();

    gVenues.selectAll("image.venue-icon")
      .on("click", (event, d) => {
        event.stopPropagation();
        focusedCountryId = null;
        VenueWindow.open(d);
        updateHoverTransform();
        updateSpinState();
      });

    updateVenues();
  }

  function updateVenues() {
    if (!venues.length) return;

    gVenues.selectAll("image.venue-icon").each(function (d) {
      const lon = +d.longitude, lat = +d.latitude;
      const p   = projection([lon, lat]);
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

  /* ----------------------- Custom Year Slider (from scratch) --------------- */
  const YearSlider = (() => {
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

    function create({ root, min = 2000, max = 2025, step = 1, onChange }) {
      if (!root) return null;
      const wrap   = root.querySelector(".slider-wrap");
      const track  = wrap.querySelector(".track");
      const rangeH = wrap.querySelector(".range-highlight");
      const tMin   = wrap.querySelector(".thumb.min");
      const tMax   = wrap.querySelector(".thumb.max");
      const tipMin = wrap.querySelector(".thumb-tip.min");
      const tipMax = wrap.querySelector(".thumb-tip.max");
      const ticksC = wrap.querySelector(".ticks");
      const labMin = root.querySelector("#yearMinLabel");
      const labMax = root.querySelector("#yearMaxLabel");

      // Build ticks (every 5 years)
      if (ticksC && !ticksC.hasChildNodes()) {
        for (let y = min; y <= max; y += 5) {
          const tick = document.createElement("div");
          tick.className = "tick";
          const pct = ((y - min) / (max - min)) * 100;
          tick.style.left = `${pct}%`;
          const label = document.createElement("label");
          label.textContent = y;
          tick.appendChild(label);
          ticksC.appendChild(tick);
        }
      }

      let vMin = min, vMax = max;           // current values
      let active = null;                     // 'min' | 'max' | null
      let rect = wrap.getBoundingClientRect();

      function valueToPct(val) { return ((val - min) / (max - min)) * 100; }
      function pctToValue(pct) {
        const v = min + (pct / 100) * (max - min);
        return Math.round(v / step) * step;
      }
      function xToValue(clientX) {
        rect = wrap.getBoundingClientRect();
        const pct = clamp(((clientX - rect.left) / rect.width) * 100, 0, 100);
        return pctToValue(pct);
      }

      function layout() {
        // positions
        const lp = valueToPct(vMin);
        const rp = valueToPct(vMax);
        tMin.style.left = `${lp}%`;
        tMax.style.left = `${rp}%`;
        tipMin.style.left = `${lp}%`;
        tipMax.style.left = `${rp}%`;
        rangeH.style.left = `${lp}%`;
        rangeH.style.width = `${rp - lp}%`;

        // labels + aria
        labMin.textContent = `${vMin}`;
        labMax.textContent = `${vMax}`;
        tMin.setAttribute("aria-valuemin", String(min));
        tMin.setAttribute("aria-valuemax", String(max));
        tMax.setAttribute("aria-valuemin", String(min));
        tMax.setAttribute("aria-valuemax", String(max));
        tMin.setAttribute("aria-valuenow", String(vMin));
        tMax.setAttribute("aria-valuenow", String(vMax));

        tipMin.textContent = `${vMin}`;
        tipMax.textContent = `${vMax}`;
      }

      function emit() {
        onChange && onChange({ min: vMin, max: vMax });
      }

      function setValues(a, b, cause = "program") {
        // keep invariant a <= b, and if crossing while dragging, swap active thumb
        if (a > b) { [a, b] = [b, a]; if (active === "min") active = "max"; else if (active === "max") active = "min"; }
        vMin = clamp(a, min, max);
        vMax = clamp(b, min, max);
        layout();
        emit();
      }

      // Decide which thumb is closer to an X
      function nearestThumbByX(clientX) {
        const val = xToValue(clientX);
        const dMin = Math.abs(val - vMin);
        const dMax = Math.abs(val - vMax);
        return (dMin <= dMax) ? "min" : "max";
      }

      // Pointer handlers
      function startDrag(which, clientX) {
        active = which;
        wrap.setPointerCapture && wrap.setPointerCapture((event?.pointerId) ?? 1);
        // immediately update on press at current pointer
        const v = xToValue(clientX);
        if (active === "min") setValues(v, vMax, "drag-start");
        else setValues(vMin, v, "drag-start");
      }
      function moveDrag(clientX) {
        if (!active) return;
        const v = xToValue(clientX);
        if (active === "min") setValues(v, vMax, "drag");
        else setValues(vMin, v, "drag");
      }
      function endDrag() { active = null; }

      // Events
      const onPointerDown = (e) => {
        e.stopPropagation(); // don't rotate globe
        const target = e.target;
        if (target === tMin) { startDrag("min", e.clientX); return; }
        if (target === tMax) { startDrag("max", e.clientX); return; }
        // clicked on track: choose nearest thumb, jump & drag
        const which = nearestThumbByX(e.clientX);
        startDrag(which, e.clientX);
      };
      const onPointerMove = (e) => { if (active) moveDrag(e.clientX); };
      const onPointerUp   = (e) => { endDrag(); };

      wrap.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);

      // Keyboard support
      function keyStep(e, which) {
        const big = 5; // page up/down = 5 years
        if (which === "min") {
          if (e.key === "ArrowLeft") setValues(vMin - step, vMax, "key");
          if (e.key === "ArrowRight") setValues(vMin + step, vMax, "key");
          if (e.key === "PageDown") setValues(vMin - big, vMax, "key");
          if (e.key === "PageUp")   setValues(vMin + big, vMax, "key");
          if (e.key === "Home")     setValues(min, vMax, "key");
          if (e.key === "End")      setValues(vMax, vMax, "key");
        } else {
          if (e.key === "ArrowLeft") setValues(vMin, vMax - step, "key");
          if (e.key === "ArrowRight") setValues(vMin, vMax + step, "key");
          if (e.key === "PageDown") setValues(vMin, vMax - big, "key");
          if (e.key === "PageUp")   setValues(vMin, vMax + big, "key");
          if (e.key === "Home")     setValues(vMin, vMin, "key");
          if (e.key === "End")      setValues(vMin, max, "key");
        }
      }
      tMin.addEventListener("keydown", (e) => keyStep(e, "min"));
      tMax.addEventListener("keydown", (e) => keyStep(e, "max"));

      // Keep geometry fresh
      window.addEventListener("resize", () => { rect = wrap.getBoundingClientRect(); layout(); });

      // Init
      setValues(vMin, vMax, "init");
      return {
        get values() { return { min: vMin, max: vMax }; },
        set values({ min: a, max: b }) { setValues(a, b, "program"); }
      };
    }

    return { create };
  })();

  /* ---------------------------- Redraw Cycle -------------------------------- */
  function redrawAll() {
    gRoot.selectAll("path").attr("d", path);
    updateHoverTransform();
    updateVenues();
    VenueWindow.reposition && VenueWindow.reposition();
    updateSpinState();
  }

  function updateHoverTransform() {
    gCountries.selectAll("path.country").each(function (d) {
      const sel = d3.select(this);
      const active = (hoveredId && d.id === hoveredId) || (focusedCountryId && d.id === focusedCountryId);
      if (active) {
        const [cx, cy] = path.centroid(d);
        sel.classed("hovered", true)
           .style("transform", `translate(${cx}px, ${cy}px) scale(1.025) translate(${-cx}px, ${-cy}px)`);
      } else {
        sel.classed("hovered", false).style("transform", null);
      }
    });
  }

  /* ------------------------------ Spin ------------------------------------- */
  function startSpin() {
    if (mode !== "globe" || spinTimer) return;
    lastElapsed = null;
    spinTimer = d3.timer((elapsed) => {
      if (mode !== "globe" || isDragging) { lastElapsed = elapsed; return; }
      if (lastElapsed == null) lastElapsed = elapsed;
      const dt = elapsed - lastElapsed; lastElapsed = elapsed;
      const r = projection.rotate();
      r[0] += spinDegPerMs * dt;
      projection.rotate(r);
      gRoot.selectAll("path").attr("d", path);
      updateVenues();
      VenueWindow.reposition && VenueWindow.reposition();
    });
  }
  function stopSpin() { if (spinTimer) { spinTimer.stop(); spinTimer = null; } }
  function updateSpinState() {
    if (mode !== "globe") { stopSpin(); return; }
    const venueOpen = VenueWindow.isOpen && VenueWindow.isOpen();
    const somethingFocused = venueOpen || focusedCountryId !== null || isDragging;
    if (somethingFocused) stopSpin(); else startSpin();
  }

  /* --------------------------- Interactions -------------------------------- */
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
    .on("end",   () => { isDragging = false; prev = null; updateSpinState(); });

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
      VenueWindow.reposition && VenueWindow.reposition();
    });

  // Clear focus on background click
  svg.on("pointerdown.clearFocus", (e) => {
    const t = e.target;
    const inside = t && (t.closest(".venues") || t.closest("path.country"));
    if (inside) return;
    focusedCountryId = null;
    if (VenueWindow.isOpen && VenueWindow.isOpen()) VenueWindow.close();
    updateHoverTransform();
    updateSpinState();
  });

  window.addEventListener("venuewindow:open",  updateSpinState);
  window.addEventListener("venuewindow:close", updateSpinState);

  /* ----------------------------- Mode Toggle -------------------------------- */
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
    gRoot.attr("transform", null);

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
      resize(); redrawAll();
    }

    updateToggleUI(true);
    updateSpinState();
  }

  /* ------------------------------- Resize ---------------------------------- */
  function resize() {
    const width  = window.innerWidth;
    const height = window.innerHeight;

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

  /* ------------------------------- Reset ----------------------------------- */
  svg.on("dblclick", () => {
    if (mode === "globe") {
      projection.rotate([0, 0, 0]);
      globeZoomK = 1;
      svg.transition().duration(500).call(zoomGlobe.transform, d3.zoomIdentity).on("end", redrawAll);
    } else {
      svg.transition().duration(400).call(zoomMap.transform, d3.zoomIdentity).on("end", () => gRoot.attr("transform", null));
    }
  });

  /* --------------------------- Overlay (Leaderboard) ----------------------- */
  function openOverlay() {
    overlay.hidden = false; backdrop.hidden = false;
    overlay.classList.add("open"); backdrop.classList.add("open"); btnMenu.classList.add("open");
    btnMenu.setAttribute("aria-expanded", "true");
    overlay.setAttribute("aria-hidden", "false");
    tabPanel.focus();
  }
  function closeOverlay() {
    overlay.classList.remove("open"); backdrop.classList.remove("open"); btnMenu.classList.remove("open");
    btnMenu.setAttribute("aria-expanded", "false");
    overlay.setAttribute("aria-hidden", "true");
    setTimeout(() => { overlay.hidden = true; backdrop.hidden = true; }, 180);
  }
  function toggleOverlay() { if (overlay.hidden) openOverlay(); else closeOverlay(); }
  btnMenu.addEventListener("click", toggleOverlay);
  btnClose.addEventListener("click", closeOverlay);
  backdrop.addEventListener("click", closeOverlay);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeOverlay(); });

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
  // Venue window available globally from venue.js
  VenueWindow.init({ svg, gRoot, projectionRef: () => projection, modeRef: () => mode });

  // Create the year slider
  const slider = YearSlider.create({
    root: sliderRoot,
    min: 2000,
    max: 2025,
    step: 1,
    onChange: ({ min, max }) => {
      yearRange = { min, max };
      window.dispatchEvent(new CustomEvent("yearrange:change", { detail: yearRange }));
      redrawAll();
    }
  });

  // Map & data
  resize();
  drawStaticLayers();
  drawCountries();
  await loadVenuesFromDB();
  if (venues.length) drawVenues();

  // interactions start in globe mode
  gRoot.call(dragGlobe);
  svg.call(zoomGlobe).call(zoomGlobe.transform, d3.zoomIdentity);

  // UI toggle + spin
  positionToggle();
  updateToggleUI(false);
  updateSpinState();

  /* ------------------------------ Utils ------------------------------------ */
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
})();
