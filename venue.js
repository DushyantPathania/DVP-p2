/* venue.js — venue window anchored near clicked venue
   API: VenueWindow.init({ svg, gRoot, projectionRef, modeRef })
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

  const F = {
    panelBg: getComputedStyle(document.documentElement).getPropertyValue("--panel-bg") || "rgba(6,29,22,0.95)",
    panelBorder: getComputedStyle(document.documentElement).getPropertyValue("--panel-border") || "rgba(255,255,255,0.15)",
    text: getComputedStyle(document.documentElement).getPropertyValue("--text") || "#e7f6ef",
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent") || "#24b47e",
    muted: getComputedStyle(document.documentElement).getPropertyValue("--muted") || "#bcd8cd",
  };

  function ensurePanel() {
    if (panel) return;

    panel = document.createElement("div");
    panel.id = "venue-window";
    Object.assign(panel.style, {
      position: "fixed",
      zIndex: String(Z_INDEX),
      left: "0px",
      top: "0px",
      width: "360px",
      maxWidth: "min(92vw, 420px)",
      minHeight: "200px",
      display: "none",
      background: F.panelBg,
      color: F.text,
      border: `1px solid ${F.panelBorder}`,
      borderRadius: "12px",
      boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
      pointerEvents: "auto",
      overflow: "hidden",
    });

    // Header
    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "10px 12px",
      borderBottom: `1px solid ${F.panelBorder}`,
      gap: "8px",
    });

    const left = document.createElement("div");
    Object.assign(left.style, { display: "flex", alignItems: "center", gap: "8px" });

    titleEl = document.createElement("h3");
    titleEl.className = "venue-title";
    titleEl.textContent = "Venue";
    Object.assign(titleEl.style, {
      margin: "0",
      fontSize: "16px",
      fontWeight: "700",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });

    yearBadgeEl = document.createElement("span");
    yearBadgeEl.textContent = "2000–2025";
    Object.assign(yearBadgeEl.style, {
      fontSize: "12px",
      padding: "2px 6px",
      color: F.text,
      border: `1px solid ${F.panelBorder}`,
      borderRadius: "999px",
      opacity: 0.85
    });

    left.appendChild(titleEl);
    left.appendChild(yearBadgeEl);

    const closeBtn = document.createElement("button");
    closeBtn.className = "venue-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    Object.assign(closeBtn.style, {
      border: `1px solid ${F.panelBorder}`,
      background: "transparent",
      color: F.text,
      borderRadius: "8px",
      lineHeight: "1",
      width: "28px",
      height: "28px",
      cursor: "pointer",
      fontSize: "18px",
    });
    closeBtn.addEventListener("click", close);

    header.appendChild(left);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Content
    const contentEl = document.createElement("div");
    Object.assign(contentEl.style, {
      padding: "10px 12px 12px",
      display: "grid",
      gridTemplateColumns: "1fr",
      gap: "10px",
      maxHeight: "60vh",
      overflow: "auto",
    });

    const radarWrap = document.createElement("div");
    radarWrap.innerHTML = `<svg width="280" height="170" data-role="radar"></svg>`;

    const heatWrap = document.createElement("div");
    heatWrap.textContent = "Heatmap (coming soon)";
    Object.assign(heatWrap.style, {
      display: "grid",
      placeItems: "center",
      height: "72px",
      border: "1px dashed rgba(255,255,255,0.18)",
      borderRadius: "10px",
      color: F.muted,
      fontSize: "0.9rem",
    });

    const legend = document.createElement("div");
    legend.innerHTML = `
      <div style="display:flex;gap:12px;align-items:center;font-size:0.92rem;">
        <span><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#e6cf9a;margin-right:6px;"></i>Test</span>
        <span><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#2dd4bf;margin-right:6px;"></i>ODI</span>
        <span><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#a78bfa;margin-right:6px;"></i>T20I</span>
      </div>
    `;

    const info = document.createElement("div");
    info.innerHTML = `
      <div style="display:grid;gap:6px;font-size:.95rem;">
        <div style="display:flex;justify-content:space-between;gap:12px;">
          <span style="color:${F.muted}">Country</span><span class="v-country">—</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:12px;">
          <span style="color:${F.muted}">City</span><span class="v-city">—</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:12px;">
          <span style="color:${F.muted}">Capacity</span><span class="v-capacity">—</span>
        </div>
      </div>
    `;

    contentEl.appendChild(radarWrap);
    contentEl.appendChild(heatWrap);
    contentEl.appendChild(legend);
    contentEl.appendChild(info);

    panel.appendChild(contentEl);
    document.body.appendChild(panel);

    // Keep open when interacting with the panel
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());

    // Outside click closes
    document.addEventListener("pointerdown", (e) => {
      if (!isOpenFlag) return;
      if (!panel.contains(e.target)) close();
    });

    // ESC closes
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

    // Listen to global year range and show it on the badge
    window.addEventListener("yearrange:change", (ev) => {
      const { min, max } = ev.detail || {};
      if (yearBadgeEl) yearBadgeEl.textContent = `${min}–${max}`;
    });
  }

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
        .attr("fill", F.muted)
        .text(a);
    });

    [0.25, 0.5, 0.75, 1].forEach(k => {
      g.append("circle").attr("r", r * k).attr("fill", "none").attr("stroke", "rgba(231,246,239,0.15)");
    });

    const vals = [0.6, 0.45, 0.7, 0.5, 0.8];
    const line = d3.lineRadial().curve(d3.curveLinearClosed).radius(d => d * r).angle((d, i) => (i / n) * 2 * Math.PI);
    g.append("path").datum(vals).attr("d", line).attr("fill", "rgba(36,180,126,0.25)").attr("stroke", F.accent);
  }

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

    const pad = 12;
    const w = Math.min(panel.offsetWidth || 360, window.innerWidth - 24);
    const h = Math.min(panel.offsetHeight || 240, window.innerHeight - 24);

    let left = x + pad;
    let top  = y - h / 2;

    if (left + w + 10 > window.innerWidth) left = x - w - pad;
    top = clamp(top, 10, window.innerHeight - h - 10);

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top  = `${Math.round(top)}px`;
  }

  /* ------------------ Public API ------------------ */
  function init({ svg, gRoot, projectionRef, modeRef }) {
    svgRef = svg; gRootRef = gRoot;
    getProjection = projectionRef;
    getMode = modeRef;
    ensurePanel();
  }

  function open(d) {
    ensurePanel();
    currentDatum = d;
    isOpenFlag = true;
    window.dispatchEvent(new CustomEvent("venuewindow:open"));

    titleEl.textContent = d.venue || "Venue";
    const radarSvg = panel.querySelector('svg[data-role="radar"]');
    if (radarSvg) drawRadarPlaceholder(radarSvg);

    panel.style.display = "block";
    placeAtDatum(d);
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
