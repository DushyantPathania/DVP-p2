/* VenueWindow: lightweight anchored popup with radar placeholder */
(function () {
  let svgRef, gRootRef, getProjection, getMode;
  let panel, titleEl, badgeEl, contentEl;
  let isOpen = false;
  let currentDatum = null;

  function ensurePanel(){
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "venue-window";

    // header
    const header = document.createElement("div");
    header.className = "venue-header";

    const left = document.createElement("div");
    left.style.display = "flex";
    left.style.alignItems = "center";
    left.style.gap = "8px";

    titleEl = document.createElement("h3");
    titleEl.className = "venue-title";
    titleEl.textContent = "Venue";

    badgeEl = document.createElement("span");
    badgeEl.className = "venue-badge";
    badgeEl.textContent = "2000–2025";

    left.appendChild(titleEl);
    left.appendChild(badgeEl);

    const closeBtn = document.createElement("button");
    closeBtn.className = "venue-close";
    closeBtn.setAttribute("aria-label","Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", close);

    header.appendChild(left);
    header.appendChild(closeBtn);

    // content
    contentEl = document.createElement("div");
    contentEl.className = "venue-content";

    const radarWrap = document.createElement("div");
    radarWrap.innerHTML = `<svg width="280" height="170" data-role="radar"></svg>`;

    const heatWrap = document.createElement("div");
    heatWrap.className = "venue-card";
    heatWrap.textContent = "Heatmap (coming soon)";

    const legend = document.createElement("div");
    legend.className = "venue-card";
    legend.style.minHeight = "48px";
    legend.innerHTML = `
      <div style="display:flex;gap:12px;align-items:center;font-size:0.92rem;color:var(--text)">
        <span><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#e6cf9a;margin-right:6px;"></i>Test</span>
        <span><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#2dd4bf;margin-right:6px;"></i>ODI</span>
        <span><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#a78bfa;margin-right:6px;"></i>T20I</span>
      </div>
    `;

    const info = document.createElement("div");
    info.className = "venue-card";
    info.style.display = "block";
    info.style.padding = "8px 10px";
    info.style.color = "var(--text)";
    info.innerHTML = `
      <div style="display:grid;gap:6px;font-size:.95rem;">
        <div style="display:flex;justify-content:space-between;gap:12px;">
          <span style="color:var(--muted)">Country</span><span class="v-country">—</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:12px;">
          <span style="color:var(--muted)">City</span><span class="v-city">—</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:12px;">
          <span style="color:var(--muted)">Also known as</span><span class="v-aka">—</span>
        </div>
      </div>
    `;

    contentEl.appendChild(radarWrap);
    contentEl.appendChild(heatWrap);
    contentEl.appendChild(legend);
    contentEl.appendChild(info);

    panel.appendChild(header);
    panel.appendChild(contentEl);
    document.body.appendChild(panel);

    // keep open on its own clicks
    panel.addEventListener("pointerdown", e => e.stopPropagation());
    // outside click closes
    document.addEventListener("pointerdown", (e) => { if (isOpen && !panel.contains(e.target)) close(); });
    // ESC closes
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    // year badge updates
    window.addEventListener("yearrange:change", (ev) => {
      const { min, max } = ev.detail || {};
      badgeEl.textContent = `${min}–${max}`;
    });
  }

  function screenPoint(lon, lat){
    const proj = getProjection();
    let p = proj([+lon, +lat]);
    if (getMode() === "map") {
      const t = d3.zoomTransform(gRootRef.node());
      p = [p[0] * t.k + t.x, p[1] * t.k + t.y];
    }
    return p;
  }
  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

  function placeAtDatum(d){
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

  function drawRadar(svgEl){
    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    const w = +svg.attr("width") || 280;
    const h = +svg.attr("height") || 170;
    const cx = w/2, cy = h/2, r = Math.min(w, h)/2 - 16;
    const axes = ["Pace", "Spin", "Bounce", "Outfield", "Swing"];
    const n = axes.length;

    const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);

    axes.forEach((a, i) => {
      const ang = (i / n) * 2 * Math.PI - Math.PI/2;
      const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
      g.append("line").attr("x1",0).attr("y1",0).attr("x2",x).attr("y2",y)
        .attr("stroke","rgba(231,246,239,0.35)");
      g.append("text")
        .attr("x", Math.cos(ang) * (r + 6))
        .attr("y", Math.sin(ang) * (r + 6) + 4)
        .attr("text-anchor", Math.cos(ang) > 0.05 ? "start" : (Math.cos(ang) < -0.05 ? "end" : "middle"))
        .attr("font-size", 11)
        .attr("fill", "var(--muted)")
        .text(a);
    });

    [0.25, 0.5, 0.75, 1].forEach(k => {
      g.append("circle").attr("r", r*k).attr("fill","none").attr("stroke","rgba(231,246,239,0.15)");
    });

    const vals = [0.6, 0.45, 0.7, 0.5, 0.8];
    const line = d3.lineRadial().curve(d3.curveLinearClosed).radius(d => d * r).angle((d, i) => (i / n) * 2 * Math.PI);
    g.append("path").datum(vals).attr("d", line).attr("fill", "rgba(36,180,126,0.25)").attr("stroke", "var(--accent)");
  }

  /* API */
  function init({ svg, gRoot, projectionRef, modeRef }){
    svgRef = svg; gRootRef = gRoot;
    getProjection = projectionRef;
    getMode = modeRef;
    ensurePanel();
  }

  function open(d){
    ensurePanel();
    currentDatum = d;
    titleEl.textContent = d.venue || d.name || "Venue";
    // info
    const info = panel.querySelector(".v-country"); if (info) info.textContent = d.country ?? "—";
    const city = panel.querySelector(".v-city"); if (city) city.textContent = d.city ?? "—";
    const aka  = panel.querySelector(".v-aka");  if (aka)  aka.textContent  = d.names ?? "—";

    const rsvg = panel.querySelector('svg[data-role="radar"]');
    if (rsvg) drawRadar(rsvg);

    placeAtDatum(d);
    panel.style.display = "block";
    isOpen = true;
    window.dispatchEvent(new CustomEvent("venuewindow:open"));
  }

  function close(){
    if (!panel) return;
    isOpen = false;
    currentDatum = null;
    panel.style.display = "none";
    window.dispatchEvent(new CustomEvent("venuewindow:close"));
  }

  function reposition(){
    if (!isOpen || !currentDatum) return;
    placeAtDatum(currentDatum);
  }

  window.VenueWindow = { init, open, close, reposition, isOpen: () => isOpen };
})();
