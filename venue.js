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

  const loadingOverlay = document.createElement('div');
  loadingOverlay.className = 'venue-loading';
  loadingOverlay.style.position = 'absolute';
  loadingOverlay.style.left = '0';
  loadingOverlay.style.top = '0';
  loadingOverlay.style.right = '0';
  loadingOverlay.style.bottom = '0';
  loadingOverlay.style.display = 'none';
  loadingOverlay.style.alignItems = 'center';
  loadingOverlay.style.justifyContent = 'center';
  loadingOverlay.style.background = 'rgba(0,0,0,0.28)';
  loadingOverlay.style.color = 'white';
  loadingOverlay.style.fontSize = '0.95rem';
  loadingOverlay.style.borderRadius = '6px';
  loadingOverlay.textContent = 'Loading venue details...';
  radarWrap.appendChild(loadingOverlay);

  const legend = document.createElement("div");
  legend.className = "venue-card venue-legend";
    // make legend sit to the right, allow it to grow
    legend.style.flex = '1 1 240px';
    legend.style.minWidth = '220px';
    legend.style.minHeight = "48px";
    // interactive legend will be populated/controlled by JS
    legend.innerHTML = `
      <div class="venue-legend-items" style="display:flex;flex-direction:column;gap:12px;align-items:flex-start;font-size:0.95rem;color:var(--text)"></div>
    `;

  topRow.appendChild(radarWrap);
  topRow.appendChild(legend);

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

    contentEl.appendChild(topRow);
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

  // fetch aggregated metrics for a venue + year range + format and render radar + textual summaries
  async function fetchAndRender(datum, yrRange = {min:2000,max:2025}, format = 'all'){
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
    // try to offload aggregation to worker first (faster UI, avoids main-thread jank)
    try {
      ensureWorker();
      if (_venueWorker) {
        const wres = await workerAggregate({ aliases, yrRange, format });
        if (wres && wres.byFormat) {
          const byFormat = wres.byFormat;
          svgEl._metrics = { byFormat }; svgEl.dataset.metrics = JSON.stringify({ byFormat });
          // populate hidden developer diagnostics panel (toggle with Shift+click on title)
          try {
            const diag = panel.querySelector('.venue-diag');
            if (diag) diag.textContent = JSON.stringify(svgEl._metrics, null, 2);
          } catch (e) { /* ignore */ }
          try { _metricsCache.set(JSON.stringify({ id: datum.venue || datum.name || datum.venue_id || '', yr: yrRange, format }), svgEl._metrics); } catch(e) {}
          drawRadar(svgEl);
          // hide loading overlay
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
        }
      }
    } catch (we) {
      // worker failed — fallback to local aggregation
      console.warn('venue worker aggregation failed, falling back to main thread:', we && we.message ? we.message : we);
    }
    // we'll try exact first, then LIKE fallback
    let usedMatchStrategy = 'none';

    // format filter
  // top-level format filter (used in contexts that reference matches directly)
  const fmtCond = (format && format !== 'all') ? `AND LOWER(COALESCE(m.format, '')) LIKE ?` : '';
    const fmtParam = (format && format !== 'all') ? [`%${format}%`] : [];

    // We'll compute metrics per-format (Test, ODI, T20I) and render three polygons. No debug details shown.
    try {
      const FORMATS = [
        { key: 'test', label: 'Test' },
        { key: 'odi', label: 'ODI' },
        { key: 't20i', label: 'T20I' }
      ];
  const byFormat = {};

      // helper to compute metrics for a single format
      const formatPatterns = (fmtKey) => {
        // return an array of lowercase LIKE patterns that match common ways the format appears
        if (fmtKey === 'test') return ['%test%'];
        if (fmtKey === 'odi') return ['%odi%', '%one%day%', '%one-day%', '%one day%'];
        // accept multiple variants for T20 (T20, T20I, Twenty20, t20)
        if (fmtKey === 't20i') return ['%t20i%', '%t20%', '%twenty%', '%twenty20%'];
        return [`%${fmtKey}%`];
      };

      // Check whether the innings tables actually have a `format` column in the runtime DB.
      // Some DB builds may omit the column for certain tables; using PRAGMA lets us detect that
      // and avoid SQL that references non-existent columns.
      function tableHasColumn(tableName, colName) {
        try {
          const rows = DB.queryAll(`PRAGMA table_info(${tableName})`);
          return rows.some(r => String(r.name).toLowerCase() === String(colName).toLowerCase());
        } catch (e) {
          console.warn('tableHasColumn failed', tableName, colName, e);
          return false;
        }
      }
  const battingHasFormat = tableHasColumn('batting_innings', 'format');
  const bowlingHasFormat = tableHasColumn('bowling_innings', 'format');

      const computeForFormat = (fmtKey) => {
        const pf = formatPatterns(fmtKey);
        const fmtParams_local = pf.slice();
        // build three different format-expressions depending on context:
        // - when querying an innings table aliased as `bi`, prefer bi.format when available
        // - when querying matches alone, only reference m.format
        const battingFmtClause = pf.map(_ => battingHasFormat ? `LOWER(COALESCE(bi.format, m.format, '')) LIKE ?` : `LOWER(COALESCE(m.format, '')) LIKE ?`).join(' OR ');
        const bowlingFmtClause = pf.map(_ => bowlingHasFormat ? `LOWER(COALESCE(bi.format, m.format, '')) LIKE ?` : `LOWER(COALESCE(m.format, '')) LIKE ?`).join(' OR ');
        const matchFmtClause = pf.map(_ => `LOWER(COALESCE(m.format, '')) LIKE ?`).join(' OR ');

        // batting
        let batRows = [];
        let used = 'none';
        if (exactClause) {
          const batExactSQL = `SELECT SUM(CAST(bi.runs AS INT)) AS runs, SUM(CAST(bi.balls AS INT)) AS balls, SUM(CASE WHEN COALESCE(bi.out,'')<>'' THEN 1 ELSE 0 END) AS dismissals, AVG(CAST(bi.boundary_pct AS REAL)) AS boundary_pct FROM batting_innings bi LEFT JOIN matches m ON bi.match_id = m.match_id WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${exactClause}) AND (${battingFmtClause})`;
          const batExactParams = [yrRange.min, yrRange.max, ...exactParams, ...fmtParams_local];
          batRows = DB.queryAll(batExactSQL, batExactParams) || [];
          if (batRows && batRows.length && (batRows[0].runs || batRows[0].balls || batRows[0].dismissals)) used = 'exact';
        }
        if (used !== 'exact') {
          const batLikeSQL = `SELECT SUM(CAST(bi.runs AS INT)) AS runs, SUM(CAST(bi.balls AS INT)) AS balls, SUM(CASE WHEN COALESCE(bi.out,'')<>'' THEN 1 ELSE 0 END) AS dismissals, AVG(CAST(bi.boundary_pct AS REAL)) AS boundary_pct FROM batting_innings bi LEFT JOIN matches m ON bi.match_id = m.match_id WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${likeClause}) AND (${battingFmtClause})`;
          const batLikeParams = [yrRange.min, yrRange.max, ...likeParams, ...fmtParams_local];
          batRows = DB.queryAll(batLikeSQL, batLikeParams) || [];
          used = used || 'like';
        }
        const bat = (batRows && batRows[0]) || {};

        // innings
        let innRows = [];
        if (used === 'exact') {
          const innExactSQL = `SELECT COALESCE(CAST(bi.innings_no AS INT),0) AS innings_no, AVG(CAST(bi.runs AS INT)) AS avg_runs, COUNT(*) AS cnt FROM batting_innings bi LEFT JOIN matches m ON bi.match_id = m.match_id WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${exactClause}) AND (${battingFmtClause}) GROUP BY innings_no ORDER BY innings_no`;
          const innExactParams = [yrRange.min, yrRange.max, ...exactParams, ...fmtParams_local];
          innRows = DB.queryAll(innExactSQL, innExactParams) || [];
        } else {
          const innLikeSQL = `SELECT COALESCE(CAST(bi.innings_no AS INT),0) AS innings_no, AVG(CAST(bi.runs AS INT)) AS avg_runs, COUNT(*) AS cnt FROM batting_innings bi LEFT JOIN matches m ON bi.match_id = m.match_id WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${likeClause}) AND (${battingFmtClause}) GROUP BY innings_no ORDER BY innings_no`;
          const innLikeParams = [yrRange.min, yrRange.max, ...likeParams, ...fmtParams_local];
          innRows = DB.queryAll(innLikeSQL, innLikeParams) || [];
        }

        // bowling
        let bowlRows = [];
        if (used === 'exact') {
          const bowlExactSQL = `SELECT SUM(CAST(bi.runs_conceded AS INT)) AS runs_conceded, SUM(CAST(bi.legal_balls AS INT)) AS balls, SUM(CAST(bi.wickets AS INT)) AS wickets FROM bowling_innings bi LEFT JOIN matches m ON bi.match_id = m.match_id WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${exactClause}) AND (${bowlingFmtClause})`;
          const bowlExactParams = [yrRange.min, yrRange.max, ...exactParams, ...fmtParams_local];
          bowlRows = DB.queryAll(bowlExactSQL, bowlExactParams) || [];
        } else {
          const bowlLikeSQL = `SELECT SUM(CAST(bi.runs_conceded AS INT)) AS runs_conceded, SUM(CAST(bi.legal_balls AS INT)) AS balls, SUM(CAST(bi.wickets AS INT)) AS wickets FROM bowling_innings bi LEFT JOIN matches m ON bi.match_id = m.match_id WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${likeClause}) AND (${bowlingFmtClause})`;
          const bowlLikeParams = [yrRange.min, yrRange.max, ...likeParams, ...fmtParams_local];
          bowlRows = DB.queryAll(bowlLikeSQL, bowlLikeParams) || [];
        }
  const bowl = (bowlRows && bowlRows[0]) || {};

        // matches for batting-first calc
        let matches = [];
        if (used === 'exact') {
          const matchExactSQL = `SELECT m.match_id, m.team1, m.team2, m.toss_winner, m.toss_decision, m.winner, COALESCE(m.result_type, '') AS result_type FROM matches m WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${exactClause}) AND (${matchFmtClause})`;
          const matchExactParams = [yrRange.min, yrRange.max, ...exactParams, ...fmtParams_local];
          matches = DB.queryAll(matchExactSQL, matchExactParams) || [];
        } else {
          const matchLikeSQL = `SELECT m.match_id, m.team1, m.team2, m.toss_winner, m.toss_decision, m.winner, COALESCE(m.result_type, '') AS result_type FROM matches m WHERE CAST(substr(m.date,1,4) AS INT) BETWEEN ? AND ? AND (${likeClause}) AND (${matchFmtClause})`;
          const matchLikeParams = [yrRange.min, yrRange.max, ...likeParams, ...fmtParams_local];
          matches = DB.queryAll(matchLikeSQL, matchLikeParams) || [];
        }

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

        // (diagnostics removed)

        // derived metrics
        const batting_sr = (bat && bat.balls) ? (100 * (bat.runs / bat.balls)) : null;
        // when dismissals are unavailable, fall back to runs / total_innings (sum of counts),
        // not the number of distinct innings_no rows (which was previously used and inflated averages)
        const totalInningsCount = (innRows && innRows.length) ? innRows.reduce((s, r) => s + (r.cnt || 0), 0) : 0;
        const batting_avg = (bat && bat.dismissals)
          ? (bat.runs / bat.dismissals)
          : (bat && bat.runs ? (bat.runs / Math.max(1, totalInningsCount || 1)) : null);
        // boundary_pct in the source CSV is stored as a fraction (e.g. 0.04 for 4%), convert to percent
        const boundary_pct = (bat && bat.boundary_pct != null) ? (+bat.boundary_pct * 100) : null;
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
          batting_first_win_pct: battingFirstPct,
          // include raw query aggregates and the matching strategy used to aid debugging
          _raw_batting: bat || {},
          _raw_bowling: bowl || {},
          _used_match_strategy: used
        };
      };

      // compute for each format (sequentially to avoid DB stress)
      for (const f of FORMATS) {
        try {
          byFormat[f.key] = computeForFormat(f.key);
        } catch (err) {
          byFormat[f.key] = null;
          console.warn('computeForFormat failed for', f.key, err);
        }
      }

      // attach metrics and render
      svgEl._metrics = { byFormat }; svgEl.dataset.metrics = JSON.stringify({ byFormat });
      // populate hidden developer diagnostics panel (toggle with Shift+click on title)
      try {
        const diag = panel.querySelector('.venue-diag');
        if (diag) diag.textContent = JSON.stringify(svgEl._metrics, null, 2);
      } catch (e) { /* ignore */ }
  // store in cache (small LRU not implemented; clear if too large)
  try { _metricsCache.set(JSON.stringify({ id: datum.venue || datum.name || datum.venue_id || '', yr: yrRange, format }), svgEl._metrics); } catch(e) {}
      drawRadar(svgEl);
  // hide loading overlay
  if (loadingOverlay) loadingOverlay.style.display = 'none';

      // textual summary: overall counts + per-format mini rows
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
        // diagnostics removed
      }

    } catch(e) {
      console.warn('fetchAndRender venue metrics failed', e);
      const heatErr = panel.querySelector('.venue-heat');
      if (heatErr) heatErr.innerHTML = `<div style="color:var(--muted);font-size:.92rem">No metrics available.</div>`;
      svgEl._metrics = null; drawRadar(svgEl);
    }
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
      // show immediate loading overlay while fetching
      const radarWrap = panel.querySelector('div > svg[data-role="radar"]')?.parentNode || null;
      const loadingOverlay = radarWrap ? radarWrap.querySelector('.venue-loading') : null;
      if (loadingOverlay) loadingOverlay.style.display = 'flex';
      fetchAndRender(d, { min, max }, fmt).finally(() => { if (loadingOverlay) loadingOverlay.style.display = 'none'; });
    }

    // center the panel on screen for focused venue view
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
    window.dispatchEvent(new CustomEvent("venuewindow:open"));
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
