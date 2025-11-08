/* venue.js — anchored venue window with radar placeholder (no inline CSS)
   API:
     VenueWindow.init({ svg, gRoot, projectionRef, modeRef })
     VenueWindow.open(d)
     VenueWindow.close()
     VenueWindow.reposition()
     VenueWindow.isOpen()
*/
(function () {
  const Z_INDEX = 20;

  let svgRef, gRootRef, getProjection, getMode;
  let panel, titleEl, yearBadgeEl;
  let isOpenFlag = false;
  let currentDatum = null;

  // --------- DOM building (no inline styles; classes only) ----------
  function ensurePanel() {
    if (panel) return;

    panel = document.createElement("div");
    panel.id = "venue-window";
    panel.className = "vw-panel";
    panel.style.display = "none"; // visibility managed here, not in CSS to avoid initial flash

    // Header
    const header = document.createElement("div");
    header.className = "vw-header";

    const left = document.createElement("div");
    left.className = "vw-left";

    titleEl = document.createElement("h3");
    titleEl.className = "vw-title";
    titleEl.textContent = "Venue";

    yearBadgeEl = document.createElement("span");
    yearBadgeEl.className = "vw-year";
    yearBadgeEl.textContent = "2000–2025";

    left.appendChild(titleEl);
    left.appendChild(yearBadgeEl);

    const closeBtn = document.createElement("button");
    closeBtn.className = "vw-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", close);

    header.appendChild(left);
    header.appendChild(closeBtn);

    // Content
    const contentEl = document.createElement("div");
    contentEl.className = "vw-content";

    // Radar placeholder
    const radarWrap = document.createElement("div");
    radarWrap.className = "vw-radar";
    radarWrap.innerHTML = `<svg class="vw-radar-svg" width="280" height="170" data-role="radar"></svg>`;

    // Heatmap placeholder
    const heatWrap = document.createElement("div");
    heatWrap.className = "vw-heat";
    heatWrap.textContent = "Heatmap (coming soon)";

    // Legend
    const legend = document.createElement("div");
    legend.className = "vw-legend";
    legend.innerHTML = `
      <div class="vw-legend-row">
        <span><i class="dot test"></i>Test</span>
        <span><i class="dot odi"></i>ODI</span>
        <span><i class="dot t20i"></i>T20I</span>
      </div>
    `;

    // Info
    const info = document.createElement("div");
    info.className = "vw-info";
    info.innerHTML = `
      <div class="row"><span class="k">Country</span><span class="v v-country">—</span></div>
      <div class="row"><span class="k">City</span><span class="v v-city">—</span></div>
      <div class="row"><span class="k">Also known as</span><span class="v v-aka">—</span></div>
    `;

    contentEl.appendChild(radarWrap);
    contentEl.appendChild(heatWrap);
    contentEl.appendChild(legend);
    contentEl.appendChild(info);

    panel.appendChild(header);
    panel.appendChild(contentEl);
    document.body.appendChild(panel);

    // Keep open when interacting with panel
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());

    // Outside click closes
    document.addEventListener("pointerdown", (e) => {
      if (!isOpenFlag) return;
      if (!panel.contains(e.target)) close();
    });

    // ESC closes
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

    // Update badge when year range changes
    window.addEventListener("yearrange:change", (ev) => {
      const { min, max } = ev.detail || {};
      if (yearBadgeEl) yearBadgeEl.textContent = `${min}–${max}`;
    });
  }

  // --------- Simple radar placeholder with D3 ----------
  function drawRadarPlaceholder(svgEl) {
    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    const w = +svg.attr("width") || 280;
    const h = +svg.attr("height") || 170;
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 16;
    const axes = ["Pace", "Spin", "Bounce", "Outfield", "Swing"];
    const n = axes.length;

    const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);

    axes.forEach((a, i) => {
      const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
      const x = Math.cos(angle) * r, y = Math.sin(angle) * r;
      g.append("line").attr("x1", 0).attr("y1", 0).attr("x2", x).attr("y2", y)
        .attr("stroke", "rgba(231,246,239,0.35)");
      g.append("text")
        .attr("x", Math.cos(angle) * (r + 6))
        .attr("y", Math.sin(angle) * (r + 6) + 4)
        .attr("text-anchor", Math.cos(angle) > 0.05 ? "start" : (Math.cos(angle) < -0.05 ? "end" : "middle"))
        .attr("font-size", 11)
        .attr("fill", "var(--muted)")
        .text(a);
    });

    [0.25, 0.5, 0.75, 1].forEach(k => {
      g.append("circle").attr("r", r * k).attr("fill", "none").attr("stroke", "rgba(231,246,239,0.15)");
    });

    const vals = [0.6, 0.45, 0.7, 0.5, 0.8];
    const line = d3.lineRadial()
      .curve(d3.curveLinearClosed)
      .radius(d => d * r)
      .angle((d, i) => (i / n) * 2 * Math.PI);

    g.append("path")
      .datum(vals)
      .attr("d", line)
      .attr("fill", "rgba(36,180,126,0.25)")
      .attr("stroke", "var(--accent)");
  }

  // --------- Positioning helpers ----------
  function screenPoint(lon, lat) {
    const proj = getProjection();
    let p = proj([+lon, +lat]);
    if (getMode() === "map") {
      const t = d3.zoomTransform(gRootRef.node());
      p = [p[0] * t.k + t.x, p[1] * t.k + t.y];
    }
    return p;
  }
  function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

  function placeAtDatum(d) {
    if (!panel) return;
    const [sx, sy] = screenPoint(d.longitude, d.latitude);
    const bbox = svgRef.node().getBoundingClientRect();
    const x = bbox.left + sx;
    const y = bbox.top + sy;

    // Make visible to measure
    panel.style.visibility = "hidden";
    panel.style.display = "block";
    const w = Math.min(panel.offsetWidth || 360, window.innerWidth - 24);
    const h = Math.min(panel.offsetHeight || 240, window.innerHeight - 24);

    const pad = 12;
    let left = x + pad;
    let top  = y - h / 2;
    if (left + w + 10 > window.innerWidth) left = x - w - pad;
    top = clamp(top, 10, window.innerHeight - h - 10);

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top  = `${Math.round(top)}px`;
    panel.style.visibility = "visible";
  }

  // --------- Public API ----------
  function init({ svg, gRoot, projectionRef, modeRef }) {
    svgRef = svg; gRootRef = gRoot;
    getProjection = projectionRef;
    getMode = modeRef;
    ensurePanel();
    if (window.yearRange && yearBadgeEl) {
      yearBadgeEl.textContent = `${window.yearRange.min}–${window.yearRange.max}`;
    }
  }

  function open(d) {
    ensurePanel();
    currentDatum = d;

    // Fill header + info
    titleEl.textContent = d.venue || "Venue";
    const countryEl = panel.querySelector(".v-country");
    const cityEl    = panel.querySelector(".v-city");
    const akaEl     = panel.querySelector(".v-aka");
    if (countryEl) countryEl.textContent = d.country ?? "—";
    if (cityEl)    cityEl.textContent    = d.city ?? "—";
    if (akaEl)     akaEl.textContent     = d.names ?? "—";

    // Radar
    const radarSvg = panel.querySelector('svg[data-role="radar"]');
    drawRadarPlaceholder(radarSvg);

    // Show + position + notify
    isOpenFlag = true;
    panel.style.display = "block";
    placeAtDatum(d);
    window.dispatchEvent(new CustomEvent("venuewindow:open", { detail: { venue: d } }));
  }

  function close() {
    if (!panel) return;
    isOpenFlag = false;
    currentDatum = null;
    panel.style.display = "none";
    window.dispatchEvent(new CustomEvent("venuewindow:close"));
  }

  function reposition() {
    if (!isOpenFlag || !currentDatum) return;
    placeAtDatum(currentDatum);
  }

  window.VenueWindow = { init, open, close, reposition, isOpen: () => isOpenFlag };
})();
