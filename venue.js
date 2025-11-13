/* VenueWindow: lightweight anchored popup with radar placeholder */
(function () {
  let svgRef, gRootRef, getProjection, getMode;
  let panel, titleEl, badgeEl, contentEl;
  let isOpen = false;
  let currentDatum = null;
  // small in-memory cache to avoid re-running heavy DB queries for the same venue/year/format
  const _metricsCache = new Map();
  // debounce timer for yearrange slider updates
  let _yearDebounceTimer = null;
  // Worker for heavy aggregation
  let _venueWorker = null;
  let _workerReqId = 1;
  const _workerPending = new Map();

  function ensureWorker(){
    if (_venueWorker) return;
    try{
      _venueWorker = new Worker('venue-worker.js');
      _venueWorker.onmessage = (ev) => {
        const msg = ev.data || {};
        const id = msg.id;
        const p = _workerPending.get(id);
        if (!p) return;
        _workerPending.delete(id);
        if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
      };
      _venueWorker.onerror = (e) => {
        console.warn('venue worker error', e);
      };
    }catch(e){
      console.warn('Failed to create venue worker', e);
      _venueWorker = null;
    }
  }

  function workerAggregate(payload){
    return new Promise((resolve, reject) => {
      ensureWorker();
      if (!_venueWorker) return reject(new Error('No worker available'));
      const id = (_workerReqId++).toString();
      _workerPending.set(id, { resolve, reject });
      try{
        _venueWorker.postMessage(Object.assign({ id, action: 'aggregate' }, payload));
      }catch(e){ _workerPending.delete(id); reject(e); }
      // add a timeout to avoid hanging indefinitely
      setTimeout(() => {
        if (_workerPending.has(id)) {
          _workerPending.delete(id);
          reject(new Error('Worker timeout'));
        }
      }, 20000);
    });
  }

  function ensurePanel(){
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "venue-window";
    // ensure the panel is positioned and above the map/svg so left/top positioning works
    panel.style.position = 'fixed';
    panel.style.zIndex = 1305;
    panel.style.display = 'none';

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

  // developer diagnostics panel (hidden by default). Toggle with Shift+click on title.
  const diagPanel = document.createElement('pre');
  diagPanel.className = 'venue-diag';
  diagPanel.style.display = 'none';
  diagPanel.style.whiteSpace = 'pre-wrap';
  diagPanel.style.maxHeight = '180px';
  diagPanel.style.overflow = 'auto';
  diagPanel.style.margin = '8px 0';
  diagPanel.style.padding = '8px';
  diagPanel.style.background = 'rgba(0,0,0,0.06)';
  diagPanel.style.color = 'var(--muted)';
  diagPanel.textContent = '';

    badgeEl = document.createElement("span");
    badgeEl.className = "venue-badge";
    badgeEl.textContent = "2000–2025";

  left.appendChild(titleEl);
  left.appendChild(diagPanel);
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
    // make layout horizontal: radar on left, legend/filters on right
    contentEl.style.display = 'flex';
    contentEl.style.flexDirection = 'column';
    contentEl.style.gap = '12px';

  const topRow = document.createElement('div');
  topRow.style.display = 'flex';
  topRow.style.gap = '16px';
  topRow.style.alignItems = 'flex-start';

  const radarWrap = document.createElement("div");
  // make the radar area wider so the year slider below remains visible
  radarWrap.style.flex = '0 0 420px';
  radarWrap.style.position = 'relative';
  radarWrap.innerHTML = `<svg width="420" height="220" data-role="radar"></svg>`;

  const legend = document.createElement("div");
  legend.className = "venue-card venue-legend";
    // interactive legend will be populated/controlled by JS
    legend.innerHTML = `
      <div class="venue-legend-items" style="display:flex;flex-direction:column;gap:12px;align-items:flex-start;font-size:0.95rem;color:var(--text)"></div>
    `;

  topRow.appendChild(radarWrap);
  topRow.appendChild(legend);

  // Tab bar to switch between Radar and Evolution (multi-year heatmap)
  const tabBar = document.createElement('div');
  tabBar.className = 'venue-tabbar';
  tabBar.style.display = 'flex';
  tabBar.style.gap = '8px';
  tabBar.style.margin = '8px 0';

  const tabRadar = document.createElement('button');
  tabRadar.className = 'venue-tab';
  tabRadar.textContent = 'Radar';
  tabRadar.setAttribute('aria-pressed', 'true');
  tabRadar.style.padding = '6px 10px';
  tabBar.appendChild(tabRadar);
  // Evolution tab
  const tabEvo = document.createElement('button');
  tabEvo.className = 'venue-tab';
  tabEvo.textContent = 'Evolution';
  tabEvo.setAttribute('aria-pressed', 'false');
  tabEvo.style.padding = '6px 10px';
  tabBar.appendChild(tabEvo);

  // Trajectory container (hidden by default) — contains two charts: batting and bowling
  // Trajectory charts removed per user request. Only Radar and Evolution remain.

  // Evolution container (heatmap) hidden by default — includes format controls and legend
  const evoWrap = document.createElement('div');
  evoWrap.className = 'venue-evolution';
  evoWrap.style.display = 'none';
  evoWrap.style.marginTop = '8px';
  evoWrap.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font-weight:600;margin-bottom:6px">Evolution (year × metric)</div>
      <div class="evo-controls" style="display:flex;gap:8px;align-items:center">
        <div style="font-size:0.9rem;color:var(--muted);margin-right:6px">Format:</div>
        <button class="evo-fmt" data-format="all" aria-pressed="true" style="padding:4px 8px;border-radius:6px">All</button>
        <button class="evo-fmt" data-format="test" aria-pressed="false" style="padding:4px 8px;border-radius:6px">Test</button>
        <button class="evo-fmt" data-format="odi" aria-pressed="false" style="padding:4px 8px;border-radius:6px">ODI</button>
  <button class="evo-fmt" data-format="t20" aria-pressed="false" style="padding:4px 8px;border-radius:6px">T20I</button>
      </div>
    </div>
    <div class="evo-legend" style="margin:6px 0 8px;display:flex;gap:8px;flex-wrap:wrap"></div>
    <svg width="760" height="260" data-role="evo-heatmap"></svg>`;

  const heatWrap = document.createElement("div");
  heatWrap.className = "venue-card venue-heat";
  heatWrap.textContent = "Heatmap (coming soon)";

  const info = document.createElement("div");
  info.className = "venue-card venue-info";
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

    // make panel wider so the page's year slider below remains visible
    panel.style.width = '820px';
    panel.style.maxWidth = '92vw';

  contentEl.appendChild(tabBar);
  contentEl.appendChild(topRow);
  contentEl.appendChild(evoWrap);
    contentEl.appendChild(heatWrap);
    contentEl.appendChild(info);

    // prepare interactive legend items (format toggles)
    const FORMATS = [
      { key: 'test', label: 'Test', color: '#e6cf9a' },
      { key: 'odi',  label: 'ODI',  color: '#2dd4bf' },
      { key: 't20i', label: 'T20I', color: '#a78bfa' }
    ];
    const itemsWrap = legend.querySelector('.venue-legend-items');
    FORMATS.forEach(f => {
      const btn = document.createElement('button');
      btn.className = 'venue-legend-item';
      btn.setAttribute('data-format', f.key);
      btn.setAttribute('aria-pressed', 'true');
      btn.style.display = 'inline-flex';
      btn.style.alignItems = 'center';
      btn.style.gap = '8px';
      btn.style.background = 'transparent';
      btn.style.border = 'none';
      btn.style.color = 'var(--text)';
      btn.style.cursor = 'pointer';
      btn.innerHTML = `<i class="legend-dot" style="width:10px;height:10px;border-radius:50%;background:${f.color};display:inline-block;margin-right:6px;box-shadow:0 2px 6px ${f.color}33;"></i><span style="font-size:0.95rem;color:var(--text)">${f.label}</span>`;
      btn.addEventListener('click', (e) => {
        const fmt = btn.getAttribute('data-format');
        const pressed = btn.getAttribute('aria-pressed') === 'true';
        btn.setAttribute('aria-pressed', pressed ? 'false' : 'true');
        // toggle class on panel so CSS can dim the polygon for this format
        if (pressed) panel.classList.add(`fmt-hidden-${f.key}`); else panel.classList.remove(`fmt-hidden-${f.key}`);
        // also toggle the svg path opacity directly for immediate effect
        const svgEl = panel.querySelector('svg[data-role="radar"]');
        if (svgEl) {
          const paths = svgEl.querySelectorAll('.radar-poly-' + fmt);
          paths.forEach(p => { p.style.opacity = pressed ? '0.06' : '0.88'; });
        }
      });
      itemsWrap.appendChild(btn);
    });

      // Tab switching behavior
      tabRadar.addEventListener('click', () => {
        tabRadar.setAttribute('aria-pressed','true'); tabEvo.setAttribute('aria-pressed','false');
        radarWrap.style.display = 'block'; evoWrap.style.display = 'none';
        // show the radar format legend when Radar tab is active
        try { legend.classList.remove('hidden'); } catch(e){}
      });
      tabEvo.addEventListener('click', () => {
        tabRadar.setAttribute('aria-pressed','false'); tabEvo.setAttribute('aria-pressed','true');
        radarWrap.style.display = 'none'; evoWrap.style.display = 'block';
        // hide the radar-specific format legend when Evolution tab is active
        try { legend.classList.add('hidden'); } catch(e){}
      });

    panel.appendChild(header);
    // Toggle diag panel for developers
    titleEl.addEventListener('click', (e) => {
      if (e.shiftKey) {
        diagPanel.style.display = diagPanel.style.display === 'none' ? 'block' : 'none';
      }
    });
    panel.appendChild(contentEl);
    document.body.appendChild(panel);

    // keep open on its own clicks
    panel.addEventListener("pointerdown", e => e.stopPropagation());
    // outside click closes
    document.addEventListener("pointerdown", (e) => { if (isOpen && !panel.contains(e.target)) close(); });
    // ESC closes
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    // track current year range for queries and update badge
    let currentYearRange = { min: 2000, max: 2025 };
    // current format (shared between listeners)
    let currentFormat = (window.selectedFormat || 'all');

    window.addEventListener("yearrange:change", (ev) => {
      const { min, max } = ev.detail || {};
      if (Number.isFinite(min)) currentYearRange.min = min;
      if (Number.isFinite(max)) currentYearRange.max = max;
      badgeEl.textContent = `${currentYearRange.min}–${currentYearRange.max}`;
      // debounce rapid slider events to avoid repeated heavy DB queries
      if (isOpen && currentDatum) {
        // show immediate loading feedback while debouncing
        const radarWrapImmediate = panel.querySelector('div > svg[data-role="radar"]')?.parentNode || null;
        const loadingOverlayImmediate = radarWrapImmediate ? radarWrapImmediate.querySelector('.venue-loading') : null;
        if (loadingOverlayImmediate) loadingOverlayImmediate.style.display = 'flex';
        if (_yearDebounceTimer) clearTimeout(_yearDebounceTimer);
        _yearDebounceTimer = setTimeout(() => {
          fetchAndRender(currentDatum, currentYearRange, currentFormat);
        }, 260);
      }
    });

    // react to format filter changes (published by map.js)
    window.addEventListener('format:change', (ev) => {
      currentFormat = (ev?.detail?.format) || (window.selectedFormat || 'all');
      // if panel is open, refresh metrics
      if (isOpen && currentDatum) fetchAndRender(currentDatum, currentYearRange, currentFormat);
    });

    // Evolution format buttons: delegate clicks to re-render heatmap with selected format
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.evo-fmt');
      if (!btn) return;
      const fmt = btn.getAttribute('data-format');
      // update pressed state
      panel.querySelectorAll('.evo-fmt').forEach(b => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
      // re-render using stored rows if available
      try{
        const rows = panel._lastRows || [];
        const yr = panel._lastYrRange || currentYearRange;
        drawEvolutionHeatmap(rows, yr, fmt);
      }catch(e){ console.warn('Failed to re-render evolution heatmap for format', fmt, e); }
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
    // New radar renderer expects svgEl.dataset.metrics to contain a JSON string
    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    const w = +svg.attr("width") || 280;
    const h = +svg.attr("height") || 170;
    const cx = w/2, cy = h/2, r = Math.min(w, h)/2 - 22;
    const axes = ["Bat SR", "Bat Avg", "Boundary %", "Bowl Econ", "Bowl Avg", "Bowl SR"];
    const n = axes.length;
    const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);

    // draw concentric rings
    [0.25, 0.5, 0.75, 1].forEach(k => g.append("circle").attr("r", r*k).attr("fill", "none").attr("stroke", "rgba(231,246,239,0.12)"));

    // axis lines and labels
    axes.forEach((a, i) => {
      const ang = (i / n) * 2 * Math.PI - Math.PI/2;
      const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
      g.append("line").attr("x1",0).attr("y1",0).attr("x2",x).attr("y2",y).attr("stroke","rgba(231,246,239,0.2)");
      g.append("text")
        .attr("x", Math.cos(ang) * (r + 8))
        .attr("y", Math.sin(ang) * (r + 8) + 4)
        .attr("text-anchor", Math.cos(ang) > 0.1 ? "start" : (Math.cos(ang) < -0.1 ? "end" : "middle"))
        .attr("font-size", 11)
        .attr("fill", "var(--muted)")
        .text(a);
    });

    // metrics may be attached via svgEl._metrics or via dataset
    const metricsObj = svgEl._metrics || null;
    if (!metricsObj && svgEl.dataset && svgEl.dataset.metrics) {
      try { svgEl._metrics = JSON.parse(svgEl.dataset.metrics); } catch(e) { /* ignore */ }
    }
    const metricsByFormat = (svgEl._metrics && svgEl._metrics.byFormat) ? svgEl._metrics.byFormat : null;
    if (!metricsByFormat) {
      // placeholder polygon (semi-filled)
      const placeholder = d3.range(n).map(i => 0.6);
      const line = d3.lineRadial().curve(d3.curveLinearClosed).radius(d => d * r).angle((d, i) => (i / n) * 2 * Math.PI);
      g.append("path").datum(placeholder).attr("d", line).attr("fill", "rgba(36,180,126,0.18)").attr("stroke", "var(--accent)");
      return;
    }

    // Build unified axis domains from available per-format metrics so every radar
    // uses sensible, data-driven ranges. If data is missing, fall back to safe defaults.
    const collected = {
      bat_sr: [], bat_avg: [], boundary_pct: [], bowl_eco: [], bowl_avg: [], bowl_sr: []
    };
    let totalMatchesAcross = 0;
    Object.keys(metricsByFormat).forEach(k => {
      const m = metricsByFormat[k];
      if (!m) return;
      const mc = m.matches_count || 0;
      totalMatchesAcross += mc;
      if (m.batting_sr != null) collected.bat_sr.push({ v: +m.batting_sr, w: mc || 1 });
      if (m.batting_avg != null) collected.bat_avg.push({ v: +m.batting_avg, w: mc || 1 });
      if (m.boundary_pct != null) collected.boundary_pct.push({ v: +m.boundary_pct, w: mc || 1 });
      if (m.bowling_econ != null) collected.bowl_eco.push({ v: +m.bowling_econ, w: mc || 1 });
      if (m.bowling_avg != null) collected.bowl_avg.push({ v: +m.bowling_avg, w: mc || 1 });
      if (m.bowling_sr != null) collected.bowl_sr.push({ v: +m.bowling_sr, w: mc || 1 });
    });

    function computeDomain(arr, defLow, defHigh, invert) {
      if (!arr || !arr.length) return [defLow, defHigh];
      const vals = arr.map(x => x.v);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      // if min==max (single-value) expand a bit
      const pad = (max - min) === 0 ? Math.max(1, Math.abs(max) * 0.1) : (max - min) * 0.12;
      const low = Math.max(0, min - pad);
      const high = max + pad;
      // for inverted axes (lower is better) we want domain [high, low] so higher map to lower score
      return invert ? [high, low] : [low, high];
    }

    const domains = {
      bat_sr: computeDomain(collected.bat_sr, 60, 160, false),
      bat_avg: computeDomain(collected.bat_avg, 5, 60, false),
      boundary_pct: computeDomain(collected.boundary_pct, 0, 40, false),
      bowl_eco: computeDomain(collected.bowl_eco, 2, 8, true),
      bowl_avg: computeDomain(collected.bowl_avg, 10, 80, true),
      bowl_sr: computeDomain(collected.bowl_sr, 20, 120, true)
    };

    const scales = {
      bat_sr: d3.scaleLinear().domain(domains.bat_sr).clamp(true).range([0,1]),
      bat_avg: d3.scaleLinear().domain(domains.bat_avg).clamp(true).range([0,1]),
      boundary_pct: d3.scaleLinear().domain(domains.boundary_pct).clamp(true).range([0,1]),
      bowl_eco: d3.scaleLinear().domain(domains.bowl_eco).clamp(true).range([0,1]),
      bowl_avg: d3.scaleLinear().domain(domains.bowl_avg).clamp(true).range([0,1]),
      bowl_sr: d3.scaleLinear().domain(domains.bowl_sr).clamp(true).range([0,1])
    };
    const FORMATS = [
      { key: 'test', color: '#e6cf9a' },
      { key: 'odi',  color: '#2dd4bf' },
      { key: 't20i', color: '#a78bfa' }
    ];

    const line = d3.lineRadial().curve(d3.curveLinearClosed).radius(d => d * r).angle((d, i) => (i / n) * 2 * Math.PI);

    // draw one polygon per format (if metrics available and has matches)
    FORMATS.forEach(fmt => {
      const metrics = metricsByFormat[fmt.key];
      // skip formats with no metrics or zero matches — don't draw misleading polygons
      if (!metrics || !metrics.matches_count) return;
      const vals = [
        scales.bat_sr(metrics.batting_sr || 0),
        scales.bat_avg(metrics.batting_avg || 0),
        scales.boundary_pct(metrics.boundary_pct || 0),
        scales.bowl_eco(metrics.bowling_econ || 99),
        scales.bowl_avg(metrics.bowling_avg || 99),
        scales.bowl_sr(metrics.bowling_sr || 999)
      ];
      g.append('path')
        .datum(vals)
        .attr('d', line)
        .attr('class', `radar-poly radar-poly-${fmt.key}`)
        .attr('fill', fmt.color)
        .attr('stroke', fmt.color)
        .attr('fill-opacity', 0.12)
        .attr('stroke-opacity', 0.9)
        .style('opacity', 0.88)
        .style('pointer-events', 'none');
    });

    // compute aggregated labels so radars always show numeric stats even when single formats are missing
    function weightedAverage(arr) {
      if (!arr || !arr.length) return null;
      const totalW = arr.reduce((s, x) => s + (x.w || 1), 0);
      if (!totalW) return null;
      return arr.reduce((s, x) => s + (x.v * (x.w || 1)), 0) / totalW;
    }

    const combined = {
      batting_sr: weightedAverage(collected.bat_sr),
      batting_avg: weightedAverage(collected.bat_avg),
      boundary_pct: weightedAverage(collected.boundary_pct),
      bowling_econ: weightedAverage(collected.bowl_eco),
      bowling_avg: weightedAverage(collected.bowl_avg),
      bowling_sr: weightedAverage(collected.bowl_sr)
    };

    // If there are no matches across all formats, show a neutral placeholder and
    // render labels as em-dashes to avoid implying numeric data.
    if (totalMatchesAcross === 0) {
      const placeholder = d3.range(n).map(i => 0.35);
      const linePh = d3.lineRadial().curve(d3.curveLinearClosed).radius(d => d * r).angle((d, i) => (i / n) * 2 * Math.PI);
      g.append("path").datum(placeholder).attr("d", linePh).attr("fill", "rgba(120,120,120,0.06)")
        .attr("stroke", "rgba(120,120,120,0.24)");
      const dashLabels = ['—','—','—','—','—','—'];
      dashLabels.forEach((txt, i) => {
        const ang = (i / n) * 2 * Math.PI - Math.PI/2;
        g.append("text")
          .attr("x", Math.cos(ang) * (r * 0.6))
          .attr("y", Math.sin(ang) * (r * 0.6) + 4)
          .attr("font-size", 11)
          .attr("fill", "var(--muted)")
          .attr("text-anchor", "middle")
          .text(txt);
      });
      return;
    }

    const labels = [
      (combined.batting_sr != null) ? `${Math.round(combined.batting_sr)}` : '—',
      (combined.batting_avg != null) ? `${(combined.batting_avg).toFixed(1)}` : '—',
      (combined.boundary_pct != null) ? `${(combined.boundary_pct).toFixed(1)}%` : '—',
      (combined.bowling_econ != null) ? `${(combined.bowling_econ).toFixed(2)}` : '—',
      (combined.bowling_avg != null) ? `${(combined.bowling_avg).toFixed(1)}` : '—',
      (combined.bowling_sr != null) ? `${Math.round(combined.bowling_sr)}` : '—'
    ];
    labels.forEach((txt, i) => {
      const ang = (i / n) * 2 * Math.PI - Math.PI/2;
      g.append("text")
        .attr("x", Math.cos(ang) * (r * 0.6))
        .attr("y", Math.sin(ang) * (r * 0.6) + 4)
        .attr("font-size", 11)
        .attr("fill", "var(--muted)")
        .attr("text-anchor", "middle")
        .text(txt);
    });
  }

  // Trajectory charts (multi-line mini-charts) were removed by request.
  // If needed later, reintroduce a focused, tested implementation.

  // fetch aggregated metrics for a venue + year range + format and render radar + textual summaries
  async function fetchAndRender(datum, yrRange = {min:2000,max:2025}, format = 'all'){
    // normalize format aliases so modules use a consistent key for SQL filtering
    if (format === 't20i') format = 't20';
    const svgEl = panel.querySelector('svg[data-role="radar"]');
    if (!svgEl) return;
    const radarWrap = panel.querySelector('div > svg[data-role="radar"]')?.parentNode || null;
    const loadingOverlay = radarWrap ? radarWrap.querySelector('.venue-loading') : null;
    // show loading overlay
    if (loadingOverlay) loadingOverlay.style.display = 'flex';
    // build candidate name aliases from datum.names (semicolon-separated in CSV) and other fields
    const names = [];
    if (datum.venue) names.push(String(datum.venue));
    if (datum.name) names.push(String(datum.name));
    if (datum.names) {
      // venue CSV stores alternate names separated by `;` — split on semicolon only to avoid over-splitting names that contain commas
      const parts = String(datum.names).split(';').map(s => s.trim()).filter(Boolean);
      names.push(...parts);
    }
    // normalize aliases (lowercase, collapse whitespace)
    const aliases = Array.from(new Set(names.map(s => s.toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean)));
    // check cache key first (no diagnostics)
    const cacheKey = JSON.stringify({ id: datum.venue || datum.name || datum.venue_id || '', yr: yrRange, format });
    if (_metricsCache.has(cacheKey)) {
      const cached = _metricsCache.get(cacheKey);
      svgEl._metrics = cached;
      svgEl.dataset.metrics = JSON.stringify(cached);
      drawRadar(svgEl);
      // hide loading overlay
      if (loadingOverlay) loadingOverlay.style.display = 'none';
      return;
    }
    // fallback to country+city if no aliases
    if (!aliases.length && datum.country && datum.city) aliases.push((String(datum.city) + ' ' + String(datum.country)).toLowerCase());

    // prepare exact-match IN clause and LIKE fallback
  // NOTE: matches.csv defines the venue column as `venue_name` (and source CSVs vary), avoid referencing m.venue which doesn't exist
  const exactClause = aliases.length ? `LOWER(COALESCE(m.venue_name, '')) IN (${aliases.map(()=>'?').join(',')})` : null;
    const exactParams = aliases.slice();
  const likeClause = aliases.length ? aliases.map(_ => `LOWER(COALESCE(m.venue_name, '')) LIKE ?`).join(' OR ') : `LOWER(COALESCE(m.venue_name, '')) LIKE ?`;
    const likeParams = aliases.length ? aliases.map(p => `%${p}%`) : [`%${(datum.venue||datum.name||'').toLowerCase()}%`];
    // New simplified aggregation: query the `venue_stats` table directly and
    // compute per-format aggregates. This replaces the previous multi-table
    // SQL and worker-based approach.
    try {
      // Build SQL WHERE clause for venue name aliases using LIKE
      const whereParts = [];
      const params = [yrRange.min, yrRange.max];
      const aliasLikes = (aliases.length ? aliases.map(_ => `%${_}%`) : [`%${(datum.venue||datum.name||'').toLowerCase()}%`]);
      const likeExprs = aliasLikes.map(_ => `LOWER(venue_name) LIKE ?`).join(' OR ');
      // format filtering: if user requested a specific format, add a WHERE clause
      let formatFilter = '';
      if (format && format !== 'all') { formatFilter = ` AND LOWER(format) LIKE ?`; params.push(`%${format}%`); }

      const sql = `SELECT * FROM venue_stats WHERE CAST(year AS INT) BETWEEN ? AND ? AND (${likeExprs})${formatFilter}`;
      const sqlParams = [yrRange.min, yrRange.max, ...aliasLikes.map(x => x), ...(format && format !== 'all' ? [`%${format}%`] : [])];
      let rows = [];
      try {
        rows = DB.queryAll(sql, sqlParams) || [];
      } catch (e) {
        console.warn('venue_stats query failed', e);
        rows = [];
      }

      // If the pre-aggregated `venue_stats` table has no rows for this
      // venue/year range, fall back to joining per-innings tables to
      // `matches` on match_id and synthesize per-format aggregates so the
      // rest of the renderer (which expects rows) can operate unchanged.
      if ((!rows || rows.length === 0)) {
        try {
          const likeExpr = aliasLikes.map(_ => `LOWER(m.venue_name) LIKE ?`).join(' OR ');
          const paramsBase = [yrRange.min, yrRange.max, ...aliasLikes];

          // Batting aggregates per-format
          const batSql = `SELECT LOWER(COALESCE(m.format,'')) AS format,
            SUM(CAST(bi.runs AS INT)) AS runs,
            SUM(CAST(bi.balls AS INT)) AS balls,
            SUM(CAST(bi.fours AS INT)) AS fours,
            SUM(CAST(bi."6s" AS INT)) AS sixes,
            COUNT(DISTINCT m.match_id) AS matches,
            COUNT(*) AS innings_count,
            AVG(CAST(bi.runs AS REAL)) AS batting_avg,
            AVG(CASE WHEN CAST(bi.balls AS INT) > 0 THEN (CAST(bi.runs AS REAL)*100.0/CAST(bi.balls AS INT)) END) AS batting_sr,
            AVG(CAST(bi.boundary_pct AS REAL)) AS boundary_pct
          FROM batting_innings bi
          LEFT JOIN matches m ON bi.match_id = m.match_id
          WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${likeExpr})
          GROUP BY LOWER(COALESCE(m.format,''))`;

          const batRows = DB.queryAll(batSql, paramsBase) || [];

          // Batting innings-by-number (for radar tooltip/innings_by_no)
          const innSql = `SELECT LOWER(COALESCE(m.format,'')) AS format,
            COALESCE(CAST(bi.innings_no AS INT),0) AS innings_no,
            AVG(CAST(bi.runs AS INT)) AS avg_runs,
            COUNT(*) AS cnt
          FROM batting_innings bi
          LEFT JOIN matches m ON bi.match_id = m.match_id
          WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${likeExpr})
          GROUP BY LOWER(COALESCE(m.format,'')), innings_no
          ORDER BY LOWER(COALESCE(m.format,'')), innings_no`;

          const innRows = DB.queryAll(innSql, paramsBase) || [];

          // Bowling aggregates per-format
          const bowlSql = `SELECT LOWER(COALESCE(m.format,'')) AS format,
            AVG(CAST(bi.economy AS REAL)) AS bowling_econ,
            AVG(CAST(bi.bowling_average AS REAL)) AS bowling_avg,
            AVG(CAST(bi.bowling_strike_rate AS REAL)) AS bowling_sr,
            SUM(CAST(bi.wickets AS INT)) AS wickets,
            COUNT(DISTINCT m.match_id) AS matches,
            COUNT(*) AS innings_count
          FROM bowling_innings bi
          LEFT JOIN matches m ON bi.match_id = m.match_id
          WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${likeExpr})
          GROUP BY LOWER(COALESCE(m.format,''))`;

          const bowlRows = DB.queryAll(bowlSql, paramsBase) || [];

          // Organize results by format and synthesize rows similar to venue_stats
          const batMap = Object.create(null);
          batRows.forEach(r => { if (r && r.format) batMap[String(r.format).toLowerCase()] = r; });
          const bowlMap = Object.create(null);
          bowlRows.forEach(r => { if (r && r.format) bowlMap[String(r.format).toLowerCase()] = r; });
          const innMap = Object.create(null);
          innRows.forEach(r => { if (!r || !r.format) return; const k = String(r.format).toLowerCase(); innMap[k] = innMap[k] || []; innMap[k].push({ innings_no: r.innings_no, avg_runs: r.avg_runs, cnt: r.cnt }); });

          const allKeys = Array.from(new Set([].concat(Object.keys(batMap), Object.keys(bowlMap))));
          rows = allKeys.map(k => {
            const b = batMap[k] || {};
            const bo = bowlMap[k] || {};
            return {
              format: k,
              matches: Number(b.matches || bo.matches || 0),
              innings_count: Number(b.innings_count || bo.innings_count || 0),
              runs: Number(b.runs || 0),
              balls: Number(b.balls || 0),
              fours: Number(b.fours || 0),
              sixes: Number(b.sixes || 0),
              batting_avg: b.batting_avg != null ? Number(b.batting_avg) : null,
              batting_sr: b.batting_sr != null ? Number(b.batting_sr) : null,
              boundary_pct: b.boundary_pct != null ? Number(b.boundary_pct) : null,
              bowling_econ: bo.bowling_econ != null ? Number(bo.bowling_econ) : null,
              bowling_avg: bo.bowling_avg != null ? Number(bo.bowling_avg) : null,
              bowling_sr: bo.bowling_sr != null ? Number(bo.bowling_sr) : null
            };
          });
          // keep innings-by-no available for merging later
          try { panel._fallback_innings = innMap; } catch(e) { panel._fallback_innings = null; }
        } catch (fbErr) {
          console.warn('fallback per-innings aggregation failed', fbErr);
        }
      }

  // store last fetched rows so Evolution controls can re-render without re-query
  try { panel._lastRows = rows; panel._lastYrRange = yrRange; panel._lastFormat = format; } catch(e){}
  // Draw evolution heatmap from raw rows for the selected yrRange and format
  try { drawEvolutionHeatmap(rows, yrRange, format); } catch(e) { console.warn('evolution draw failed', e); }

      // Group rows by normalized format key and aggregate sums
      const byFormat = { test: null, odi: null, t20i: null };
      const normFormat = (s) => (String(s||'').toLowerCase().includes('test') ? 'test' : (String(s||'').toLowerCase().includes('odi') ? 'odi' : (String(s||'').toLowerCase().includes('t20') || String(s||'').toLowerCase().includes('twenty') ? 't20i' : 'other')));

      const groups = {};
      for (const r of rows) {
        const key = normFormat(r.format);
        if (key === 'other') continue; // ignore unknown formats
        if (!groups[key]) groups[key] = {
          runs:0, balls:0, wickets:0, fours:0, sixes:0, matches:0, innings_count:0,
          batting_sr_sum:0, batting_sr_w:0,
          batting_avg_sum:0, batting_avg_w:0,
          boundary_pct_sum:0, boundary_pct_w:0,
          bowling_econ_sum:0, bowling_econ_w:0,
          bowling_avg_sum:0, bowling_avg_w:0,
          bowling_sr_sum:0, bowling_sr_w:0
        };
        const g = groups[key];
        g.runs += Number(r.runs || 0);
        g.balls += Number(r.balls || 0);
        g.wickets += Number(r.wickets || 0);
        g.fours += Number(r.fours || 0);
        g.sixes += Number(r.sixes || 0);
        g.matches += Number(r.matches || 0);
        g.innings_count += Number(r.innings_count || 0);
        // weighted sums for precomputed per-year metrics (prefer weighting by matches)
        const w = Number(r.matches || 0) || 1;
        if (r.batting_sr != null) { g.batting_sr_sum += Number(r.batting_sr) * w; g.batting_sr_w += w; }
        if (r.batting_avg != null) { g.batting_avg_sum += Number(r.batting_avg) * w; g.batting_avg_w += w; }
        const bp = (r['boundary_%'] != null) ? Number(r['boundary_%']) : (r.boundary_pct != null ? Number(r.boundary_pct) : null);
        if (bp != null) { g.boundary_pct_sum += bp * w; g.boundary_pct_w += w; }
        if (r.bowling_econ != null) { g.bowling_econ_sum += Number(r.bowling_econ) * w; g.bowling_econ_w += w; }
        if (r.bowling_avg != null) { g.bowling_avg_sum += Number(r.bowling_avg) * w; g.bowling_avg_w += w; }
        if (r.bowling_sr != null) { g.bowling_sr_sum += Number(r.bowling_sr) * w; g.bowling_sr_w += w; }
      }

      ['test','odi','t20i'].forEach(fmt => {
        const g = groups[fmt];
        if (!g) { byFormat[fmt] = null; return; }
        // Use only the explicit metric columns from `venue_stats` (weighted by matches)
        const batting_sr = g.batting_sr_w ? (g.batting_sr_sum / g.batting_sr_w) : null;
        const batting_avg = g.batting_avg_w ? (g.batting_avg_sum / g.batting_avg_w) : null;
        const boundary_pct = g.boundary_pct_w ? (g.boundary_pct_sum / g.boundary_pct_w) : null;
        const bowling_econ = g.bowling_econ_w ? (g.bowling_econ_sum / g.bowling_econ_w) : null;
        const bowling_avg = g.bowling_avg_w ? (g.bowling_avg_sum / g.bowling_avg_w) : null;
        const bowling_sr = g.bowling_sr_w ? (g.bowling_sr_sum / g.bowling_sr_w) : null;
        byFormat[fmt] = {
          batting_sr: batting_sr != null ? +batting_sr : null,
          batting_avg: batting_avg != null ? +batting_avg : null,
          boundary_pct: boundary_pct != null ? +boundary_pct : null,
          bowling_econ: bowling_econ != null ? +bowling_econ : null,
          bowling_avg: bowling_avg != null ? +bowling_avg : null,
          bowling_sr: bowling_sr != null ? +bowling_sr : null,
          innings_by_no: [],
          matches_count: g.matches || 0,
          _raw_agg: g
        };
      });

      // If we synthesized per-innings aggregates from the fallback path,
      // merge innings-by-number into the byFormat objects so the radar
      // renderer / tooltips can use them.
      try {
        const fb = panel._fallback_innings || null;
        if (fb) {
          Object.keys(fb).forEach(k => {
            const norm = (k || '').toLowerCase().includes('test') ? 'test' : (k || '').toLowerCase().includes('odi') ? 'odi' : ((k || '').toLowerCase().includes('t20') ? 't20i' : null);
            if (!norm) return;
            if (byFormat[norm]) byFormat[norm].innings_by_no = (fb[k] || []).map(x => ({ innings_no: x.innings_no, avg_runs: Number(x.avg_runs || 0), count: Number(x.cnt || 0) }));
          });
        }
      } catch(e) { /* non-fatal */ }

      svgEl._metrics = { byFormat }; svgEl.dataset.metrics = JSON.stringify({ byFormat });
      try { const diag = panel.querySelector('.venue-diag'); if (diag) diag.textContent = JSON.stringify(svgEl._metrics, null, 2); } catch(e){}
      try { _metricsCache.set(JSON.stringify({ id: datum.venue || datum.name || datum.venue_id || '', yr: yrRange, format }), svgEl._metrics); } catch(e){}
      drawRadar(svgEl);
      // hide loading overlay if present
      if (loadingOverlay) loadingOverlay.style.display = 'none';

      // textual summary
      const heat = panel.querySelector('.venue-heat');
      if (heat) {
        const totalMatches = Object.values(byFormat).reduce((s, m) => s + (m && m.matches_count ? m.matches_count : 0), 0);
        heat.innerHTML = `<div style="font-size:.95rem;color:var(--text)"><div style="margin-bottom:6px"><strong>Total matches (selected years):</strong> ${totalMatches}</div></div>`;
        const list = document.createElement('div'); list.style.display = 'grid'; list.style.gap = '6px'; list.style.marginTop = '6px';
        const formatOrder = ['test','odi','t20i'];
        const colors = { test: '#e6cf9a', odi: '#2dd4bf', t20i: '#a78bfa' };
        formatOrder.forEach(k => {
          const m = byFormat[k];
          const row = document.createElement('div');
          row.style.display = 'flex'; row.style.justifyContent = 'space-between'; row.style.alignItems = 'center'; row.style.gap = '10px';
          row.innerHTML = `<div style="display:flex;align-items:center;gap:8px"><span style="width:10px;height:10px;border-radius:50%;background:${colors[k]}"></span><strong style="width:48px;text-transform:uppercase;color:var(--muted)">${k}</strong><span style="color:var(--muted)">Matches:</span></div><div style="text-align:right;color:var(--text)">${m && m.matches_count ? m.matches_count : '—'}</div>`;
          list.appendChild(row);
        });
        heat.appendChild(list);
      }
      return;
    } catch (e) {
      console.warn('fetchAndRender venue metrics failed', e);
      const heatErr = panel.querySelector('.venue-heat');
      if (heatErr) heatErr.innerHTML = `<div style="color:var(--muted);font-size:.92rem">No metrics available.</div>`;
      svgEl._metrics = null; drawRadar(svgEl);
      try { if (loadingOverlay) loadingOverlay.style.display = 'none'; } catch(_e){}
    }
  }

  // Draw evolution heatmap: rows = metrics, cols = years. Accepts optional format ('all','test','odi','t20i')
  function drawEvolutionHeatmap(rows, yrRange, format = 'all'){
    try{
      const svgEl = panel.querySelector('svg[data-role="evo-heatmap"]');
      if (!svgEl) return;
      const svg = d3.select(svgEl); svg.selectAll('*').remove();
      const w = +svg.attr('width') || 760; const h = +svg.attr('height') || 260;
      const margin = { top: 28, right: 12, bottom: 28, left: 120 };
      const iw = w - margin.left - margin.right; const ih = h - margin.top - margin.bottom;
      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      const minY = yrRange.min, maxY = yrRange.max;
      const years = d3.range(minY, maxY+1);
      const metrics = [
        { key: 'batting_sr', label: 'Bat SR' },
        { key: 'batting_avg', label: 'Bat Avg' },
        { key: 'boundary_%', label: 'Boundary %' },
        { key: 'bowling_econ', label: 'Bowl Econ' },
        { key: 'bowling_avg', label: 'Bowl Avg' },
        { key: 'bowling_sr', label: 'Bowl SR' },
        { key: 'matches', label: 'Matches' }
      ];

      // Filter rows by selected format (if requested)
      const usedRows = (format && format !== 'all') ? rows.filter(r => {
        const rf = String(r.format||'').toLowerCase();
        // accept both 't20' and 't20i' aliases
        if (format === 't20i' || format === 't20') return rf.includes('t20');
        return rf.includes(String(format||'').toLowerCase());
      }) : rows;

      // Build matrix values: metric x year aggregated (weighted by matches)
      const matrix = metrics.map(m => {
        return years.map(y => {
          const rs = (usedRows || []).filter(r => Number(r.year)===y);
          let num = 0, den = 0;
          for (const r of rs){
            const w = Number(r.matches||0) || 1;
            let v = null;
            if (m.key === 'matches') v = Number(r.matches||0);
            else {
              if (r[m.key] != null) v = Number(r[m.key]);
              else if (m.key === 'boundary_%' && r.boundary_pct != null) v = Number(r.boundary_pct);
            }
            if (v != null){ num += v * w; den += w; }
          }
          return den ? (num/den) : null;
        });
      });

      // diagnostic: expose rows count and per-metric non-null counts in diag panel
      try{
        const diag = panel.querySelector('.venue-diag');
        if (diag) {
          const meta = { rowsCount: (rows||[]).length, filteredRows: (usedRows||[]).length, years: years.length, metrics: metrics.map((m,i)=>({ key: m.key, nonNull: matrix[i].filter(v=>v!=null).length })) };
          diag.textContent = JSON.stringify(meta, null, 2);
        }
      }catch(e){}

      // For each metric compute color domain across years and assign a distinct palette per metric
      const METRIC_PALETTES = {
        'batting_sr': d3.interpolateRdYlBu,
        'batting_avg': d3.interpolateBuPu,
        'boundary_%': d3.interpolateYlGn,
        'bowling_econ': d3.interpolatePuBuGn,
        'bowling_avg': d3.interpolateYlOrRd,
        'bowling_sr': d3.interpolateViridis,
        'matches': d3.interpolateGreys
      };
      const colorScales = metrics.map((m,i) => {
        const vals = matrix[i].filter(v => v != null);
        if (!vals.length) return null;
        const minv = d3.min(vals), maxv = d3.max(vals);
        const interp = METRIC_PALETTES[m.key] || d3.interpolateYlGnBu;
        return d3.scaleSequential(interp).domain([minv, maxv]);
      });

      // Populate HTML legend (per-metric gradients + min/max). Uses the .evo-legend container.
      try{
        const legendEl = panel.querySelector('.evo-legend');
        if (legendEl) {
          legendEl.innerHTML = '';
          metrics.forEach((m, i) => {
            const item = document.createElement('div');
            item.className = 'evo-legend-item';
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.gap = '8px';
            item.style.fontSize = '0.85rem';
            // color box
            const box = document.createElement('div');
            box.style.width = '120px'; box.style.height = '12px'; box.style.borderRadius = '4px';
            box.style.border = '1px solid rgba(0,0,0,0.06)';
            if (colorScales[i]){
              const dom = colorScales[i].domain();
              const start = colorScales[i](dom[0]);
              const end = colorScales[i](dom[1]);
              box.style.background = `linear-gradient(to right, ${start}, ${end})`;
            } else {
              box.style.background = '#efefef';
            }
            const lbl = document.createElement('div');
            lbl.style.display = 'flex'; lbl.style.flexDirection = 'column'; lbl.style.justifyContent = 'center';
            const title = document.createElement('div'); title.textContent = m.label; title.style.color = 'var(--muted)'; title.style.fontSize = '0.85rem';
            const scaleTxt = document.createElement('div'); scaleTxt.style.color = 'var(--muted)'; scaleTxt.style.fontSize = '0.78rem';
            if (colorScales[i]){ const dom = colorScales[i].domain(); scaleTxt.textContent = `${Math.round(dom[0]*100)/100} → ${Math.round(dom[1]*100)/100}`; } else { scaleTxt.textContent = 'no data'; }
            lbl.appendChild(title); lbl.appendChild(scaleTxt);
            item.appendChild(box); item.appendChild(lbl);
            legendEl.appendChild(item);
          });
        }
      }catch(e){ /* non-fatal */ }

      // cell sizes
      const cellW = Math.max(12, Math.floor(iw / Math.max(1, years.length)));
      const cellH = Math.max(18, Math.floor(ih / metrics.length));

      // draw grid
      const rowsG = g.append('g').attr('class','heat-rows');
      metrics.forEach((m, ri) => {
        const y = ri * cellH;
        // metric label
        g.append('text').attr('x', -10).attr('y', y + cellH/2 + 4).attr('text-anchor','end').attr('font-size',11).attr('fill','var(--muted)').text(m.label);
        const rowVals = matrix[ri];
        rowVals.forEach((v, ci) => {
          const x = ci * cellW;
          const cell = g.append('rect').attr('x', x).attr('y', y).attr('width', cellW-1).attr('height', cellH-2).attr('rx',2).attr('ry',2)
            .style('stroke','rgba(0,0,0,0.06)').style('stroke-width',0.5)
            .style('fill', v==null ? '#efefef' : (colorScales[ri] ? colorScales[ri](v) : '#ddd'));
          // tooltip
          if (v != null){
            cell.on('mouseenter', (ev) => {
              const tip = document.createElement('div');
              tip.className = 'venue-heat-tip';
              tip.style.position = 'fixed'; tip.style.zIndex = 2000; tip.style.background='rgba(0,0,0,0.8)'; tip.style.color='white'; tip.style.padding='6px 8px'; tip.style.borderRadius='6px';
              tip.style.fontSize='0.9rem';
              tip.textContent = `${m.label} ${years[ci]}: ${typeof v==='number' ? (Math.round((v+Number.EPSILON)*100)/100) : v}`;
              document.body.appendChild(tip);
              const rect = ev.target.getBoundingClientRect();
              tip.style.left = `${rect.right + 8}px`; tip.style.top = `${rect.top}px`;
              cell.on('mouseleave', () => { try{ tip.remove(); }catch(e){} });
            });
          }
        });
      });

      // year labels on top
      const yearsG = g.append('g').attr('transform', `translate(0,${-6})`);
      years.forEach((y, i) => {
        const x = i * cellW + cellW/2;
        yearsG.append('text').attr('x', x).attr('y', -2).attr('font-size',10).attr('text-anchor','middle').attr('fill','var(--muted)').text(y);
      });

      // Removed bottom SVG legend: per-metric HTML legends are shown above the heatmap
    }catch(e){ console.warn('drawEvolutionHeatmap failed', e); }
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
    // center & show the panel immediately so the UI is responsive. Dispatch the
    // global `venuewindow:open` event before kicking off the potentially long
    // fetch to ensure map-level transient loaders hide promptly.
    try {
      panel.style.left = '50%';
      panel.style.top = '50%';
      panel.style.transform = 'translate(-50%, -50%)';
      panel.style.display = "block";
      // show blue backdrop (but keep year slider interactive above it)
      const backdropEl = document.getElementById('backdrop');
      if (backdropEl) {
        backdropEl.hidden = false;
        // small timeout to allow CSS transition
        setTimeout(() => backdropEl.classList.add('open','venue-blue'), 10);
      }
      // indicate panel is centered so reposition won't attempt to anchor to map
      panel.dataset.centered = 'true';
      isOpen = true;
      // dispatch open event early so global transient loader (map-level) hides
      // even if subsequent data fetching faults or takes long.
      window.dispatchEvent(new CustomEvent("venuewindow:open"));
      // Ensure Radar tab is active and visible when the panel opens.
      try {
        // Radar button is the first .venue-tab by construction
        const tabRadarBtn = panel.querySelector('.venue-tab');
        const tabBtns = Array.from(panel.querySelectorAll('.venue-tab'));
        const tabEvoBtn = tabBtns.find(b => (b.textContent||'').trim().toLowerCase() === 'evolution');
        if (tabRadarBtn) tabRadarBtn.setAttribute('aria-pressed', 'true');
        if (tabEvoBtn) tabEvoBtn.setAttribute('aria-pressed', 'false');
        // Show radar container, hide evolution container and reveal legend
        const radarWrapEl = panel.querySelector('div > svg[data-role="radar"]')?.parentNode || null;
        const evoWrapEl = panel.querySelector('.venue-evolution');
        const legendEl = panel.querySelector('.venue-legend');
        if (radarWrapEl) radarWrapEl.style.display = 'block';
        if (evoWrapEl) evoWrapEl.style.display = 'none';
        try { if (legendEl) legendEl.classList.remove('hidden'); } catch(_){}
      } catch (e) { /* non-fatal */ }
    } catch (e) {
      console.warn('VenueWindow.open: UI show failed', e);
    }

    if (rsvg) {
      // parse year badge for current range
      let yr = badgeEl?.textContent || "2000–2025";
      let min = 2000, max = 2025;
      try{
        const m = yr.match(/(\d{4})\s*[–-]\s*(\d{4})/);
        if (m) { min = +m[1]; max = +m[2]; }
      }catch(e){}
      const fmt = window.selectedFormat || 'all';
      // fetch DB metrics and render radar
      // show immediate per-panel loading overlay while fetching
      const radarWrap = panel.querySelector('div > svg[data-role="radar"]')?.parentNode || null;
      const loadingOverlay = radarWrap ? radarWrap.querySelector('.venue-loading') : null;
      if (loadingOverlay) loadingOverlay.style.display = 'flex';

      // Run fetchAndRender asynchronously; ensure we always hide the per-panel
      // overlay and log any error so the UI doesn't remain in a loading state.
      (async () => {
        try {
          await fetchAndRender(d, { min, max }, fmt);
        } catch (err) {
          console.warn('fetchAndRender failed in VenueWindow.open', err);
        } finally {
          try { if (loadingOverlay) loadingOverlay.style.display = 'none'; } catch(e){}
        }
      })();
    }
  }

  function close(){
    if (!panel) return;
    isOpen = false;
    currentDatum = null;
    // ensure any visible loading overlay is hidden when closing
    try {
      const radarWrap = panel.querySelector('div > svg[data-role="radar"]')?.parentNode || null;
      const loadingOverlay = radarWrap ? radarWrap.querySelector('.venue-loading') : null;
      if (loadingOverlay) loadingOverlay.style.display = 'none';
    } catch(e){}
    // hide blue backdrop gracefully
    const backdropEl = document.getElementById('backdrop');
    if (backdropEl) {
      backdropEl.classList.remove('open','venue-blue');
      // hide after transition
      setTimeout(() => { backdropEl.hidden = true; }, 180);
    }
    panel.style.display = "none";
    panel.style.transform = '';
    delete panel.dataset.centered;
    window.dispatchEvent(new CustomEvent("venuewindow:close"));
  }

  function reposition(){
    if (!isOpen || !currentDatum) return;
    // if the panel was centered for focused view, keep it centered
    if (panel && panel.dataset && panel.dataset.centered === 'true') return;
    placeAtDatum(currentDatum);
  }

  window.VenueWindow = { init, open, close, reposition, isOpen: () => isOpen };
})();
